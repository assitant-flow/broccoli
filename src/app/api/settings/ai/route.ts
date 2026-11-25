import { db } from "@/db";
import { users } from "@/db/schema";
import { asc } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import {
  getPlatformAiRaw,
  resolveDefaultModel,
  savePlatformAiRaw,
  type AiProtocol,
} from "@/lib/ai-settings";
import { listModels } from "@/lib/llm";

/**
 * 平台级 AI 接入设置（全平台共用）：
 * Base URL / 接口模式 / 模型列表 / API Key。写操作仅限平台所有者（首个账号）。
 * Token 只回显掩码；提交空 token 表示保持不变。
 */

async function requireOwner(): Promise<{ error: Response } | { ok: true }> {
  const user = await getSessionUser();
  if (!user) return { error: unauthorized() };
  const [owner] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  if (owner && owner.id !== user.id) {
    return { error: Response.json({ code: "FORBIDDEN", message: "只有平台所有者可以修改 AI 接入设置" }, { status: 403 }) };
  }
  return { ok: true };
}

function tokenFromCipher(cipher: string | undefined): string {
  if (!cipher) return "";
  try {
    return decryptSecret(cipher).trim();
  } catch {
    return "";
  }
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const raw = await getPlatformAiRaw();
  return ok({
    baseUrl: raw?.baseUrl ?? env.anthropicBaseUrl,
    protocol: (raw?.protocol ?? "anthropic") as AiProtocol,
    models: raw?.models ?? [],
    defaultModel: resolveDefaultModel(raw),
    tokenHint: raw?.tokenHint ?? null,
    hasToken: !!raw?.tokenCipher,
    /** 未配置时是否可用平台 env 兜底 */
    envFallback: !!env.anthropicAuthToken,
    engine: env.engine,
  });
}

export async function PUT(req: Request) {
  const gate = await requireOwner();
  if ("error" in gate) return gate.error;

  const body = (await req.json().catch(() => ({}))) as {
    baseUrl?: string;
    protocol?: AiProtocol;
    models?: string[];
    defaultModel?: string;
    token?: string;
    clearToken?: boolean;
  };
  const saved = await getPlatformAiRaw();
  const models = (body.models ?? saved?.models ?? []).map((m) => m.trim()).filter(Boolean);
  const defaultModel = (body.defaultModel ?? saved?.defaultModel ?? "").trim();
  if (defaultModel && models.length > 0 && !models.includes(defaultModel)) {
    return bad("默认模型必须在模型列表中");
  }

  const next: Parameters<typeof savePlatformAiRaw>[0] = {
    baseUrl: body.baseUrl?.trim() || saved?.baseUrl || "",
    protocol: body.protocol === "openai" ? "openai" : "anthropic",
    models,
    defaultModel,
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
  await savePlatformAiRaw(next);
  return ok({ saved: true, baseUrl: next.baseUrl, protocol: next.protocol, models, defaultModel, tokenHint: next.tokenHint ?? null });
}

/** 从端点拉取模型列表（GET {baseUrl}/v1/models），用于一键填充 */
export async function POST(req: Request) {
  const gate = await requireOwner();
  if ("error" in gate) return gate.error;
  const body = (await req.json().catch(() => ({}))) as { baseUrl?: string; token?: string };
  const saved = await getPlatformAiRaw();
  const baseUrl = body.baseUrl?.trim() || saved?.baseUrl || env.anthropicBaseUrl;
  const token = body.token?.trim() || tokenFromCipher(saved?.tokenCipher) || (env.sharedCredentials ? env.anthropicAuthToken : "");
  if (!token) return bad("请先填写并保存 API Key，或本次输入密钥后再拉取");
  try {
    const models = await listModels(baseUrl, token);
    if (models.length === 0) return bad("端点未返回任何模型");
    return ok({ models });
  } catch (err) {
    return bad(`拉取模型失败：${String((err as Error).message).slice(0, 200)}`);
  }
}
