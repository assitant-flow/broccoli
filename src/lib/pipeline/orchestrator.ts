import { db } from "@/db";
import {
  taskRuns,
  taskStages,
  subtasks,
  acceptanceCriteria,
  stageArtifacts,
  stageLogs,
  containerLeases,
  sessionSnapshots,
  memoryProposals,
  memoryItems,
  memoryInjections,
  issues,
  runMessages,
  requirements,
  requirementBatches,
  projects,
  pullRequests,
  usageRecords,
  auditLogs,
} from "@/db/schema";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { env, STAGE_TYPES, type StageType } from "@/lib/env";
import { getEngine } from "@/lib/engine";
import type { StageContext, StageOutput } from "@/lib/engine/types";
import { StageFailure } from "@/lib/engine/types";
import { ensureProjectRepos, workPath, checkoutBranchFrom, pushBranch, diffStat, readRepoFile, checkoutExisting, mergeBranch, branchExistsOnOrigin, type GitOriginOpts } from "@/lib/git";
import { resolveGithubToken, createPullRequest, mergePullRequest, closePullRequest, closeIssue } from "@/lib/github";
import { resolveStageModels, type StageModel } from "@/lib/models";
import { notify } from "@/lib/notify";
import { slugify } from "@/lib/engine/types";
import { getSandbox } from "@/lib/sandbox";

/** github origin 的 git 鉴权参数（token 解析：平台 env → 用户 PAT；design §12 窗口注入） */
async function originOpts(project: typeof projects.$inferSelect): Promise<GitOriginOpts> {
  if (project.originKind !== "github") return {};
  const token = await resolveGithubToken(project.userId);
  if (!token) throw new Error("github origin 需要 GITHUB_TOKEN（平台）或用户已存入 GitHub PAT");
  return { remoteUrl: `https://github.com/${project.repoFullName}.git`, token };
}

/* ============ 运行时内存态（跨 tick / SSE） ============ */

declare global {
  // eslint-disable-next-line no-var
  var __broccoliInflight: Map<string, Promise<void>>;
  // eslint-disable-next-line no-var
  var __broccoliLogBus: Map<string, Set<(line: unknown) => void>>;
}
const inflight = (globalThis.__broccoliInflight ??= new Map<string, Promise<void>>());
const logBus = (globalThis.__broccoliLogBus ??= new Map<string, Set<(line: unknown) => void>>());

export function subscribeLogs(runId: string, cb: (line: unknown) => void): () => void {
  const set = logBus.get(runId) ?? new Set();
  set.add(cb);
  logBus.set(runId, set);
  return () => set.delete(cb);
}

async function logLine(runId: string, stageId: string | null, level: string, line: string) {
  await db.insert(stageLogs).values({ runId, stageId: stageId ?? null, level, line });
  const payload = { ts: new Date().toISOString(), stageId, level, line };
  logBus.get(runId)?.forEach((cb) => {
    try {
      cb(payload);
    } catch {
      /* ignore */
    }
  });
}

const TERMINAL_RUN = ["completed", "failed", "cancelled", "suspended"];
const TERMINAL_STAGE = ["completed", "failed", "skipped"];

async function releaseLease(runId: string, reason: string) {
  await db
    .update(containerLeases)
    .set({ state: "released", releasedAt: new Date(), reason })
    .where(and(eq(containerLeases.runId, runId), ne(containerLeases.state, "released")));
  // docker 沙箱：队列空闲/终态即释放容器（FR-H3 空闲回收）
  try {
    const [run] = await db.select({ projectId: taskRuns.projectId }).from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
    if (run) {
      const sbx = await getSandbox();
      await sbx.release(run.projectId);
    }
  } catch {
    /* local 模式无容器 */
  }
}

async function acquireLease(run: { id: string; projectId: string; userId: string }): Promise<boolean> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(containerLeases)
    .where(and(eq(containerLeases.userId, run.userId), ne(containerLeases.state, "released")));
  if (count >= env.maxConcurrency) return false;
  await db.insert(containerLeases).values({ projectId: run.projectId, userId: run.userId, runId: run.id, state: "active", reason: "run-execution" });
  return true;
}

/* ============ TaskRun 创建（提交/重试时，FR-C1） ============ */

export async function createRunForRequirement(requirementId: string, projectId: string): Promise<string> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskRuns)
    .where(eq(taskRuns.requirementId, requirementId));
  const [run] = await db
    .insert(taskRuns)
    .values({ requirementId, projectId, attemptNo: count + 1, state: "queued" })
    .returning();
  await db.update(requirements).set({ latestRunId: run.id, status: "queued" }).where(eq(requirements.id, requirementId));
  return run.id;
}

/* ============ 启动排队中的 run（调度器调用） ============ */

