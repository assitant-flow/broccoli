import { db } from "@/db";
import { projects, requirements, taskRuns, containerLeases, pullRequests } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";

/** 全局仪表盘聚合（FR-E1/E2：跨项目进度 + 全局状态计数 + 异常置顶 + 活动） */
export async function dashboardData(userId: string) {
  const projs = await db.select().from(projects).where(and(eq(projects.userId, userId), eq(projects.status, "active")));
  const projectCards = [];
  const alerts: Record<string, unknown>[] = [];

  for (const p of projs) {
    const reqs = await db.select().from(requirements).where(eq(requirements.projectId, p.id)).orderBy(requirements.seq);
    const runs = await db.select().from(taskRuns).where(eq(taskRuns.projectId, p.id));
    const latestByReq = new Map<string, (typeof taskRuns.$inferSelect)>();
    for (const r of runs) latestByReq.set(r.requirementId, r);

    const activeReq = reqs.find((r) => r.status === "active");
    let active: Record<string, unknown> | null = null;
    if (activeReq) {
      const run = latestByReq.get(activeReq.id);
      active = run
        ? {
            runId: run.id,
            reqSeq: activeReq.seq,
            reqTitle: activeReq.title,
            state: run.state,
            currentStage: run.currentStage,
            confirmQuestion: run.confirmQuestion,
          }
        : null;
    }

    // 异常置顶：等待确认 + 失败（FR-E2）
    for (const r of runs) {
      if (r.state === "wait_confirm") {
        const req = reqs.find((x) => x.id === r.requirementId);
        alerts.push({
          kind: "wait_confirm",
          runId: r.id,
          projectId: p.id,
          projectName: p.name,
          reqSeq: req?.seq,
          reqTitle: req?.title,
          question: r.confirmQuestion?.question,
          confirmExpiresAt: r.confirmExpiresAt,
        });
      }
    }
    const failedReq = reqs.find((r) => r.status === "failed");
    if (failedReq) {
      const run = latestByReq.get(failedReq.id);
      alerts.push({
        kind: "failed",
        runId: run?.id,
        projectId: p.id,
        projectName: p.name,
        reqSeq: failedReq.seq,
        reqTitle: failedReq.title,
        error: run?.error,
        failurePolicy: p.failurePolicy,
      });
    }

    projectCards.push({
      id: p.id,
      name: p.name,
      repoFullName: p.repoFullName,
      defaultBranch: p.defaultBranch,
      failurePolicy: p.failurePolicy,
      lastSuccessBranch: p.lastSuccessBranch,
      progress: { done: reqs.filter((r) => r.status === "done").length, total: reqs.length },
      stageDots: reqs.map((r) => {
        const run = latestByReq.get(r.id);
        return { status: r.status, runState: run?.state ?? null };
      }),
      active,
      queued: reqs.filter((r) => r.status === "queued").length,
      failedReq: failedReq ? { seq: failedReq.seq, title: failedReq.title } : null,
      openPrs: (await db.select({ count: sql<number>`count(*)::int` }).from(pullRequests).where(eq(pullRequests.projectId, p.id)))[0].count,
    });
  }

  const [leases] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(containerLeases)
    .where(and(eq(containerLeases.userId, userId), sql`${containerLeases.state} <> 'released'`));

  const recentRuns = await db
    .select({
      id: taskRuns.id,
      state: taskRuns.state,
      currentStage: taskRuns.currentStage,
      endedAt: taskRuns.endedAt,
      createdAt: taskRuns.createdAt,
      reqTitle: requirements.title,
      reqSeq: requirements.seq,
      projectName: projects.name,
    })
    .from(taskRuns)
    .innerJoin(requirements, eq(taskRuns.requirementId, requirements.id))
    .innerJoin(projects, eq(taskRuns.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .orderBy(sql`${taskRuns.createdAt} desc`)
    .limit(8);

  const allReqs = await db
    .select({ status: requirements.status })
    .from(requirements)
    .innerJoin(projects, eq(requirements.projectId, projects.id))
    .where(eq(projects.userId, userId));

  const runsToday = await db
    .select({ state: taskRuns.state, endedAt: taskRuns.endedAt })
    .from(taskRuns)
    .innerJoin(projects, eq(taskRuns.projectId, projects.id))
    .where(and(eq(projects.userId, userId), sql`${taskRuns.state} = 'completed'`));

  return {
    projects: projectCards,
    alerts,
    stats: {
      running: leases.count,
      waitConfirm: alerts.filter((a) => a.kind === "wait_confirm").length,
      failed: allReqs.filter((r) => r.status === "failed").length,
      queued: allReqs.filter((r) => r.status === "queued").length,
      doneToday: runsToday.filter((r) => r.endedAt && r.endedAt.getTime() > Date.now() - 86400_000).length,
      maxConcurrency: Number(process.env.BROCCOLI_MAX_CONCURRENCY ?? 2),
    },
    recentRuns,
  };
}
