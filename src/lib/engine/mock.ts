import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "child_process";
import { promisify } from "node:util";
import { env } from "@/lib/env";
import { commitAll, diffStat, changedFiles, workPath } from "@/lib/git";
import {
  type ExecutionEngine,
  type StageContext,
  type StageOutput,
  StageFailure,
  sleep,
  slugify,
} from "./types";

/**
 * MockEngine：确定性离线引擎——阶段行为脚本化，但文件操作 / git 提交 / 测试执行全部真实发生，
 * 用于无 Anthropic key / 无 GitHub 授权环境下的端到端演示（BROCCOLI_ENGINE=mock）。
 */

const ARTIFACT_ROOT = path.join(process.cwd(), env.dataDir, "artifacts");

async function writeArtifact(runId: string, name: string, content: string): Promise<string> {
  const key = path.join(runId, name);
  const p = path.join(ARTIFACT_ROOT, key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return key;
}

async function readArtifact(runId: string, name: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(ARTIFACT_ROOT, runId, name), "utf8");
  } catch {
    return null;
  }
}

export function needsSelection(title: string): boolean {
  return /数据库|存储|选型/.test(title);
}

export function wantsFailure(title: string): boolean {
  return /\[fail-tests\]/.test(title);
}

export function wantsRepair(title: string): boolean {
  return /\[repair\]|分页|筛选/.test(title);
}

function baseCriteria(confirmAnswer?: string | null) {
  const list = [
    { content: "实现与需求描述一致，代码结构清晰", verifyStage: "dev" },
    { content: "变更通过 lint / 类型检查", verifyStage: "dev" },
    { content: "单元测试全部通过", verifyStage: "test_run" },
    { content: "PR 描述包含变更说明与依赖提示", verifyStage: "delivery" },
  ];
  if (confirmAnswer) {
    list.splice(2, 0, { content: `会话存储选型符合用户决定（${confirmAnswer}）`, verifyStage: "dev" });
  }
  return list;
}

export class MockEngine implements ExecutionEngine {
  readonly name = "mock" as const;

  async runStage(ctx: StageContext): Promise<StageOutput> {
    switch (ctx.stageType) {
      case "planning":
        return this.planning(ctx);
      case "dev":
        return this.dev(ctx);
      case "test_design":
        return this.testDesign(ctx);
      case "test_run":
        return this.testRun(ctx);
      case "acceptance":
        return this.acceptance(ctx);
      case "delivery":
        return this.delivery(ctx);
    }
  }

  /* ---------- 规划：拆解子任务 + 生成验收标准 + 未决选型提问（FR-D11） ---------- */
  private async planning(ctx: StageContext): Promise<StageOutput> {
    await sleep(1400);
    const slug = slugify(ctx.requirement.title);
    const needsSel = needsSelection(ctx.requirement.title);

    // 未决技术选型 → 结构化提问转「等待确认」（AC-D11）
    if (needsSel && !ctx.confirmAnswer) {
      const planKey = await writeArtifact(
        ctx.runId,
        "实现计划.md",
        `# 实现计划 · ${ctx.requirement.title}\n\n> ⏸ 技术选型待用户确认后补充完整方案。\n`,
      );
      return {
        summary: "已产出初步计划；检测到未决技术选型，需要用户确认",
        artifacts: [{ name: "实现计划.md", kind: "plan", storageKey: planKey }],
        confirm: {
          question: `「${ctx.requirement.title}」需要持久化与并发支撑，请选择会话存储方案：`,
          options: [
            { key: "postgres", label: "PostgreSQL + Redis", description: "与生产拓扑一致 · 原生 TTL 适合限流计数", recommended: true },
            { key: "sqlite", label: "SQLite", description: "零运维 · 单机部署友好 · 写入并发受限" },
          ],
          allowFreeText: true,
          context: "结合项目记忆「生产拓扑为 PostgreSQL」，规划阶段倾向 PostgreSQL + Redis",
        },
        tokens: { in: 9200, out: 1100 },
      };
    }

    const subtaskTitles = [
      `${ctx.requirement.title} · 设计与接口定义`,
      `${ctx.requirement.title} · 核心实现`,
      `${ctx.requirement.title} · 接入与回归`,
    ];
    const criteria = baseCriteria(ctx.confirmAnswer);
    const plan = [
      `# 实现计划 · ${ctx.requirement.title}`,
      "",
      "## 上下文注入",
      ...(ctx.injections.length ? ctx.injections.map((s) => `- ${s}`) : ["- （无前序记忆）"]),
      "",
      ...(ctx.confirmAnswer ? [`## 技术方案（用户确认）\n\n- 存储：${ctx.confirmAnswer}\n`] : []),
      "## 子任务",
      ...subtaskTitles.map((t, i) => `${i + 1}. ${t}`),
      "",
      "## 验收标准",
      ...criteria.map((c, i) => `${i + 1}. [${c.verifyStage}] ${c.content}`),
      "",
      ctx.repairRound > 0 ? `> 本轮为第 ${ctx.repairRound} 轮回溯修复（FR-D14）。` : "",
    ].join("\n");
    const planKey = await writeArtifact(ctx.runId, "实现计划.md", plan);

    return {
      summary: `拆解出 ${subtaskTitles.length} 个子任务，生成 ${criteria.length} 条验收标准${ctx.confirmAnswer ? "；技术选型已按用户决定锁定" : ""}`,
      artifacts: [{ name: "实现计划.md", kind: "plan", storageKey: planKey }],
      subtaskTitles,
      criteria,
      tokens: { in: 11200, out: 1600 },
    };
  }

