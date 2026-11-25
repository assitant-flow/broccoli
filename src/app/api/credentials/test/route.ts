import { db } from "@/db";
import { credentials } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getPlatformAiRaw, normalizeBaseUrl } from "@/lib/ai-settings";
import { chatOnce, type AiProtocol } from "@/lib/llm";

/** 连通性测试（AC-A2）：anthropic → GET /v1/models；github → GET /user */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { provider, secret, baseUrl, model, protocol } = (await req.json()) as {
    provider: string; secret?: string; baseUrl?: string; model?: string; protocol?: AiProtocol;
  };

  // Token 解析优先级：请求显式 secret → 平台 AI 接入设置 → 旧 credentials → 平台 env
  const platform = await getPlatformAiRaw();
  let key = secret?.trim() ?? "";
  if (!key && platform?.tokenCipher) {
    try {
      key = decryptSecret(platform.tokenCipher).trim();
    } catch {
      key = "";
    }
  }
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
      // 平台 AI 接入：按所选接口模式发一次最小请求探测连通性
      const useProtocol: AiProtocol = protocol ?? platform?.protocol ?? "anthropic";
      const endpoint = normalizeBaseUrl((baseUrl ?? platform?.baseUrl ?? env.anthropicBaseUrl ?? "https://api.anthropic.com").replace(/\/$/, ""));
      const useModel = model || platform?.defaultModel || platform?.models?.[0] || env.anthropicModel || "";
      if (!useModel) return bad("未配置模型：请先在平台 AI 接入中填写模型列表");
      try {
        const reply = await chatOnce({ baseUrl: endpoint, protocol: useProtocol, key }, useModel, "你是连通性探测助手。", [{ role: "user", content: "ping" }], 16);
        return ok({ ok: true, models: [useModel], protocol: useProtocol, sample: reply.slice(0, 40) });
      } catch (err) {
        return ok({ ok: false, error: explainLlmError(err) });
      }
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

/** 把协议层错误翻译成可操作的诊断（避免直接把上游 JSON 甩给用户） */
function explainLlmError(err: unknown): string {
  const msg = String((err as Error).message ?? err);
  const status = (err as { status?: number }).status ?? Number(msg.match(/HTTP (\d{3})/)?.[1] ?? 0);
  if (status === 401 || status === 403) return `${msg.slice(0, 120)} —— 鉴权失败：检查 API Key（以及接口模式是否与该端点匹配）`;
  if (status === 429) return `${msg.slice(0, 160)} —— 上游限流或配额用尽：检查账户额度，或稍后重试`;
  if (status === 404) return `${msg.slice(0, 120)} —— 路径不存在：检查 Base URL 是否正确，以及接口模式（Anthropic /v1/messages vs OpenAI /v1/chat/completions）`;
  if (status >= 500) return `${msg.slice(0, 120)} —— 上游服务异常：稍后重试或联系端点提供方`;
  return msg.slice(0, 200);
}
