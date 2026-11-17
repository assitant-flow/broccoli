import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyPassword, signSession } from "@/lib/crypto";
import { SESSION_COOKIE } from "@/lib/auth";
import { cookies } from "next/headers";

export async function POST(req: Request) {
  const { email, password } = (await req.json()) as { email: string; password: string };
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return Response.json({ code: "INVALID", message: "邮箱或密码错误" }, { status: 401 });
  }
  const store = await cookies();
  store.set(SESSION_COOKIE, signSession({ uid: user.id }), { httpOnly: true, path: "/", sameSite: "lax", maxAge: 604800 });
  return Response.json({ id: user.id, email: user.email, displayName: user.displayName });
}
