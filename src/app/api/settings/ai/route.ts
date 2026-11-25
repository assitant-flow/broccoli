import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getUserAiSettingsRaw, saveUserAiSettings } from "@/lib/ai-settings";

/**
 * AI 接入设置（v2β）：per-user 存储 Anthropic 兼容端点 / 模型 / Token。
 * 存储：app_settings key=`ai:${userId}`（token AES-256-GCM 加密，界面只回显掩码）。
 * 引擎优先级：用户接入设置 > 平台 env > 用户 BYO key(旧) > Mock。
 */

type AiSettings = { baseUrl?: string; model?: string; tokenCipher?: string; tokenNonce?: string; tokenHint?: string };

const load = (userId: string) => getUserAiSettingsRaw(userId);

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const saved = await load(user.id);
  return ok({
    baseUrl: saved?.baseUrl ?? env.anthropicBaseUrl,
    model: saved?.model ?? env.anthropicModel,
    tokenHint: saved?.tokenHint ?? null,
    hasToken: !!saved?.tokenCipher || (env.sharedCredentials && !!env.anthropicAuthToken),
    engine: env.engine,
    source: saved ? "user" : env.sharedCredentials && env.anthropicAuthToken ? "platform-env" : "credentials-or-mock",
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
  await saveUserAiSettings(user.id, next);
  void bad;
  return ok({ saved: true, baseUrl: next.baseUrl, model: next.model, tokenHint: next.tokenHint ?? null });
}
