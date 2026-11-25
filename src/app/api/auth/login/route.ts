import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { sql } from "drizzle-orm";
import { hashPassword, verifyPassword, signSession } from "@/lib/crypto";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { clientIp, consumeRateLimit, peekRateLimit } from "@/lib/rate-limit";

const WINDOW_MS = 15 * 60_000;

/** 用户不存在时也走一次 scrypt，避免按响应耗时枚举已注册邮箱 */
let dummyHash: string | null = null;
function dummyPasswordHash(): string {
  return (dummyHash ??= hashPassword("broccoli-timing-pad"));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  // 限流：仅统计失败尝试——同一 IP 15 分钟内 30 次失败、同一账号 8 次失败后拒绝登录
  // （成功登录不占额度，脚本与多设备的正常登录不会被误伤）
  const ipKey = `login:ip:${clientIp(req)}`;
  const acctKey = `login:acct:${email}`;
  const blocked = [peekRateLimit(ipKey, 30, WINDOW_MS), peekRateLimit(acctKey, 8, WINDOW_MS)].find((r) => !r.allowed);
  if (blocked) {
    return Response.json(
      { code: "RATE_LIMITED", message: "尝试过于频繁，请稍后再试" },
      { status: 429, headers: { "retry-after": String(blocked.retryAfterSec) } },
    );
  }

  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  const passwordOk = verifyPassword(password, user ? user.passwordHash : dummyPasswordHash());
  if (!user || !passwordOk) {
    consumeRateLimit(ipKey, 30, WINDOW_MS);
    consumeRateLimit(acctKey, 8, WINDOW_MS);
    return Response.json({ code: "INVALID", message: "邮箱或密码错误" }, { status: 401 });
  }
  const store = await cookies();
  store.set(SESSION_COOKIE, signSession({ uid: user.id }), sessionCookieOptions());
  return Response.json({ id: user.id, email: user.email, displayName: user.displayName });
}
