import { db } from "@/db";
import { issues, projects, requirementBatches, requirements } from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { createRunForRequirement } from "@/lib/pipeline/orchestrator";

async function ownedProject(userId: string, id: string) {
  const [p] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, userId))).limit(1);
  return p ?? null;
}

/** Issues 列表（本地模拟 GitHub，FR-C4） */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const project = await ownedProject(user.id, id);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  const rows = await db.select().from(issues).where(eq(issues.projectId, id)).orderBy(asc(issues.number));
  return ok(rows);
}

/** 拉入队列（FR-C4）：issue → requirement，状态回写由交付阶段完成 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const project = await ownedProject(user.id, id);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  const { issueIds } = (await req.json()) as { issueIds: string[] };
  if (!issueIds?.length) return bad("issueIds 必填");

  const openIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, id), eq(issues.state, "open")));
  const targets = openIssues.filter((i) => issueIds.includes(i.id) && !i.syncedRequirementId);
  if (!targets.length) return bad("所选 issue 不可拉入（已关闭或已同步）");

  const [batch] = await db.insert(requirementBatches).values({ projectId: id, failurePolicy: project.failurePolicy }).returning();
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(seq), 0)::int` })
    .from(requirements)
    .where(eq(requirements.projectId, id));

  const created: string[] = [];
  for (const [i, issue] of targets.entries()) {
    const [req] = await db
      .insert(requirements)
      .values({ projectId: id, batchId: batch.id, seq: max + i + 1, title: issue.title, description: issue.body })
      .returning();
    await db.update(issues).set({ syncedRequirementId: req.id }).where(eq(issues.id, issue.id));
    await createRunForRequirement(req.id, id);
    created.push(req.id);
  }
  return ok({ created });
}
