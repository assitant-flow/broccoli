import { db } from "@/db";
import { projects, taskRuns } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { cancelRun, retryRequirement, skipRequirement, terminateProjectQueue } from "@/lib/pipeline/orchestrator";

/** 失败/取消处置聚合端点：action = cancel | retry | skip | terminate（FR-D6/AC-D6） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const rows = await db
    .select({ run: taskRuns })
    .from(taskRuns)
    .innerJoin(projects, eq(taskRuns.projectId, projects.id))
    .where(and(eq(taskRuns.id, id), eq(projects.userId, user.id)))
    .limit(1);
  if (!rows.length) return bad("任务不存在", 404, "NOT_FOUND");
  const run = rows[0].run;

  const { action } = (await req.json()) as { action: string };
  switch (action) {
    case "cancel":
      return ok(await cancelRun(id));
    case "retry":
      return ok(await retryRequirement(run.requirementId));
    case "skip":
      return ok(await skipRequirement(run.requirementId));
    case "terminate":
      return ok(await terminateProjectQueue(run.projectId));
    default:
      return bad("未知 action");
  }
}
