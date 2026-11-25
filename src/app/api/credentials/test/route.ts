import { db } from "@/db";
import { credentials } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getUserAiToken, normalizeBaseUrl } from "@/lib/ai-settings";

/** 连通性测试（AC-A2）：anthropic → GET /v1/models；github → GET /user */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { provider, secret, baseUrl, model } = (await req.json()) as {
    provider: string; secret?: string; baseUrl?: string; model?: string;
  };

  // Token 解析优先级：请求显式 secret → 用户接入设置（app_settings）→ 旧 credentials → 平台 env
  let key = secret?.trim() ?? "";
  if (!key) key = (await getUserAiToken(user.id)) ?? "";
  if (!key && provider === "anthropic" && env.sharedCredentials) key = env.anthropicAuthToken ?? "";
  if (!key) {
    const [cred] = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.userId, user.id), eq(credentials.provider, provider)))
      .limit(1);
    if (cred) key = decryptSecret(cred.ciphertext);
  }
  if (!key) {
    return bad("未找到可用 Token：请先在接入设置中填写并保存，或配置平台 GITHUB/ANTHROPIC env");
  }

  try {
    if (provider === "anthropic") {
      // Anthropic 兼容端点（支持本地 router/代理）：以最小 messages 调用探测连通性
      // baseUrl/model 取请求参数（接入设置页传入）→ 平台 env 兜底
      const endpoint = normalizeBaseUrl((baseUrl ?? env.anthropicBaseUrl ?? "https://api.anthropic.com").replace(/\/$/, ""));
      const useModel = model || env.anthropicModel || "claude-haiku-4-5";
      const res = await fetch(`${endpoint}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          authorization: `Bearer ${key}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: 16,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 160);
        return ok({ ok: false, error: `HTTP ${res.status}: ${detail}` });
      }
      const data = (await res.json()) as { model?: string };
      return ok({ ok: true, models: [data.model ?? useModel] });
    }
    if (provider === "github") {
      const res = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${key}`, accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return ok({ ok: false, error: `HTTP ${res.status}` });
      const data = (await res.json()) as { login: string };
      return ok({ ok: true, login: data.login });
    }
    return bad("未知 provider");
  } catch (err) {
    return ok({ ok: false, error: String(err).slice(0, 200) });
  }
}