export async function startQueuedRuns(): Promise<number> {
  const queued = await db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.state, "queued"))
    .orderBy(asc(taskRuns.createdAt))
    .limit(10);
  let started = 0;

  for (const run of queued) {
    const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
    if (!requirement) continue;
    const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
    if (!project) continue;

    // 项目内串行：存在活跃 run 则不启动（AC-D2）
    const [{ count: activeCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(taskRuns)
      .where(and(eq(taskRuns.projectId, project.id), inArray(taskRuns.state, ["preparing", "running", "wait_confirm"])));
    if (activeCount > 0) continue;

    // 失败策略 pause：队列中存在更早的失败需求且未解决 → 阻塞（FR-D6）。
    // 挂起（suspended）不阻塞：设计上挂起即「队列继续后续任务」（AC-D5）
    if (project.failurePolicy === "pause") {
      const [{ count: blocked }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(requirements)
        .where(
          and(
            eq(requirements.projectId, project.id),
            eq(requirements.status, "failed"),
            sql`${requirements.seq} < ${requirement.seq}`,
          ),
        );
      if (blocked > 0) continue;
    }

    // 依赖图（v2α）：依赖未完成 → 保持排队；依赖失败/跳过/取消 → 级联跳过（FR-D6 语义扩展）
    if (requirement.dependsOnSeq) {
      const [dep] = await db
        .select()
        .from(requirements)
        .where(and(eq(requirements.projectId, project.id), eq(requirements.seq, requirement.dependsOnSeq)))
        .limit(1);
      if (dep) {
        if (["failed", "skipped", "cancelled"].includes(dep.status)) {
          await db
            .update(requirements)
            .set({
              status: "skipped",
              skipReason: `依赖 #${dep.seq}（${dep.title.slice(0, 20)}）状态为 ${dep.status === "failed" ? "失败" : dep.status}，级联跳过（依赖图 v2α）`,
            })
            .where(eq(requirements.id, requirement.id));
          await cancelRun(run.id);
          continue;
        }
        if (dep.status !== "done") continue;
      }
    }

    // 用户并发槽位（AC-D1）
    const [{ count: leases }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(containerLeases)
      .where(and(eq(containerLeases.userId, project.userId), ne(containerLeases.state, "released")));
    if (leases >= env.maxConcurrency) continue;

    // 原子认领（base 指针悬空防御：origin 上不存在时回落默认分支）
    let baseBranch = run.baseOverride ?? project.lastSuccessBranch ?? project.defaultBranch;
    const branch = `broccoli/${requirement.seq}-${slugify(requirement.title)}`;
    const [claimed] = await db
      .update(taskRuns)
      .set({ state: "preparing", startedAt: new Date(), branch, baseBranch })
      .where(and(eq(taskRuns.id, run.id), eq(taskRuns.state, "queued")))
      .returning();
    if (!claimed) continue;

    await db.update(requirements).set({ status: "active" }).where(eq(requirements.id, requirement.id));
    const [lease] = await db
      .insert(containerLeases)
      .values({ projectId: project.id, userId: project.userId, runId: run.id, state: "preparing", reason: "环境准备" })
      .returning();

    // 环境准备：重置工作区到 base，创建堆叠分支（真实 git）
    try {
      const origin = await originOpts(project);
      await ensureProjectRepos(project.id, {}, origin);
      if (!(await branchExistsOnOrigin(project.id, baseBranch, origin))) {
        await logLine(run.id, null, "warn", `⚠ base 分支 ${baseBranch} 在 origin 不存在（环境重建后指针悬空）→ 回落 ${project.defaultBranch}`);
        baseBranch = project.defaultBranch;
        await db.update(taskRuns).set({ baseBranch }).where(eq(taskRuns.id, run.id));
      }
      await checkoutBranchFrom(project.id, branch, baseBranch, origin);
      // 沙箱就绪（docker 模式：基础设施 + 项目容器；失败回落宿主执行并记录）
      const sbx = await getSandbox();
      try {
        await sbx.ensureForRun(project.id, workPath(project.id));
        await logLine(run.id, null, "info", `📦 沙箱就绪（${sbx.name}）`);
      } catch (err) {
        await logLine(run.id, null, "warn", `⚠ 沙箱就绪失败（${String(err).slice(0, 80)}）— 该任务回落宿主执行`);
      }
    } catch (err) {
      await failRun(claimed.id, null, `环境准备失败：${String(err)}`);
      continue;
    }

    // 创建 6 个阶段实例（模型解析落库，FR-D10/D17；批次临时覆盖优先，FR-D18）
    const models = await resolveStageModels(project.id);
    let batchOverrides: Record<string, string> = {};
    if (requirement.batchId) {
      const [batch] = await db.select().from(requirementBatches).where(eq(requirementBatches.id, requirement.batchId)).limit(1);
      batchOverrides = batch?.stageModelOverrides ?? {};
    }
    await db.insert(taskStages).values(
      STAGE_TYPES.map((t, i) => ({
        runId: run.id,
        type: t,
        seq: i,
        state: "queued" as const,
        modelKey: batchOverrides[t] ?? models[t].key,
        modelSource: batchOverrides[t] ? "override" : models[t].source,
      })),
    );

    // 记忆注入：已确认记忆 + 待确认提案（提案即注入，FR-G3）+ 依赖追溯落库（FR-G6）
    const items = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.projectId, project.id), eq(memoryItems.status, "confirmed")));
    const proposals = await db
      .select()
      .from(memoryProposals)
      .where(and(eq(memoryProposals.projectId, project.id), eq(memoryProposals.status, "pending")));
    // 用户级偏好记忆（v2α，FR-G10）：跨项目注入
    const userPrefs = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.userId, project.userId), eq(memoryItems.status, "confirmed")));
    const injections = [
      ...userPrefs.map((i) => `【个人偏好】${i.content}`),
      ...items.map((i) => `【记忆·${i.type}】${i.content}`),
      ...proposals.map((p) => `【提案·${p.type}】${p.content}`),
    ];
    // 仓库约定文件协同（FR-G8）：加载 CLAUDE.md 并注入上下文
    const claudeMd = await readRepoFile(project.id, "CLAUDE.md");
    if (claudeMd?.trim()) injections.push(`【仓库约定·CLAUDE.md】${claudeMd.trim().slice(0, 400)}`);
    for (const item of [...userPrefs, ...items]) {
      await db.insert(memoryInjections).values({ itemId: item.id, targetRunId: run.id });
    }
    for (const p of proposals) {
      await db.insert(memoryInjections).values({ proposalId: p.id, targetRunId: run.id });
    }
    await db.update(taskRuns).set({ snapshot: { injections } }).where(eq(taskRuns.id, run.id));

    await db.update(containerLeases).set({ state: "active" }).where(eq(containerLeases.id, lease.id));
    await db.update(taskRuns).set({ state: "running" }).where(eq(taskRuns.id, run.id));
    await logLine(run.id, null, "info", `▶ 任务启动 · 加载 ${items.length} 条已确认记忆 + ${proposals.length} 条待注入提案`);
    await logLine(run.id, null, "info", `✓ 工作区就绪 ${branch}（基于 ${baseBranch}）`);
    started += 1;
  }
  return started;
}

