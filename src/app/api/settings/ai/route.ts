import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * AI 接入设置（v2β）：per-user 存储 Anthropic 兼容端点 / 模型 / Token。
 * 存储：app_settings key=`ai:${userId}`（token AES-256-GCM 加密，界面只回显掩码）。
 * 引擎优先级：用户接入设置 > 平台 env > 用户 BYO key(旧) > Mock。
 */

type AiSettings = { baseUrl?: string; model?: string; tokenCipher?: string; tokenNonce?: string; tokenHint?: string };

async function load(userId: string): Promise<AiSettings | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, `ai:${userId}`)).limit(1);
  return (row?.value as AiSettings) ?? null;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const saved = await load(user.id);
  return ok({
    baseUrl: saved?.baseUrl ?? env.anthropicBaseUrl,
    model: saved?.model ?? env.anthropicModel,
    tokenHint: saved?.tokenHint ?? null,
    hasToken: !!saved?.tokenCipher || !!env.anthropicAuthToken,
    engine: env.engine,
    source: saved ? "user" : env.anthropicAuthToken ? "platform-env" : "credentials-or-mock",
  });
}

export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json()) as { baseUrl?: string; model?: string; token?: string; clearToken?: boolean };
  const saved = await load(user.id);
  const next: AiSettings = {
    baseUrl: body.baseUrl?.trim() || saved?.baseUrl,
    model: body.model?.trim() || saved?.model,
    tokenCipher: saved?.tokenCipher,
    tokenNonce: saved?.tokenNonce,
    tokenHint: saved?.tokenHint,
  };
  if (body.clearToken) {
    next.tokenCipher = undefined;
    next.tokenNonce = undefined;
    next.tokenHint = undefined;
  } else if (body.token?.trim()) {
    const { ciphertext, nonce } = encryptSecret(body.token.trim());
    next.tokenCipher = ciphertext;
    next.tokenNonce = nonce;
    next.tokenHint = maskSecret(body.token.trim());
  }
  const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, `ai:${user.id}`)).limit(1);
  if (existing) {
    await db.update(appSettings).set({ value: next as Record<string, unknown> }).where(eq(appSettings.key, `ai:${user.id}`));
  } else {
    await db.insert(appSettings).values({ key: `ai:${user.id}`, value: next as Record<string, unknown> });
  }
  void bad;
  return ok({ saved: true, baseUrl: next.baseUrl, model: next.model, tokenHint: next.tokenHint ?? null });
}

/** 供引擎读取（宿主/容器同进程）：解密后的用户 AI 设置 */
export async function loadUserAiSettings(userId: string): Promise<{ key: string; baseUrl?: string; model?: string } | null> {
  const saved = await load(userId);
  if (!saved?.tokenCipher) return null;
  try {
    const { decryptSecret } = await import("@/lib/crypto");
    return { key: decryptSecret(saved.tokenCipher), baseUrl: saved.baseUrl, model: saved.model };
  } catch {
    return null;
  }
}
