import { db } from "@/db";
import { credentials } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { MockEngine } from "./mock";
import { ClaudeEngine } from "./claude";
import type { ExecutionEngine } from "./types";

/** 引擎选择（ExecutionTarget 抽象的进程内实现）：claude 需要用户 BYO key，否则回落 mock */
export async function getEngine(userId: string): Promise<ExecutionEngine> {
  if (env.engine === "claude") {
    const [cred] = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.userId, userId), eq(credentials.provider, "anthropic")))
      .limit(1);
    if (cred) {
      try {
        const key = decryptSecret(cred.ciphertext);
        if (key.startsWith("sk-ant-")) return new ClaudeEngine(key);
      } catch {
        /* 解密失败回落 mock */
      }
    }
  }
  return new MockEngine();
}