/* ============ 驱动运行中的 run（调度器调用） ============ */

export async function driveRun(runId: string): Promise<void> {
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run || run.state !== "running") return;
  const stages = await db.select().from(taskStages).where(eq(taskStages.runId, runId)).orderBy(asc(taskStages.seq));
  const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.runId, runId)).orderBy(asc(acceptanceCriteria.seq));
  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
  if (!requirement || !project) return;

  const parallel = project.settings?.parallelStages !== false;
  const done = (t: StageType) => {
    const s = stages.find((x) => x.type === t);
    return s && TERMINAL_STAGE.includes(s.state);
  };

  const actionable: typeof stages = [];
  for (const s of stages) {
    if (s.state !== "queued") continue;
    if (s.type === "planning") actionable.push(s);
    else if (s.type === "dev") {
      if (done("planning")) actionable.push(s);
    } else if (s.type === "test_design") {
      if (parallel ? done("planning") : done("dev")) actionable.push(s);
    } else if (s.type === "test_run") {
      if (done("dev") && done("test_design")) actionable.push(s);
    } else if (s.type === "acceptance") {
      if (done("test_run")) actionable.push(s);
    } else if (s.type === "delivery") {
      const allAchieved = criteria.length > 0 && criteria.every((c) => c.status === "achieved");
      if (done("acceptance") && allAchieved) actionable.push(s);
    }
  }

  for (const stage of actionable) {
    if (inflight.has(stage.id)) continue;
    const p = driveStage(run.id, stage.id)
      .catch((err) => {
        console.error("[orchestrator] driveStage error", err);
      })
      .finally(() => inflight.delete(stage.id));
    inflight.set(stage.id, p);
  }
}

function buildCtx(
  run: typeof taskRuns.$inferSelect,
  stage: typeof taskStages.$inferSelect,
  requirement: typeof requirements.$inferSelect,
  project: typeof projects.$inferSelect,
  subs: (typeof subtasks.$inferSelect)[],
  criteria: (typeof acceptanceCriteria.$inferSelect)[],
  nextPrNumber: number,
  userMessages: string[] = [],
): StageContext {
  const snapshot = (run.snapshot ?? {}) as { injections?: string[] };
  return {
    runId: run.id,
    stageId: stage.id,
    stageType: stage.type as StageType,
    projectId: project.id,
    userId: project.userId,
    requirement: { id: requirement.id, seq: requirement.seq, title: requirement.title, description: requirement.description },
    project: {
      id: project.id,
      name: project.name,
      repoFullName: project.repoFullName,
      defaultBranch: project.defaultBranch,
      failurePolicy: project.failurePolicy,
    },
    branch: run.branch!,
    baseBranch: run.baseBranch!,
    workspace: workPath(project.id),
    repairRound: run.repairRound,
    confirmAnswer: run.confirmAnswer,
    injections: snapshot.injections ?? [],
    userMessages,
    subtasks: subs.map((s) => ({ seq: s.seq, title: s.title, state: s.state })),
    criteria: criteria.map((c) => ({ seq: c.seq, content: c.content, verifyStage: c.verifyStage, status: c.status })),
    nextPrNumber,
  };
}

