import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifySession } from "./crypto";

export const SESSION_COOKIE = "broccoli_session";

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
