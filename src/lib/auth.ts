import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifySession } from "./crypto";
import { env } from "./env";

export const SESSION_COOKIE = "broccoli_session";

/** 会话 Cookie 选项：站点为 https 时强制 Secure（本地 http 预演不设，否则浏览器不回传） */
export function sessionCookieOptions(maxAge = 60 * 60 * 24 * 7) {
  return { httpOnly: true, path: "/", sameSite: "lax" as const, secure: env.siteUrl.startsWith("https://"), maxAge };
}

export type SessionUser = { id: string; email: string; displayName: string };

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const payload = verifySession<{ uid: string; exp: number }>(store.get(SESSION_COOKIE)?.value);
  if (!payload) return null;
  const [user] = await db.select().from(users).where(eq(users.id, payload.uid)).limit(1);
  if (!user) return null;
  return { id: user.id, email: user.email, displayName: user.displayName };
}

/** API 路由用的未认证响应 */
export function unauthorized() {
  return Response.json({ code: "UNAUTHORIZED", message: "未登录或会话过期" }, { status: 401 });
}