  /* ---------- 开发：真实写文件 + 提交到堆叠分支 ---------- */
  private async dev(ctx: StageContext): Promise<StageOutput> {
    await sleep(1800);
    const slug = `${slugify(ctx.requirement.title)}-${ctx.requirement.seq}`;
    const srcPath = path.join(workPath(ctx.projectId), "src", `${slug}.mjs`);
    const moduleName = slug.replace(/-/g, "_");

    const impl = [
      `// ${ctx.requirement.title}`,
      ctx.confirmAnswer ? `// 技术选型（用户确认）：${ctx.confirmAnswer}` : "",
      ctx.repairRound > 0 ? `// 回溯修复第 ${ctx.repairRound} 轮：补充校验逻辑` : "",
      `export function solve(input) {`,
      `  if (input == null || typeof input !== "object") throw new Error("input must be object");`,
      ctx.repairRound > 0 ? `  if ("page" in input && typeof input.page !== "number") throw new Error("page must be number");` : "",
      `  return { ok: true, module: "${moduleName}", at: Date.now() };`,
      `}`,
      `export default solve;`,
      ...ctx.userMessages.map((m) => `// 用户补充说明（FR-E6）：${m.slice(0, 80)}`),
    ]
      .filter(Boolean)
      .join("\n");

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, impl);
    const committed = await commitAll(ctx.projectId, `feat(${slug}): ${ctx.requirement.title} [Broccoli 需求 #${ctx.requirement.seq}]`);
    if (!committed) throw new StageFailure("开发阶段未产生任何变更");
    const stat = await diffStat(ctx.projectId, ctx.baseBranch, ctx.branch);
    const files = await changedFiles(ctx.projectId, ctx.baseBranch, ctx.branch);
    const diffKey = await writeArtifact(ctx.runId, `diff-${ctx.stageType}.txt`, stat);

