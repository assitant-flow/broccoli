import { db } from "@/db";
import { projects, runMessages, taskRuns } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { subscribeLogs } from "@/lib/pipeline/orchestrator";

/** 介入讨论（FR-E6）：任务详情页与 agent 的补充说明往来 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const msgs = await db.select().from(runMessages).where(eq(runMessages.runId, id)).orderBy(asc(runMessages.createdAt));
  return ok(msgs);
}

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
  const { text } = (await req.json()) as { text: string };
  if (!text?.trim()) return bad("内容必填");

  const [msg] = await db.insert(runMessages).values({ runId: id, role: "user", text: text.trim() }).returning();
  await db.insert(runMessages).values({
    runId: id,
    role: "agent",
    text: "已收到你的补充说明，将在后续阶段纳入执行上下文（开发/验收阶段生效）。",
  });
  void subscribeLogs;
  return ok(msg);
}
