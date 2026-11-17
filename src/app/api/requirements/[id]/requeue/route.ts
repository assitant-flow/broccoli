import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { retryRequirement } from "@/lib/pipeline/orchestrator";
import { db } from "@/db";
import { projects, requirements } from "@/db/schema";
import { and, eq } from "drizzle-orm";

/** 挂起/取消需求重新入队（AC-D5 挂起路径） */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const rows = await db
    .select({ req: requirements })
    .from(requirements)
    .innerJoin(projects, eq(requirements.projectId, projects.id))
    .where(and(eq(requirements.id, id), eq(projects.userId, user.id)))
    .limit(1);
  if (!rows.length) return bad("需求不存在", 404, "NOT_FOUND");
  return ok(await retryRequirement(id));
}
