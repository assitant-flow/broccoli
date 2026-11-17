import { db } from "@/db";
import { projects, requirements, taskRuns, pullRequests } from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { terminateProjectQueue } from "@/lib/pipeline/orchestrator";

async function ownedProject(userId: string, id: string) {
  const [p] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, userId))).limit(1);
  return p ?? null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const project = await ownedProject(user.id, id);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  const reqs = await db.select().from(requirements).where(eq(requirements.projectId, id)).orderBy(asc(requirements.seq));
  const runs = reqs.length
    ? await db
        .select()
        .from(taskRuns)
        .where(and(eq(taskRuns.projectId, id), inArray(taskRuns.requirementId, reqs.map((r) => r.id))))
    : [];
  const prs = await db.select().from(pullRequests).where(eq(pullRequests.projectId, id)).orderBy(pullRequests.number);
  return ok({ project, requirements: reqs, runs, prs });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const project = await ownedProject(user.id, id);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  const body = (await req.json()) as { failurePolicy?: string; parallelStages?: boolean; defaultBranch?: string; settings?: Record<string, unknown> };
  const patch: Record<string, unknown> = {};
  if (body.failurePolicy) patch.failurePolicy = body.failurePolicy === "skip_continue" ? "skip_continue" : "pause";
  if (body.defaultBranch) patch.defaultBranch = body.defaultBranch;
  if (body.settings) patch.settings = { ...project.settings, ...body.settings };
  if (body.parallelStages !== undefined) {
    patch.settings = { ...(patch.settings as object ?? project.settings), parallelStages: body.parallelStages };
  }
  await db.update(projects).set(patch).where(eq(projects.id, id));
  return ok({ id, ...patch });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const project = await ownedProject(user.id, id);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  await terminateProjectQueue(id);
  await db.update(projects).set({ status: "deleted" }).where(eq(projects.id, id));
  return ok({ deleted: id });
}
