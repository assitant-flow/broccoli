import { db } from "@/db";
import { projects, pullRequests } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";

/** PR 列表（FR-F1）：本地模拟 origin 的堆叠 PR */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  const prs = await db.select().from(pullRequests).where(eq(pullRequests.projectId, id)).orderBy(asc(pullRequests.number));
  return ok(prs);
}