async function driveStage(runId: string, stageId: string): Promise<void> {
  const [stage] = await db
    .update(taskStages)
    .set({ state: "running", startedAt: new Date() })
    .where(and(eq(taskStages.id, stageId), eq(taskStages.state, "queued")))
    .returning();
  if (!stage) return;
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run || run.state !== "running") {
    await db.update(taskStages).set({ state: "queued", startedAt: null }).where(eq(taskStages.id, stageId));
    return;
  }
  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
  if (!requirement || !project) return;
  await db.update(taskRuns).set({ currentStage: stage.type }).where(eq(taskRuns.id, runId));

  const subs = await db.select().from(subtasks).where(eq(subtasks.runId, runId)).orderBy(asc(subtasks.seq));
  const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.runId, runId)).orderBy(asc(acceptanceCriteria.seq));
  const [{ count: prCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pullRequests)
    .where(eq(pullRequests.projectId, project.id));
  const engine = await getEngine(project.userId);
  const userMsgs = await db
    .select()
    .from(runMessages)
    .where(and(eq(runMessages.runId, runId), eq(runMessages.role, "user")));
  const ctx = buildCtx(run, stage, requirement, project, subs, criteria, prCount + 1, userMsgs.map((m) => m.text));
  const startedAt = Date.now();

  await logLine(runId, stageId, "info", `▶ ${stage.type} 启动 · 模型 ${stage.modelKey}（${stage.modelSource === "custom" ? "自定义" : "推荐"}）${run.repairRound > 0 ? ` · 修复轮次 ${run.repairRound}` : ""}`);

  try {
    const output = await engine.runStage(ctx);
    if (output.confirm) {
      await pauseForConfirm(run, stage, output, output.confirm);
      return;
    }

    const endedAt = new Date();
    await db
      .update(taskStages)
      .set({ state: output.skipped ? "skipped" : "completed", summary: output.summary, endedAt })
      .where(eq(taskStages.id, stageId));
    for (const a of output.artifacts) {
      await db.insert(stageArtifacts).values({
        stageId,
        runId,
        name: a.name,
        kind: a.kind,
        storageKey: a.storageKey,
        meta: a.meta ?? {},
      });
    }

    if (ctx.stageType === "planning" && output.subtaskTitles?.length) {
      await db.insert(subtasks).values(
        output.subtaskTitles.map((t, i) => ({ runId, seq: i + 1, title: t, state: "queued", ownerStageId: stageId })),
      );
    }
    if (ctx.stageType === "planning" && output.criteria?.length) {
      await db.insert(acceptanceCriteria).values(
        output.criteria.map((c, i) => ({ runId, seq: i + 1, content: c.content, verifyStage: c.verifyStage, status: "defined" })),
      );
    }
    if (output.criteriaUpdates?.length) {
      for (const u of output.criteriaUpdates) {
        await db
          .update(acceptanceCriteria)
          .set({ status: u.status, evidence: u.evidence, achievedByStageId: stageId, updatedAt: new Date() })
          .where(and(eq(acceptanceCriteria.runId, runId), eq(acceptanceCriteria.seq, u.seq)));
      }
    }
    await db.insert(usageRecords).values({
      userId: project.userId,
      runId,
      stageId,
      inputTokens: output.tokens?.in ?? 0,
      outputTokens: output.tokens?.out ?? 0,
      containerSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
    await logLine(runId, stageId, output.skipped ? "warn" : "ok", `${output.skipped ? "⊘ 已跳过" : "✓ 完成"} · ${output.summary}`);

    // 阶段后转移
    if (ctx.stageType === "acceptance") {
      await handleAcceptanceDone(runId);
    } else if (ctx.stageType === "delivery") {
      await completeRun(run, stage, output);
    }
  } catch (err) {
    const message = err instanceof StageFailure ? err.message : String(err);
    const reportKey = (err as { reportKey?: string }).reportKey;
    await db
      .update(taskStages)
      .set({ state: "failed", summary: message, endedAt: new Date() })
      .where(eq(taskStages.id, stageId));
    if (reportKey) {
      await db.insert(stageArtifacts).values({ stageId, runId, name: "测试报告.md", kind: "report", storageKey: reportKey });
    }
    await failRun(runId, stageId, `${stage.type}：${message}`);
  }
}

/* ============ 验收完成后的转移（FR-D14 回溯修复 / 用户决策） ============ */

async function handleAcceptanceDone(runId: string) {
  const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.runId, runId));
  const failed = criteria.filter((c) => c.status === "failed");
  if (failed.length === 0) return; // 全部达成 → 交付阶段下个 tick 启动

  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run) return;

  if (run.repairRound < env.maxRepairRounds) {
    const nextRound = run.repairRound + 1;
    await db.update(taskRuns).set({ repairRound: nextRound, currentStage: "dev" }).where(eq(taskRuns.id, runId));
    for (const t of ["dev", "test_run", "acceptance"] as StageType[]) {
      await db
        .update(taskStages)
        .set({ state: "queued", startedAt: null, endedAt: null, summary: null })
        .where(and(eq(taskStages.runId, runId), eq(taskStages.type, t)));
    }
    await logLine(runId, null, "warn", `⚠ 验收未达成 → 自动回溯修复第 ${nextRound} 轮（FR-D14）：重置 开发/测试执行/验收对照`);
  } else {
    const [run2] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
    const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run2!.requirementId)).limit(1);
    const stage = (await db.select().from(taskStages).where(and(eq(taskStages.runId, runId), eq(taskStages.type, "acceptance"))).limit(1))[0];
    await pauseForConfirm(run2!, stage, { summary: "验收未达成且修复轮次已用尽" }, {
      question: `验收存在 ${failed.length} 条未达成标准（修复轮次已用尽）。请决定后续处理：`,
      options: [
        { key: "retry", label: "再修复一轮", description: `重置 开发/测试执行/验收对照 继续尝试` },
        { key: "downgrade", label: "降级交付", description: "豁免未达成项，立即进入交付阶段", recommended: true },
      ],
      allowFreeText: true,
      context: failed.map((c) => `✗ ${c.content} — ${c.evidence ?? ""}`).join("\n"),
    }, { requirementTitle: requirement?.title ?? "", seq: requirement?.seq ?? 0 });
  }
}

/* ============ 等待确认（FR-D4/D5：立即快照、按需释放容器、关键邮件） ============ */

