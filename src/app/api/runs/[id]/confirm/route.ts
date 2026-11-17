import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { applyConfirm } from "@/lib/pipeline/orchestrator";
import { db } from "@/db";
import { projects, taskRuns } from "@/db/schema";
import { and, eq } from "drizzle-orm";

/** 用户作答确认（FR-D4/AC-D4）：一次性链接 / 详情页直达 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const rows = await db
    .select({ runId: taskRuns.id })
    .from(taskRuns)
    .innerJoin(projects, eq(taskRuns.projectId, projects.id))
    .where(and(eq(taskRuns.id, id), eq(projects.userId, user.id)))
    .limit(1);
  if (!rows.length) return bad("任务不存在", 404, "NOT_FOUND");

  const { answer, optionKey } = (await req.json()) as { answer?: string; optionKey?: string };
  if (!answer && !optionKey) return bad("回答内容或选项必填");
  return ok(await applyConfirm(id, answer ?? optionKey ?? "", optionKey));
}
