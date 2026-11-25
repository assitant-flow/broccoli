import { db } from "@/db";
import { credentials } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { envPlatformAiConfig, loadPlatformAiConfig } from "@/lib/ai-settings";
import { MockEngine } from "./mock";
import { ClaudeEngine } from "./claude";
import type { ExecutionEngine } from "./types";

/**
 * 引擎选择（ExecutionTarget 抽象的进程内实现）：
 * BROCCOLI_ENGINE=claude 时按以下顺序取接入配置——
 * ① 平台 AI 接入设置（设置页：Base URL / 接口模式 / 模型列表 / API Key，全平台共用）
 * ② 平台 env 兜底（共享凭证开启时）
 * ③ 用户 BYO key（credentials provider=anthropic，兼容旧数据）
 * 都没有则回落 MockEngine（离线演示）。
 */
export async function getEngine(userId: string): Promise<ExecutionEngine> {
  if (env.engine === "claude") {
    // ① 平台 AI 接入设置（全平台共用）
    const platform = await loadPlatformAiConfig();
    if (platform) return new ClaudeEngine(platform);
    // ② 平台 env 兜底（共享凭证开启时）
    const envCfg = envPlatformAiConfig();
    if (envCfg) return new ClaudeEngine(envCfg);
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
