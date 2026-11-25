import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { signSession } from "@/lib/crypto";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { env } from "@/lib/env";
import { cookies } from "next/headers";

const DEMO_EMAIL = "thomas@broccoli.dev";

/**
 * 演示账号一键登录：仅本地模式且演示数据已种子化时可用。
 * 口令不下发到前端（旧版把固定口令写在登录页 JS 里），公网模式恒 404。
 */
export async function POST() {
  const notFound = () => Response.json({ code: "NOT_FOUND", message: "演示账号未启用" }, { status: 404 });
  if (env.mode !== "local" || !env.seedDemo) return notFound();
  const [user] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (!user) return notFound();
  const store = await cookies();
  store.set(SESSION_COOKIE, signSession({ uid: user.id }), sessionCookieOptions());
  return Response.json({ id: user.id, email: user.email, displayName: user.displayName });
}
