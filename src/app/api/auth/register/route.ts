import { db } from "@/db";
import { users } from "@/db/schema";
import { sql } from "drizzle-orm";
import { hashPassword, signSession } from "@/lib/crypto";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { env } from "@/lib/env";
import { clientIp, consumeRateLimit } from "@/lib/rate-limit";
import { cookies } from "next/headers";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  // 公网默认关闭自助注册（BROCCOLI_REGISTRATION=closed），账号由管理员开通
  if (env.registration !== "open") {
    return Response.json({ code: "REGISTRATION_CLOSED", message: "注册已关闭，请联系管理员开通账号" }, { status: 403 });
  }
  const limit = consumeRateLimit(`register:ip:${clientIp(req)}`, 10, 60 * 60_000);
  if (!limit.allowed) {
    return Response.json({ code: "RATE_LIMITED", message: "注册过于频繁，请稍后再试" }, { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } });
  }

  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; displayName?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return Response.json({ code: "INVALID", message: "邮箱格式不正确" }, { status: 400 });
  }
  if (password.length < 8) {
    return Response.json({ code: "INVALID", message: "密码至少 8 位" }, { status: 400 });
  }
  const [exists] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (exists) return Response.json({ code: "DUP", message: "该邮箱已注册" }, { status: 400 });

  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: hashPassword(password), displayName: body.displayName?.trim() || email.split("@")[0] })
    .returning();
  const store = await cookies();
  store.set(SESSION_COOKIE, signSession({ uid: user.id }), sessionCookieOptions());
  return Response.json({ id: user.id, email: user.email, displayName: user.displayName });
}