async function pauseForConfirm(
  run: typeof taskRuns.$inferSelect,
  stage: typeof taskStages.$inferSelect,
  output: { summary?: string },
  question: import("@/db/schema").ConfirmQuestion,
  extra?: { requirementTitle?: string; seq?: number },
) {
  const expiresAt = new Date(Date.now() + env.snapshotTtlHours * 3600 * 1000);
  await db
    .update(taskStages)
    .set({ state: "wait_confirm", summary: output.summary ?? "等待用户确认" })
    .where(eq(taskStages.id, stage.id));
  await db
    .update(taskRuns)
    .set({ state: "wait_confirm", confirmQuestion: question, confirmExpiresAt: expiresAt })
    .where(eq(taskRuns.id, run.id));

  // 并行等待：另一支线仍执行中 → 容器保留（§4.1）；否则立即快照释放（AC-D5）
  const siblings = await db
    .select()
    .from(taskStages)
    .where(and(eq(taskStages.runId, run.id), ne(taskStages.id, stage.id)));
  const siblingRunning = siblings.some((s) => s.state === "running");
  if (!siblingRunning) {
    await releaseLease(run.id, "等待确认 · 快照释放");
    await db.insert(sessionSnapshots).values({
      runId: run.id,
      stageId: stage.id,
      sdkSessionId: `snap_${run.id.slice(0, 8)}`,
      patchObjectKey: `.data/snapshots/${run.id}.patch`,
      baseBranch: run.baseBranch,
      expiresAt,
    });
  }
  const leaseNote = siblingRunning ? "容器保留（并行支线执行中）· 不占新槽位" : "已保存会话快照 · 容器已释放 · 不占并发槽位";

  await logLine(run.id, stage.id, "warn", `⏸ 需要决策：${question.question.slice(0, 60)}…`);
  await logLine(run.id, stage.id, "warn", `⏸ ${leaseNote} · 提醒邮件已发送`);

  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
  if (requirement && project) {
    await notify({
      userId: project.userId,
      type: "wait_confirm",
      runId: run.id,
      projectName: project.name,
      requirementTitle: requirement.title,
      requirementSeq: requirement.seq,
      summary: `${question.question.slice(0, 80)}（${leaseNote} · 快照保留 ${env.snapshotTtlHours}h）`,
    });
  }
  void extra;
}

/* ============ 用户确认（POST /confirm） ============ */

export async function applyConfirm(runId: string, answer: string, optionKey?: string): Promise<{ ok: boolean; message: string }> {
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run) return { ok: false, message: "任务不存在" };
  if (run.state !== "wait_confirm") return { ok: false, message: "任务不在等待确认状态" };
  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
  const currentStageType = run.currentStage as StageType;

  await db.insert(auditLogs).values({
    actor: "user",
    action: "confirm",
    target: `run:${runId}`,
    detail: { answer: answer.slice(0, 200), optionKey },
  });

  // 验收确认的特殊选项（AC-D14）
  if (currentStageType === "acceptance" && optionKey) {
    if (optionKey === "terminate") return cancelRun(runId);
    if (optionKey === "retry") {
      await db.update(taskRuns).set({ repairRound: 0, state: "running", confirmQuestion: null, confirmAnswer: null }).where(eq(taskRuns.id, runId));
      for (const t of ["dev", "test_run", "acceptance"] as StageType[]) {
        await db.update(taskStages).set({ state: "queued", startedAt: null, endedAt: null, summary: null }).where(and(eq(taskStages.runId, runId), eq(taskStages.type, t)));
      }
      await logLine(runId, null, "ok", `↻ 用户选择再修复一轮 → 重新开始`);
      await ensureLeaseForRun(runId);
      return { ok: true, message: "已重新开始修复" };
    }
    if (optionKey === "downgrade") {
      await db
        .update(acceptanceCriteria)
        .set({ status: "achieved", evidence: `用户降级确认：${answer || "豁免未达成项"}`, updatedAt: new Date() })
        .where(and(eq(acceptanceCriteria.runId, runId), eq(acceptanceCriteria.status, "failed")));
      const stage = (await db.select().from(taskStages).where(and(eq(taskStages.runId, runId), eq(taskStages.type, "acceptance"))).limit(1))[0];
      await db.update(taskStages).set({ state: "completed", summary: "用户降级确认 → 交付", endedAt: new Date() }).where(eq(taskStages.id, stage.id));
      await db.update(taskRuns).set({ state: "running", confirmQuestion: null, confirmAnswer: null, currentStage: "delivery" }).where(eq(taskRuns.id, runId));
      await logLine(runId, null, "warn", `⚠ 用户降级交付 → 豁免未达成项，进入交付`);
      await ensureLeaseForRun(runId);
      return { ok: true, message: "已降级交付" };
    }
  }

  // 通用（规划/开发）：记录回答 → 恢复执行
  await db.update(taskRuns).set({ confirmAnswer: answer, state: "running", confirmQuestion: null }).where(eq(taskRuns.id, runId));
  await db
    .update(taskStages)
    .set({ state: "queued", startedAt: null })
    .where(and(eq(taskStages.runId, runId), eq(taskStages.type, currentStageType)));
  await logLine(runId, null, "ok", `↻ 用户已确认${optionKey ? `（${optionKey}）` : ""} → 恢复执行（从快照恢复）`);
  await db.update(sessionSnapshots).set({ status: "consumed" }).where(and(eq(sessionSnapshots.runId, runId), eq(sessionSnapshots.status, "active")));
  await ensureLeaseForRun(runId);
  void requirement;
  return { ok: true, message: "已确认，任务恢复执行" };
}

