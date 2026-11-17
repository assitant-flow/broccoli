import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword, signSession } from "@/lib/crypto";
import { SESSION_COOKIE } from "@/lib/auth";
import { cookies } from "next/headers";

export async function POST(req: Request) {
  const { email, password, displayName } = (await req.json()) as { email: string; password: string; displayName?: string };
  if (!email || !password || password.length < 6) {
    return Response.json({ code: "INVALID", message: "邮箱与密码（≥6 位）必填" }, { status: 400 });
  }
  const [exists] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (exists) return Response.json({ code: "DUP", message: "该邮箱已注册" }, { status: 400 });
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: hashPassword(password), displayName: displayName ?? email.split("@")[0] })
    .returning();
  const store = await cookies();
  store.set(SESSION_COOKIE, signSession({ uid: user.id }), { httpOnly: true, path: "/", sameSite: "lax", maxAge: 604800 });
  return Response.json({ id: user.id, email: user.email, displayName: user.displayName });
}
