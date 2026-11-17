import { db } from "@/db";
import { projects, requirements, requirementBatches } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { createRunForRequirement } from "@/lib/pipeline/orchestrator";

/** 提交需求队列（FR-C1/C3）：一次多条，形成有序队列，批次记录失败策略 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");

  const { items, failurePolicy } = (await req.json()) as { items: string[]; failurePolicy?: string };
  const titles = (items ?? []).map((s) => s.trim()).filter(Boolean);
  if (!titles.length) return bad("至少一条需求");

  const policy = failurePolicy === "skip_continue" ? "skip_continue" : "pause";
  const [batch] = await db.insert(requirementBatches).values({ projectId: id, failurePolicy: policy }).returning();
  if (failurePolicy) {
    await db.update(projects).set({ failurePolicy: policy }).where(eq(projects.id, id));
  }
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(seq), 0)::int` })
    .from(requirements)
    .where(eq(requirements.projectId, id));

  // 依赖图语法（v2α）：行首 "@N " 表示依赖需求 #N
  const parsed = titles.map((t) => {
    const m = t.match(/^@(\d+)\s+(.*)$/);
    return m
      ? { title: m[2], dependsOnSeq: Number(m[1]) }
      : { title: t, dependsOnSeq: null as number | null };
  });

  const rows = await db
    .insert(requirements)
    .values(parsed.map((p, i) => ({ projectId: id, batchId: batch.id, seq: max + i + 1, title: p.title, dependsOnSeq: p.dependsOnSeq })))
    .returning();
  // 提交即建 TaskRun（排队中），调度器按串行/并发约束启动
  for (const r of rows) {
    await createRunForRequirement(r.id, id);
  }
  return ok({ batchId: batch.id, requirements: rows });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  const rows = await db.select().from(requirements).where(eq(requirements.projectId, id)).orderBy(requirements.seq);
  return ok(rows);
}
