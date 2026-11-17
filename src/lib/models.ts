import { db } from "@/db";
import { stageModelConfigs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { RECOMMENDED_MODELS, STAGE_TYPES, type StageType } from "./env";

export interface StageModel {
  key: string;
  source: "recommended" | "custom";
}

/** 解析某项目各阶段的模型（自定义 > 推荐，FR-D17） */
export async function resolveStageModels(projectId: string): Promise<Record<StageType, StageModel>> {
  const rows = await db.select().from(stageModelConfigs).where(eq(stageModelConfigs.projectId, projectId));
  const out = {} as Record<StageType, StageModel>;
  for (const t of STAGE_TYPES) {
    const row = rows.find((r) => r.stageType === t);
    out[t] = row
      ? { key: row.modelKey, source: row.source as StageModel["source"] }
      : { key: RECOMMENDED_MODELS[t], source: "recommended" };
  }
  return out;
}

export async function upsertStageModel(projectId: string, stageType: StageType, modelKey: string, source: "recommended" | "custom") {
  const [existing] = await db
    .select()
    .from(stageModelConfigs)
    .where(and(eq(stageModelConfigs.projectId, projectId), eq(stageModelConfigs.stageType, stageType)))
    .limit(1);
  if (existing) {
    await db
      .update(stageModelConfigs)
      .set({ modelKey, source, updatedAt: new Date() })
      .where(eq(stageModelConfigs.id, existing.id));
  } else {
    await db.insert(stageModelConfigs).values({ projectId, stageType, modelKey, source });
  }
}

export async function resetStageModels(projectId: string) {
  await db.delete(stageModelConfigs).where(eq(stageModelConfigs.projectId, projectId));
}

export async function ensureStageModelDefaults(projectId: string) {
  const rows = await db.select().from(stageModelConfigs).where(eq(stageModelConfigs.projectId, projectId));
  for (const t of STAGE_TYPES) {
    if (!rows.find((r) => r.stageType === t)) {
      await db.insert(stageModelConfigs).values({ projectId, stageType: t, modelKey: RECOMMENDED_MODELS[t], source: "recommended" });
    }
  }
}