/** 确保运行中的 run 有容器租约（快照恢复后重新拉起，AC-D5） */
async function ensureLeaseForRun(runId: string) {
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run) return false;
  const [lease] = await db
    .select()
    .from(containerLeases)
    .where(and(eq(containerLeases.runId, runId), ne(containerLeases.state, "released")))
    .limit(1);
  if (lease) return true;
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
  if (!project) return false;
  return acquireLease({ id: run.id, projectId: run.projectId, userId: project.userId });
}

/* ============ 完成 / 失败 / 取消 ============ */

async function completeRun(
  run: typeof taskRuns.$inferSelect,
  deliveryStage: typeof taskStages.$inferSelect,
  output: StageOutput,
) {
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
  if (!project || !requirement) return;

  // 真实 push 分支 + PR（AC-F1 堆叠）：github origin 开真实 PR，本地模式镜像落库
  const origin = await originOpts(project);
  await pushBranch(project.id, run.branch!, origin);
  const stat = await diffStat(project.id, run.baseBranch!, run.branch!);
  const prBody = String(output.artifacts.find((a) => a.kind === "pr")?.meta?.body ?? "");
  const [{ count: prCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pullRequests)
    .where(eq(pullRequests.projectId, project.id));

  let prNumber = prCount + 1;
  if (project.originKind === "github") {
    const token = origin.token!;
    const real = await createPullRequest(token, project.repoFullName, {
      head: run.branch!,
      base: run.baseBranch!,
      title: requirement.title,
      body: `${prBody}\n\n> 由 Broccoli 流水线自动开出（需求 #${requirement.seq}）`,
    });
    if (!real.ok) {
      await failRun(run.id, deliveryStage.id, `GitHub 开 PR 失败：${real.error}`);
      return;
    }
    prNumber = real.pr!.number;
    await logLine(run.id, deliveryStage.id, "ok", `🔗 真实 PR #${prNumber} 已开出：${real.pr!.htmlUrl}`);
  }

  await db.insert(pullRequests).values({
    projectId: project.id,
    runId: run.id,
    number: prNumber,
    title: requirement.title,
    branch: run.branch!,
    baseBranch: run.baseBranch!,
    body: prBody,
    diffStat: stat,
  });
  await db.update(projects).set({ lastSuccessBranch: run.branch! }).where(eq(projects.id, project.id));

  // 记忆提案（FR-G2）
  for (const p of output.memoryProposals ?? []) {
    await db.insert(memoryProposals).values({ projectId: project.id, sourceRunId: run.id, type: p.type, content: p.content });
  }

  // Issues 状态回写（FR-C4）：需求关联的 open issue 随 PR 开出自动关闭（github 同步真实 API）
  const syncedIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.syncedRequirementId, requirement.id), eq(issues.state, "open")));
  for (const is of syncedIssues) {
    if (project.originKind === "github") {
      const token = origin.token!;
      const closed = await closeIssue(token, project.repoFullName, is.number);
      if (!closed.ok) await logLine(run.id, deliveryStage.id, "warn", `Issue #${is.number} 关闭失败：${closed.error}`);
    }
    await db.update(issues).set({ state: "closed", closedAt: new Date() }).where(eq(issues.id, is.id));
    await logLine(run.id, deliveryStage.id, "ok", `🔗 Issue #${is.number} 已关闭（状态回写，FR-C4）`);
  }

  await db.update(taskRuns).set({ state: "completed", endedAt: new Date(), currentStage: "delivery" }).where(eq(taskRuns.id, run.id));
  await db.update(requirements).set({ status: "done" }).where(eq(requirements.id, requirement.id));
  await releaseLease(run.id, "任务完成");
  await logLine(run.id, deliveryStage.id, "ok", output.summary);
  await logLine(run.id, null, "ok", `✓ 任务完成 · PR 已开出 · 记忆提案 ${(output.memoryProposals ?? []).length} 条待确认`);
  await notify({
    userId: project.userId,
    type: "completed",
    runId: run.id,
    projectName: project.name,
    requirementTitle: requirement.title,
    requirementSeq: requirement.seq,
    summary: output.summary,
  });
}

export async function failRun(runId: string, stageId: string | null, message: string) {
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run || TERMINAL_RUN.includes(run.state)) return;
  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
  await db.update(taskRuns).set({ state: "failed", error: message, endedAt: new Date() }).where(eq(taskRuns.id, runId));
  await db.update(requirements).set({ status: "failed" }).where(eq(requirements.id, run.requirementId));
  await releaseLease(runId, "任务失败");
  await logLine(runId, stageId, "error", `✗ 任务失败：${message}`);
  if (project && requirement) {
    await notify({
      userId: project.userId,
      type: "failed",
      runId,
      projectName: project.name,
      requirementTitle: requirement.title,
      requirementSeq: requirement.seq,
      summary: `${message} · 失败策略：${project.failurePolicy === "pause" ? "暂停队列" : "自动跳过并继续"}`,
    });
  }
}

