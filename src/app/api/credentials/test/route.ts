import { db } from "@/db";
import { credentials } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";

/** 连通性测试（AC-A2）：anthropic → GET /v1/models；github → GET /user */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { provider, secret } = (await req.json()) as { provider: string; secret?: string };
  let key = secret ?? "";
  if (!key) {
    const [cred] = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.userId, user.id), eq(credentials.provider, provider)))
      .limit(1);
    if (!cred) return bad("未配置凭证");
    key = decryptSecret(cred.ciphertext);
  }

  try {
    if (provider === "anthropic") {
      // Anthropic 兼容端点（支持本地 router/代理）：以最小 messages 调用探测连通性
      const res = await fetch(`${env.anthropicBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          authorization: `Bearer ${key}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: (env.anthropicModel || "claude-haiku-4-5"),
          max_tokens: 16,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return ok({ ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` });
      const data = (await res.json()) as { model?: string; content?: { type: string }[] };
      return ok({ ok: true, models: [data.model ?? (env.anthropicModel || "claude-haiku-4-5")] });
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
