import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { resolveStageModels, upsertStageModel, resetStageModels } from "@/lib/models";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { STAGE_TYPES, RECOMMENDED_MODELS } from "@/lib/env";
import type { StageType } from "@/lib/env";

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
  const models = await resolveStageModels(id);
  return ok({
    stages: STAGE_TYPES.map((t) => ({
      stageType: t,
      modelKey: models[t].key,
      source: models[t].source,
      recommendedKey: RECOMMENDED_MODELS[t],
    })),
    parallelStages: project.settings?.parallelStages !== false,
  });
}

/** 更新（FR-D17：自定义随项目保存） */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const project = await ownedProject(user.id, id);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  const body = (await req.json()) as { updates?: { stageType: StageType; modelKey: string }[]; parallelStages?: boolean };
  for (const u of body.updates ?? []) {
    if (!STAGE_TYPES.includes(u.stageType)) return bad(`未知阶段：${u.stageType}`);
    await upsertStageModel(id, u.stageType, u.modelKey, "custom");
  }
  if (body.parallelStages !== undefined) {
    await db
      .update(projects)
      .set({ settings: { ...project.settings, parallelStages: body.parallelStages } })
      .where(eq(projects.id, id));
  }
  return ok(await resolveStageModels(id));
}

/** 恢复全部推荐（AC-D17） */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const project = await ownedProject(user.id, id);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  await resetStageModels(id);
  return ok(await resolveStageModels(id));
}

void bad;
