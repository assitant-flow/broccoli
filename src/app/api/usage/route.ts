import { db } from "@/db";
import { usageRecords, taskRuns, requirements, projects } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok } from "@/lib/api";

/** 用量统计（FR-H4）：按 token / 阶段聚合 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const byStage = await db
    .select({
      runId: usageRecords.runId,
      reqTitle: requirements.title,
      reqSeq: requirements.seq,
      projectName: projects.name,
      inputTokens: sql<number>`sum(${usageRecords.inputTokens})::int`,
      outputTokens: sql<number>`sum(${usageRecords.outputTokens})::int`,
      containerSeconds: sql<number>`sum(${usageRecords.containerSeconds})::int`,
    })
    .from(usageRecords)
    .innerJoin(taskRuns, eq(usageRecords.runId, taskRuns.id))
    .innerJoin(requirements, eq(taskRuns.requirementId, requirements.id))
    .innerJoin(projects, eq(taskRuns.projectId, projects.id))
    .where(eq(usageRecords.userId, user.id))
    .groupBy(usageRecords.runId, requirements.title, requirements.seq, projects.name);
  const totals = byStage.reduce(
    (acc, r) => ({ in: acc.in + r.inputTokens, out: acc.out + r.outputTokens, seconds: acc.seconds + r.containerSeconds }),
    { in: 0, out: 0, seconds: 0 },
  );
  return ok({ totals, byRun: byStage });
}
