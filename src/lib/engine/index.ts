import { db } from "@/db";
import { credentials } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { MockEngine } from "./mock";
import { ClaudeEngine } from "./claude";
import type { ExecutionEngine } from "./types";

/**
 * 引擎选择（ExecutionTarget 抽象的进程内实现）：
 * BROCCOLI_ENGINE=claude 时优先用平台级 token（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY），
 * 其次用户 BYO key（任意非空 token，兼容官方 sk-ant-* 与 router token）；
 * 都没有则回落 MockEngine（离线演示）。
 */
export async function getEngine(userId: string): Promise<ExecutionEngine> {
  if (env.engine === "claude") {
    // ① 用户接入设置（v2β /settings/ai：per-user baseUrl/model/token）
    const { loadUserAiSettings } = await import("@/app/api/settings/ai/route");
    const userAi = await loadUserAiSettings(userId);
    if (userAi) return new ClaudeEngine(userAi);
    // ② 平台级 env token
    if (env.anthropicAuthToken) return new ClaudeEngine({ key: env.anthropicAuthToken });
    // ③ 旧 BYO key（credentials provider=anthropic）
    const [cred] = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.userId, userId), eq(credentials.provider, "anthropic")))
      .limit(1);
    if (cred) {
      try {
        const key = decryptSecret(cred.ciphertext);
        if (key.trim()) return new ClaudeEngine({ key });
      } catch {
        /* 解密失败回落 mock */
      }
    }
  }
  return new MockEngine();
}