    return {
      summary: `实现 src/${slug}.mjs 并提交到 ${ctx.branch}${ctx.userMessages.length ? ` · 已纳入 ${ctx.userMessages.length} 条用户补充说明` : ""}`,
      artifacts: [
        { name: "代码 diff", kind: "diff", storageKey: diffKey, meta: { files, stat } },
      ],
      tokens: { in: 22000, out: 3400 },
    };
  }

  /* ---------- 测试用例编写：依据验收标准写真实可执行的 node:test 用例 ---------- */
  private async testDesign(ctx: StageContext): Promise<StageOutput> {
    await sleep(1600);
    const slug = `${slugify(ctx.requirement.title)}-${ctx.requirement.seq}`;
    const testPath = path.join(workPath(ctx.projectId), "tests", `${slug}.test.mjs`);
    const failMode = wantsFailure(ctx.requirement.title) && ctx.repairRound === 0;

    const content = [
      `import { test } from "node:test";`,
      `import assert from "node:assert/strict";`,
      `import solve from "../src/${slug}.mjs";`,
      "",
      `test("${ctx.requirement.title} · 正常输入返回 ok", () => {`,
      `  const r = solve({ demo: true });`,
      `  assert.equal(r.ok, true);`,
      `});`,
      "",
      `test("${ctx.requirement.title} · 空输入抛出错误", () => {`,
      `  assert.throws(() => solve(null));`,
      `});`,
      "",
      failMode ? `test("${ctx.requirement.title} · 深色模式偏好持久化（预期失败示范）", () => {` : `test("${ctx.requirement.title} · 参数校验", () => {`,
      failMode ? `  const r = solve({ theme: "dark" });\n  assert.equal(r.ok, false); // 故意失败：模拟 agent 产出缺陷 [fail-tests]` : ctx.repairRound > 0 && wantsRepair(ctx.requirement.title) ? `  assert.throws(() => solve({ page: "NaN" })); // 修复后：校验生效（FR-D14 回路闭合）` : `  assert.throws(() => solve(42));`,
      `});`,
      "",
    ].join("\n");

    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(testPath, content);
    await commitAll(ctx.projectId, `test(${slug}): 依据验收标准编写用例 [Broccoli]`);
    const key = await writeArtifact(ctx.runId, `tests-${slug}.test.mjs`, content);
    return {
      summary: `产出 3 个测试用例（tests/${slug}.test.mjs）`,
      artifacts: [{ name: `tests/${slug}.test.mjs`, kind: "testcase", storageKey: key }],
      tokens: { in: 14800, out: 2100 },
    };
  }

  /* ---------- 测试执行：真实运行 node --test（FR-D9） ---------- */
  private async testRun(ctx: StageContext): Promise<StageOutput> {
    await sleep(900);
    const work = workPath(ctx.projectId);
    const testsDir = path.join(work, "tests");
    const exists = await fs
      .access(testsDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return { summary: "项目未配置测试命令，阶段自动跳过", artifacts: [], skipped: true, tokens: { in: 400, out: 50 } };
    }

    const run = promisify(execFile);
    let stdout = "";
    let failed = false;
    try {
      const res = await run("node", ["--test", "tests/*.test.mjs"], { cwd: work, maxBuffer: 1024 * 1024 * 8, shell: true });
      stdout = res.stdout;
    } catch (err: unknown) {
      failed = true;
      stdout = String((err as { stdout?: string }).stdout ?? err);
    }
    const reportKey = await writeArtifact(ctx.runId, "测试报告.md", `# 测试报告 · ${ctx.requirement.title}\n\n\`\`\`\n${stdout}\n\`\`\`\n`);
    if (failed) {
      const m = stdout.match(/# fail (\d+)/) ?? stdout.match(/ℹ fail (\d+)/);
      throw Object.assign(new StageFailure(`测试未全部通过（${m?.[1] ?? "?"} failed），详见测试报告`), { reportKey });
    }
    const pass = stdout.match(/# pass (\d+)/)?.[1] ?? stdout.match(/ℹ pass (\d+)/)?.[1] ?? "?";
    return {
      summary: `全量测试通过（${pass} passed）`,
      artifacts: [{ name: "测试报告.md", kind: "report", storageKey: reportKey, meta: { passed: Number(pass) } }],
      tokens: { in: 2600, out: 320 },
    };
  }

  /* ---------- 验收对照：逐条核对标准（FR-D13/D14），未达成触发回溯 ---------- */
  private async acceptance(ctx: StageContext): Promise<StageOutput> {
    await sleep(1300);
    const updates: StageOutput["criteriaUpdates"] = [];
    const repairMode = wantsRepair(ctx.requirement.title) && ctx.repairRound === 0;

    for (const c of ctx.criteria) {
      if (c.verifyStage === "dev") {
        updates.push({ seq: c.seq, status: "achieved", evidence: "开发产物与实现计划一致（src/ 变更 + diff 已核对）" });
      } else if (c.verifyStage === "test_run") {
        if (repairMode) {
          updates.push({ seq: c.seq, status: "failed", evidence: "发现 orders 分页参数缺少校验用例 —— 触发回溯修复（FR-D14）" });
        } else {
          updates.push({ seq: c.seq, status: "achieved", evidence: "测试执行阶段全量通过，报告已归档" });
        }
      } else {
        updates.push({ seq: c.seq, status: "achieved", evidence: "PR 描述模板已在实现计划中预生成，交付阶段落实" });
      }
    }

    const report = [
      `# 验收报告 · ${ctx.requirement.title}`,
      "",
      ...ctx.criteria.map((c) => {
        const u = updates.find((x) => x.seq === c.seq)!;
        return `- [${u.status === "achieved" ? "✓" : "✗"}] ${c.content} — ${u.evidence ?? ""}`;
      }),
    ].join("\n");
    const key = await writeArtifact(ctx.runId, "验收报告.md", report);

    return {
      summary: repairMode
        ? "验收发现未达成项，已触发回溯修复"
        : `验收对照完成：${updates.filter((u) => u.status === "achieved").length}/${ctx.criteria.length} 达成`,
      artifacts: [{ name: "验收报告.md", kind: "report", storageKey: key }],
      criteriaUpdates: updates,
      tokens: { in: 8800, out: 1200 },
    };
  }

  /* ---------- 交付：摘要 + PR 描述 + 记忆提案（push/PR 由编排器执行） ---------- */
  private async delivery(ctx: StageContext): Promise<StageOutput> {
    await sleep(1100);
    const prBody = [
      `## 变更说明`,
      `Closes 需求 #${ctx.requirement.seq}：${ctx.requirement.title}`,
      "",
      ctx.confirmAnswer ? `- 技术选型（用户确认）：${ctx.confirmAnswer}` : "",
      `- 验收标准全部达成（详见验收报告）`,
      `- 本分支基于 \`${
        // 堆叠提示
        ctx.baseBranch
      }\`，请按队列顺序合并`,
      ""
    ]
      .filter(Boolean)
      .join("\n");
    const planEcho = await readArtifact(ctx.runId, "实现计划.md");

    return {
      summary: `PR #${ctx.nextPrNumber} 已开出（${ctx.branch} → ${ctx.baseBranch}），记忆提案 2 条待确认`,
      artifacts: [
        { name: `PR #${ctx.nextPrNumber}`, kind: "pr", meta: { body: prBody } },
        ...(planEcho ? [{ name: "实现计划.md", kind: "plan" as const }] : []),
      ],
      memoryProposals: [
        { type: "decision" as const, content: `「${ctx.requirement.title}」的实现方案：${ctx.confirmAnswer ?? "沿用项目既有模式，模块化单文件实现 + node:test 覆盖"}` },
        { type: "convention" as const, content: `新模块统一放在 src/<slug>.mjs，测试放 tests/<slug>.test.mjs，命名用需求 slug` },
      ],
      tokens: { in: 5100, out: 900 },
    };
  }
}
