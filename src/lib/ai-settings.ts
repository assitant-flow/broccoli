import { existsSync } from "node:fs";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import type { AiProtocol } from "./llm";

/**
 * 平台级 AI 接入设置（app_settings key=`ai:platform`）：
 * Base URL / 接口模式（anthropic|openai）/ 模型列表 / API Key。
 * 全平台共用——阶段与批次只选择「用列表里的哪个模型」，不再内置任何厂商模型名。
 * Token 以 AES-256-GCM 存储，界面只回显掩码。
 */

export type { AiProtocol };

export interface RawAiSettings {
  baseUrl?: string;
  protocol?: AiProtocol;
  /** 可用模型列表（顺序即默认优先级） */
  models?: string[];
  /** 显式默认模型；空则取 models[0] */
  defaultModel?: string;
  tokenCipher?: string;
  tokenNonce?: string;
  tokenHint?: string;
}

export interface PlatformAiConfig {
  baseUrl: string;
  protocol: AiProtocol;
  models: string[];
  defaultModel: string;
  key: string;
}

const PLATFORM_KEY = "ai:platform";
const AI_PREFIX = "ai:";

async function allAiRows() {
  const rows = await db.select().from(appSettings);
  return rows.filter((r) => r.key.startsWith(AI_PREFIX));
}

/** 读取原始设置；首次访问时把旧的 per-user 设置迁移为平台级 */
export async function getPlatformAiRaw(): Promise<RawAiSettings | null> {
  const rows = await allAiRows();
  const platform = rows.find((r) => r.key === PLATFORM_KEY);
  if (platform) return platform.value as RawAiSettings;

  const legacy = rows.find((r) => r.key !== PLATFORM_KEY && (r.value as RawAiSettings)?.tokenCipher);
  if (!legacy) return null;

  const old = legacy.value as RawAiSettings & { model?: string };
  const migrated: RawAiSettings = {
    baseUrl: old.baseUrl,
    protocol: "anthropic",
    models: old.model ? [old.model] : [],
    defaultModel: old.model,
    tokenCipher: old.tokenCipher,
    tokenNonce: old.tokenNonce,
    tokenHint: old.tokenHint,
  };
  await savePlatformAiRaw(migrated);
  await db.delete(appSettings).where(eq(appSettings.key, legacy.key));
  return migrated;
}

export async function savePlatformAiRaw(next: RawAiSettings): Promise<void> {
  const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, PLATFORM_KEY)).limit(1);
  if (existing) {
    await db.update(appSettings).set({ value: next as Record<string, unknown> }).where(eq(appSettings.key, PLATFORM_KEY));
  } else {
    await db.insert(appSettings).values({ key: PLATFORM_KEY, value: next as Record<string, unknown> });
  }
}

/** 解析默认模型：显式默认 > 模型列表首个 > 平台 env 模型（兼容旧部署） */
export function resolveDefaultModel(raw: RawAiSettings | null): string {
  if (raw?.defaultModel?.trim()) return raw.defaultModel.trim();
  const first = raw?.models?.find((m) => m.trim());
  if (first) return first.trim();
  return env.anthropicModel ?? "";
}

/** 引擎用：解密后的完整配置；无 token 返回 null（回落 Mock 或 BYO key） */
export async function loadPlatformAiConfig(): Promise<PlatformAiConfig | null> {
  const raw = await getPlatformAiRaw();
  if (!raw?.tokenCipher) return null;
  try {
    const key = decryptSecret(raw.tokenCipher).trim();
    if (!key) return null;
    return {
      baseUrl: raw.baseUrl?.trim() || env.anthropicBaseUrl,
      protocol: raw.protocol === "openai" ? "openai" : "anthropic",
      models: (raw.models ?? []).map((m) => m.trim()).filter(Boolean),
      defaultModel: resolveDefaultModel(raw),
      key,
    };
  } catch {
    return null;
  }
}

/** 平台 env 兜底配置（未在设置页配置时；共享凭证开启才可用） */
export function envPlatformAiConfig(): PlatformAiConfig | null {
  if (!env.sharedCredentials || !env.anthropicAuthToken) return null;
  return {
    baseUrl: env.anthropicBaseUrl,
    protocol: "anthropic",
    models: env.anthropicModel ? [env.anthropicModel] : [],
    defaultModel: env.anthropicModel ?? "",
    key: env.anthropicAuthToken,
  };
}

/**
 * baseUrl 容器化规范化：应用跑在容器内时，宿主回环地址（127.0.0.1/localhost）
 * 指向容器自身而非宿主 —— 自动重写为 host.docker.internal（host-gateway）。
 * 宿主/本地模式原样返回。
 */
export function normalizeBaseUrl(url: string): string {
  if (!url) return url;
  if (!existsSync("/.dockerenv")) return url;
  return url.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost)(?=[/:]|$)/, "$1host.docker.internal");
}
