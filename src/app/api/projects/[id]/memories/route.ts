import { db } from "@/db";
import { memoryItems, memoryProposals, memoryInjections, projects } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";

/** 记忆库（FR-G1/G4/G5/G6）：已确认记忆 + 待确认提案 + 注入依赖 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");

  const items = await db.select().from(memoryItems).where(eq(memoryItems.projectId, id)).orderBy(desc(memoryItems.createdAt));
  const proposals = await db
    .select()
    .from(memoryProposals)
    .where(eq(memoryProposals.projectId, id))
    .orderBy(desc(memoryProposals.createdAt));
  const proposalIds = proposals.map((p) => p.id);
  const injections = proposalIds.length
    ? await db.select().from(memoryInjections).where(inArray(memoryInjections.proposalId, proposalIds))
    : [];
  const injectedCount = (proposalId: string) => injections.filter((i) => i.proposalId === proposalId).length;
  return ok({
    items,
    proposals: proposals.map((p) => ({ ...p, injectedCount: injectedCount(p.id) })),
  });
}

/** 批量确认当日提案（AC-G4） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");

  const { proposalIds } = (await req.json()) as { proposalIds?: string[] };
  const pending = await db
    .select()
    .from(memoryProposals)
    .where(and(eq(memoryProposals.projectId, id), eq(memoryProposals.status, "pending")));
  const targets = proposalIds?.length ? pending.filter((p) => proposalIds.includes(p.id)) : pending;

  for (const p of targets) {
    await db
      .update(memoryProposals)
      .set({ status: "confirmed", decidedAt: new Date() })
      .where(eq(memoryProposals.id, p.id));
    await db.insert(memoryItems).values({
      projectId: id,
      type: p.type,
      content: p.content,
      sourceProposalId: p.id,
    });
  }
  return ok({ confirmed: targets.length });
}
