import { db } from "@/db";
import { memoryItems, projects } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";

async function ownedItem(userId: string, id: string) {
  const rows = await db
    .select({ item: memoryItems })
    .from(memoryItems)
    .innerJoin(projects, eq(memoryItems.projectId, projects.id))
    .where(and(eq(memoryItems.id, id), eq(projects.userId, userId)))
    .limit(1);
  return rows[0]?.item ?? null;
}

/** 编辑（生成新版本，AC-G5） */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const item = await ownedItem(user.id, id);
  if (!item) return bad("记忆不存在", 404, "NOT_FOUND");
  const body = (await req.json()) as { content?: string; status?: string };
  await db
    .update(memoryItems)
    .set({
      ...(body.content ? { content: body.content, version: item.version + 1 } : {}),
      ...(body.status ? { status: body.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(memoryItems.id, id));
  return ok({ updated: id, version: body.content ? item.version + 1 : item.version });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const item = await ownedItem(user.id, id);
  if (!item) return bad("记忆不存在", 404, "NOT_FOUND");
  await db.delete(memoryItems).where(eq(memoryItems.id, id));
  return ok({ deleted: id });
}
