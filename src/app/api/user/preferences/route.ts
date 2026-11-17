import { db } from "@/db";
import { memoryItems } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";

/** 用户级偏好记忆（v2α，FR-G10）：跨项目注入到该用户所有项目的任务上下文 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, user.id), eq(memoryItems.status, "confirmed")))
    .orderBy(desc(memoryItems.createdAt));
  return ok(rows);
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { content } = (await req.json()) as { content: string };
  if (!content?.trim()) return bad("内容必填");
  const [item] = await db
    .insert(memoryItems)
    .values({ projectId: null, userId: user.id, type: "convention", content: content.trim() })
    .returning();
  return ok(item);
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("id 必填");
  await db.delete(memoryItems).where(and(eq(memoryItems.id, id), eq(memoryItems.userId, user.id)));
  return ok({ deleted: id });
}
