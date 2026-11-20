import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";

/**
 * 用户 AI 接入设置读取（v2β）：存储于 app_settings key=`ai:${userId}`，
 * token AES-256-GCM 加密。供引擎与设置页共用。
 */
export type UserAiSettings = { key: string; baseUrl?: string; model?: string };

async function loadRaw(userId: string): Promise<{ baseUrl?: string; model?: string; tokenCipher?: string; tokenNonce?: string; tokenHint?: string } | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, `ai:${userId}`)).limit(1);
  return (row?.value as never) ?? null;
}

export async function loadUserAiSettings(userId: string): Promise<UserAiSettings | null> {
  const saved = await loadRaw(userId);
  if (!saved?.tokenCipher) return null;
  try {
    return { key: decryptSecret(saved.tokenCipher), baseUrl: saved.baseUrl, model: saved.model };
  } catch {
    return null;
  }
}

export async function saveUserAiSettings(userId: string, next: { baseUrl?: string; model?: string; tokenCipher?: string; tokenNonce?: string; tokenHint?: string }): Promise<void> {
  const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, `ai:${userId}`)).limit(1);
  if (existing) {
    await db.update(appSettings).set({ value: next as Record<string, unknown> }).where(eq(appSettings.key, `ai:${userId}`));
  } else {
    await db.insert(appSettings).values({ key: `ai:${userId}`, value: next as Record<string, unknown> });
  }
}

export async function getUserAiSettingsRaw(userId: string) {
  return loadRaw(userId);
}

/** 解密用户 AI Token（无则 null）——连通性测试与引擎共用 */
export async function getUserAiToken(userId: string): Promise<string | null> {
  const saved = await loadRaw(userId);
  if (!saved?.tokenCipher) return null;
  try {
    const key = decryptSecret(saved.tokenCipher).trim();
    return key || null;
  } catch {
    return null;
  }
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

import { existsSync } from "node:fs";
