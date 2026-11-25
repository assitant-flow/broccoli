import { db } from "@/db";
import { stageModelConfigs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { STAGE_TYPES, type StageType } from "./env";

export interface StageModel {
  key: string;
  source: "recommended" | "custom";
}

/** 解析某项目各阶段的模型：custom 为项目显式选择；其余为空 key（由平台默认模型补齐） */
export async function resolveStageModels(projectId: string): Promise<Record<StageType, StageModel>> {
  const rows = await db.select().from(stageModelConfigs).where(eq(stageModelConfigs.projectId, projectId));
  const out = {} as Record<StageType, StageModel>;
  for (const t of STAGE_TYPES) {
    // 只有 custom 行是有效配置；历史 recommended 行（旧内置模型名）一律视为未配置，
    // 由平台默认模型补齐——避免旧数据把厂商模型名带回展示
    const row = rows.find((r) => r.stageType === t && r.source === "custom");
    out[t] = row ? { key: row.modelKey, source: "custom" } : { key: "", source: "recommended" };
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

/** 清除单阶段自定义 → 该阶段跟随平台默认模型 */
export async function clearStageModel(projectId: string, stageType: StageType) {
  await db
    .delete(stageModelConfigs)
    .where(and(eq(stageModelConfigs.projectId, projectId), eq(stageModelConfigs.stageType, stageType)));
}

export async function resetStageModels(projectId: string) {
  await db.delete(stageModelConfigs).where(eq(stageModelConfigs.projectId, projectId));
}

/** 清理历史 recommended 行（模型不再内置；推荐位 = 平台默认模型，无需落行） */
export async function ensureStageModelDefaults(projectId: string) {
  await db
    .delete(stageModelConfigs)
    .where(and(eq(stageModelConfigs.projectId, projectId), eq(stageModelConfigs.source, "recommended")));
}
