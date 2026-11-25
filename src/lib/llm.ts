/**
 * 统一 LLM 调用层（平台 AI 接入）：按「接口模式」分流到两种协议。
 * - anthropic：POST {baseUrl}/v1/messages（官方 Anthropic 与各类兼容网关）
 * - openai：POST {baseUrl}/v1/chat/completions（OpenAI 兼容：官方、vLLM、router、LiteLLM 等）
 * 只做单次调用与协议解析；重试与业务错误包装由调用方决定。
 */
import { normalizeBaseUrl } from "./ai-settings";

export type AiProtocol = "anthropic" | "openai";

export interface LlmTarget {
  baseUrl: string;
  protocol: AiProtocol;
  key: string;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`HTTP ${status}: ${detail}`);
    this.name = "LlmHttpError";
  }
}

function endpoint(baseUrl: string, protocol: AiProtocol): string {
  const root = normalizeBaseUrl(baseUrl).replace(/\/$/, "");
  return protocol === "openai" ? `${root}/v1/chat/completions` : `${root}/v1/messages`;
}

export async function chatOnce(
  target: LlmTarget,
  model: string,
  system: string,
  messages: LlmMessage[],
  maxTokens = 4000,
): Promise<string> {
  const url = endpoint(target.baseUrl, target.protocol);
  const res =
    target.protocol === "openai"
      ? await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${target.key}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: "system", content: system }, ...messages],
          }),
          signal: AbortSignal.timeout(180000),
        })
      : await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": target.key,
            authorization: `Bearer ${target.key}`,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
          signal: AbortSignal.timeout(180000),
        });

  if (!res.ok) throw new LlmHttpError(res.status, (await res.text()).slice(0, 300));

  if (target.protocol === "openai") {
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | { type?: string; text?: string }[] } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("\n");
    return "";
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

/** 拉取端点模型列表（GET {baseUrl}/v1/models）：用于设置页一键填充 */
export async function listModels(baseUrl: string, key: string): Promise<string[]> {
  const root = normalizeBaseUrl(baseUrl).replace(/\/$/, "");
  const res = await fetch(`${root}/v1/models`, {
    headers: { authorization: `Bearer ${key}`, "x-api-key": key },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new LlmHttpError(res.status, (await res.text()).slice(0, 200));
  const data = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] };
  const ids = (data.data ?? data.models ?? []).map((m) => m.id ?? ("name" in m ? m.name : undefined)).filter((s): s is string => !!s);
  return [...new Set(ids)];
}
