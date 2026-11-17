import { db } from "@/db";
import { projects, requirements } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { skipRequirement } from "@/lib/pipeline/orchestrator";

async function ownedReq(userId: string, id: string) {
  const rows = await db
    .select({ req: requirements, project: projects })
    .from(requirements)
    .innerJoin(projects, eq(requirements.projectId, projects.id))
    .where(and(eq(requirements.id, id), eq(projects.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const found = await ownedReq(user.id, id);
  if (!found) return bad("需求不存在", 404, "NOT_FOUND");
  if (!["queued", "failed", "suspended", "cancelled"].includes(found.req.status)) {
    return bad("仅排队中 / 失败 / 挂起 / 已取消的需求可编辑（AC-C2）");
  }
  const body = (await req.json()) as { title?: string; description?: string };
  await db
    .update(requirements)
    .set({ ...(body.title ? { title: body.title } : {}), ...(body.description !== undefined ? { description: body.description } : {}) })
    .where(eq(requirements.id, id));
  return ok({ updated: id });
}

/** 跳过（失败处置，FR-D6） */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const found = await ownedReq(user.id, id);
  if (!found) return bad("需求不存在", 404, "NOT_FOUND");
  return ok(await skipRequirement(id));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const found = await ownedReq(user.id, id);
  if (!found) return bad("需求不存在", 404, "NOT_FOUND");
  if (found.req.status !== "queued") return bad("仅排队中的需求可删除");
  await db.delete(requirements).where(eq(requirements.id, id));
  return ok({ deleted: id });
}
