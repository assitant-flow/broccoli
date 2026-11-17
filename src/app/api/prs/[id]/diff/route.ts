import { db } from "@/db";
import { projects, pullRequests } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth";
import { diffPatch } from "@/lib/git";

/** PR 真实 diff（本地 git，AC-F1/FR-D8） */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  const rows = await db
    .select({ pr: pullRequests, project: projects })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(eq(pullRequests.id, id), eq(projects.userId, user.id)))
    .limit(1);
  if (!rows.length) return new Response("not found", { status: 404 });
  const pr = rows[0].pr;
  const patch = await diffPatch(rows[0].project.id, pr.baseBranch, pr.branch);
  return new Response(patch || "// 无差异", { headers: { "content-type": "text/plain; charset=utf-8" } });
}
