import { db } from "@/db";
import { memoryItems, memoryProposals, projects } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok } from "@/lib/api";

/** 记忆库总览（v2β）：per-project 记忆计数聚合，供菜单「记忆库」页直达各项目 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const projs = await db.select().from(projects).where(and(eq(projects.userId, user.id), eq(projects.status, "active")));

  const out = [];
  let totalPending = 0;
  let totalConfirmed = 0;
  for (const p of projs) {
    const confirmed = await db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(and(eq(memoryItems.projectId, p.id), eq(memoryItems.status, "confirmed")));
    const disabled = await db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(and(eq(memoryItems.projectId, p.id), eq(memoryItems.status, "disabled")));
    const pending = await db
      .select({ id: memoryProposals.id })
      .from(memoryProposals)
      .where(and(eq(memoryProposals.projectId, p.id), eq(memoryProposals.status, "pending")));
    totalPending += pending.length;
    totalConfirmed += confirmed.length;
    out.push({
      projectId: p.id,
      projectName: p.name,
      repoFullName: p.repoFullName,
      confirmed: confirmed.length,
      pending: pending.length,
      disabled: disabled.length,
    });
  }
  return ok({ projects: out, totals: { pending: totalPending, confirmed: totalConfirmed } });
}
