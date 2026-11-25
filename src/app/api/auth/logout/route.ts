import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { cookies } from "next/headers";

export async function POST() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return Response.json({ ok: true });
}