export async function cancelRun(runId: string): Promise<{ ok: boolean; message: string }> {
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run) return { ok: false, message: "任务不存在" };
  if (TERMINAL_RUN.includes(run.state)) return { ok: false, message: "任务已进入终态" };
  await db.update(taskRuns).set({ state: "cancelled", endedAt: new Date() }).where(eq(taskRuns.id, runId));
  await db.update(requirements).set({ status: "cancelled" }).where(and(eq(requirements.id, run.requirementId), eq(requirements.status, "active")));
  await releaseLease(runId, "用户取消");
  await logLine(runId, null, "warn", "◼ 任务已取消");
  return { ok: true, message: "任务已取消" };
}

/* ============ 挂起超时（快照过期，FR-D5/AC-D5） ============ */

export async function suspendExpired(): Promise<number> {
  const expired = await db
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.state, "wait_confirm"), sql`${taskRuns.confirmExpiresAt} < now()`));
  for (const run of expired) {
    await db.update(taskRuns).set({ state: "suspended", endedAt: new Date() }).where(eq(taskRuns.id, run.id));
    await db.update(requirements).set({ status: "suspended" }).where(eq(requirements.id, run.requirementId));
    await db.update(sessionSnapshots).set({ status: "expired" }).where(and(eq(sessionSnapshots.runId, run.id), eq(sessionSnapshots.status, "active")));
    await releaseLease(run.id, "快照过期挂起");
    const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
    const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
    await logLine(run.id, null, "warn", `💤 快照超时未回复 → 任务挂起，队列继续后续任务（base 回退至最后成功分支）`);
    if (project && requirement) {
      await notify({
        userId: project.userId,
        type: "suspended",
        runId: run.id,
        projectName: project.name,
        requirementTitle: requirement.title,
        requirementSeq: requirement.seq,
        summary: `等待确认超时（${env.snapshotTtlHours}h），任务已挂起；可将该需求重新入队`,
      });
    }
  }
  return expired.length;
}

/* ============ PR 界面合并（FR-F2）/ 堆叠链修复（FR-F3） ============ */

export async function mergeProjectPr(prId: string, userId: string): Promise<{ ok: boolean; message: string }> {
  const rows = await db
    .select({ pr: pullRequests, project: projects })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(eq(pullRequests.id, prId), eq(projects.userId, userId)))
    .limit(1);
  if (!rows.length) return { ok: false, message: "PR 不存在" };
  const { pr, project } = rows[0];
  if (pr.status !== "open") return { ok: false, message: "PR 已合并或关闭" };

  const [{ count: active }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskRuns)
    .where(and(eq(taskRuns.projectId, project.id), inArray(taskRuns.state, ["preparing", "running", "wait_confirm"])));
  if (active > 0) return { ok: false, message: "队列执行中，请等待当前任务进入终态后再合并" };

  if (project.originKind === "github") {
    // 真实合并：GitHub merge API（冲突/权限由 API 返回）
    const token = await resolveGithubToken(userId);
    if (!token) return { ok: false, message: "缺少 GitHub token（平台 GITHUB_TOKEN 或用户 PAT）" };
    const res = await mergePullRequest(token, project.repoFullName, pr.number);
    if (!res.ok) return { ok: false, message: `GitHub 合并失败：${res.error}` };
    await db.update(pullRequests).set({ status: "merged" }).where(eq(pullRequests.id, prId));
    await db.insert(auditLogs).values({ actor: "user", action: "merge_pr", target: `pr:${prId}`, detail: { number: pr.number, real: true } });
    await logLineByPr(project.id, pr, `✓ 真实 PR #${pr.number} 已通过 GitHub API 合并到 ${pr.baseBranch}（FR-F2）`);
    return { ok: true, message: `真实 PR #${pr.number} 已合并到 ${pr.baseBranch}` };
  }

  await checkoutExisting(project.id, pr.baseBranch);
  await mergeBranch(project.id, pr.branch, `Merge PR #${pr.number}: ${pr.title}`);
  await pushBranch(project.id, pr.baseBranch);
  await db.update(pullRequests).set({ status: "merged" }).where(eq(pullRequests.id, prId));
  await db.insert(auditLogs).values({ actor: "user", action: "merge_pr", target: `pr:${prId}`, detail: { number: pr.number } });
  await logLineByPr(project.id, pr, `✓ PR #${pr.number} 已合并到 ${pr.baseBranch}（FR-F2）`);
  return { ok: true, message: `PR #${pr.number} 已合并到 ${pr.baseBranch}` };
}

/** 堆叠链修复（FR-F3/AC-F3）：关闭该 PR 及其后继链，受影响需求基于新 base 重新入队 */
export async function rebasePrChain(prId: string, userId: string): Promise<{ ok: boolean; message: string; requeued: number }> {
  const rows = await db
    .select({ pr: pullRequests, project: projects })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(eq(pullRequests.id, prId), eq(projects.userId, userId)))
    .limit(1);
  if (!rows.length) return { ok: false, message: "PR 不存在", requeued: 0 };
  const { pr, project } = rows[0];
  if (pr.status !== "open") return { ok: false, message: "仅 open 的 PR 可发起堆叠链修复", requeued: 0 };

  const laterPrs = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.projectId, project.id), sql`${pullRequests.number} >= ${pr.number}`, eq(pullRequests.status, "open")));
  const requeued: string[] = [];
  const ghToken = project.originKind === "github" ? await resolveGithubToken(userId) : null;
  for (const p of laterPrs) {
    if (ghToken) {
      const closed = await closePullRequest(ghToken, project.repoFullName, p.number);
      if (!closed.ok) return { ok: false, message: `GitHub 关闭 PR #${p.number} 失败：${closed.error}`, requeued: 0 };
    }
    await db.update(pullRequests).set({ status: "closed" }).where(eq(pullRequests.id, p.id));
    if (p.runId) {
      const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, p.runId)).limit(1);
      if (run) {
        const res = await retryRequirement(run.requirementId, { baseOverride: p.baseBranch });
        if (res.ok) requeued.push(run.requirementId);
      }
    }
  }
  await db.insert(auditLogs).values({
    actor: "user",
    action: "rebase_pr_chain",
    target: `pr:${prId}`,
    detail: { closed: laterPrs.map((p) => p.number), requeued: requeued.length, newBase: pr.baseBranch },
  });
  return { ok: true, message: `已关闭 ${laterPrs.length} 个 PR，${requeued.length} 个需求基于 ${pr.baseBranch} 重新入队`, requeued: requeued.length };
}

