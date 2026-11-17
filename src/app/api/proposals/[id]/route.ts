import { db } from "@/db";
import { memoryProposals, memoryItems, memoryInjections, requirements, taskRuns } from "@/db/schema";
import { and, eq, inArray, desc } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { projects } from "@/db/schema";

async function ownedProposal(userId: string, id: string) {
  const rows = await db
    .select({ p: memoryProposals })
    .from(memoryProposals)
    .innerJoin(projects, eq(memoryProposals.projectId, projects.id))
    .where(and(eq(memoryProposals.id, id), eq(projects.userId, userId)))
    .limit(1);
  return rows[0]?.p ?? null;
}

/** 确认入库（FR-G4）：pending → confirmed → memory_items */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const p = await ownedProposal(user.id, id);
  if (!p) return bad("提案不存在", 404, "NOT_FOUND");
  if (p.status !== "pending") return bad("提案已处理");
  await db.update(memoryProposals).set({ status: "confirmed", decidedAt: new Date() }).where(eq(memoryProposals.id, id));
  const [item] = await db
    .insert(memoryItems)
    .values({ projectId: p.projectId, type: p.type, content: p.content, sourceProposalId: p.id })
    .returning();
  return ok({ proposal: p, item });
}

/** 否决（FR-G6/AC-G6）：依赖追溯 → 列出曾注入该提案的任务，由用户决定是否重新入队 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const p = await ownedProposal(user.id, id);
  if (!p) return bad("提案不存在", 404, "NOT_FOUND");

  const injections = await db.select().from(memoryInjections).where(eq(memoryInjections.proposalId, id));
  const targetRunIds = injections.map((i) => i.targetRunId);
  const impacted = targetRunIds.length
    ? await db
        .select({
          runId: taskRuns.id,
          runState: taskRuns.state,
          reqTitle: requirements.title,
          reqSeq: requirements.seq,
          reqStatus: requirements.status,
          requirementId: requirements.id,
        })
        .from(taskRuns)
        .innerJoin(requirements, eq(taskRuns.requirementId, requirements.id))
        .where(inArray(taskRuns.id, targetRunIds))
        .orderBy(desc(requirements.seq))
    : [];

  await db.update(memoryProposals).set({ status: "rejected", decidedAt: new Date() }).where(eq(memoryProposals.id, id));
  return ok({ rejected: id, impacted });
}

void memoryItems;