function logLineByPr(projectId: string, pr: typeof pullRequests.$inferSelect, line: string) {
  // 合并事件写入该项目最近一次相关 run 的日志流；无 run（历史 PR）仅审计
  return pr.runId ? logLine(pr.runId, null, "ok", line) : Promise.resolve();
}

/* ============ 初始项目分析（FR-G7） ============ */

export async function initialProjectAnalysis(projectId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memoryProposals)
    .where(eq(memoryProposals.projectId, projectId));
  if (count > 0) return 0;
  const rows = await db
    .insert(memoryProposals)
    .values([
      { projectId, type: "convention", content: "初始分析：源码位于 src/ 目录，测试位于 tests/ 目录，命名遵循 <slug> 模式" },
      { projectId, type: "fact", content: "初始分析：测试命令为 pnpm test / node --test tests/*.test.mjs" },
      { projectId, type: "convention", content: "初始分析：遵循仓库 CLAUDE.md 约定（如存在），平台会自动合并注入" },
    ])
    .returning();
  return rows.length;
}

/* ============ 用户处置（重试 / 跳过 / 终止 / 重新入队） ============ */

export async function retryRequirement(
  requirementId: string,
  opts?: { baseOverride?: string },
): Promise<{ ok: boolean; message: string }> {
  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, requirementId)).limit(1);
  if (!requirement) return { ok: false, message: "需求不存在" };
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskRuns)
    .where(eq(taskRuns.requirementId, requirementId));
  const [run] = await db
    .insert(taskRuns)
    .values({
      requirementId,
      projectId: requirement.projectId,
      attemptNo: count + 1,
      state: "queued",
      baseOverride: opts?.baseOverride ?? null,
    })
    .returning();
  await db.update(requirements).set({ status: "queued", latestRunId: run.id }).where(eq(requirements.id, requirementId));
  return { ok: true, message: `已重试（第 ${count + 1} 次执行）` };
}

export async function skipRequirement(requirementId: string): Promise<{ ok: boolean; message: string }> {
  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, requirementId)).limit(1);
  if (!requirement) return { ok: false, message: "需求不存在" };
  const [activeRun] = await db
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.requirementId, requirementId), inArray(taskRuns.state, ["queued", "preparing", "running", "wait_confirm"])))
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);
  if (activeRun) await cancelRun(activeRun.id);
  await db.update(requirements).set({ status: "skipped" }).where(eq(requirements.id, requirementId));
  return { ok: true, message: "已跳过，队列继续后续任务（base 回退至最后成功分支）" };
}

export async function terminateProjectQueue(projectId: string): Promise<{ ok: boolean; message: string }> {
  const activeRuns = await db
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.projectId, projectId), inArray(taskRuns.state, ["queued", "preparing", "running", "wait_confirm"])));
  for (const r of activeRuns) await cancelRun(r.id);
  await db.update(requirements).set({ status: "cancelled" }).where(and(eq(requirements.projectId, projectId), eq(requirements.status, "queued")));
  return { ok: true, message: "已终止：活跃任务取消，剩余队列转已取消" };
}

export async function requeueRequirement(requirementId: string): Promise<{ ok: boolean; message: string }> {
  return retryRequirement(requirementId);
}

/* ============ 供 API 使用的聚合查询 ============ */

export async function getCanvas(runId: string) {
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run) return null;
  const [requirement] = await db.select().from(requirements).where(eq(requirements.id, run.requirementId)).limit(1);
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1);
  const stages = await db.select().from(taskStages).where(eq(taskStages.runId, runId)).orderBy(asc(taskStages.seq));
  const stageIds = stages.map((s) => s.id);
  const subs = await db.select().from(subtasks).where(eq(subtasks.runId, runId)).orderBy(asc(subtasks.seq));
  const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.runId, runId)).orderBy(asc(acceptanceCriteria.seq));
  const artifacts = stageIds.length ? await db.select().from(stageArtifacts).where(inArray(stageArtifacts.runId, [runId])) : [];
  const logs = await db.select().from(stageLogs).where(eq(stageLogs.runId, runId)).orderBy(asc(stageLogs.ts)).limit(300);
  const prs = await db.select().from(pullRequests).where(eq(pullRequests.runId, runId));
  return { run, requirement, project, stages, subtasks: subs, criteria, artifacts, logs, prs };
}

export async function markSeenPrNumber(projectId: string) {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(number), 0)::int` })
    .from(pullRequests)
    .where(eq(pullRequests.projectId, projectId));
  void max;
}
