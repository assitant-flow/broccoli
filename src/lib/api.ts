import { getSessionUser, type SessionUser } from "./auth";

export async function requireUser(): Promise<SessionUser | null> {
  return getSessionUser();
}

export function ok(data: unknown) {
  return Response.json(data as Record<string, unknown>);
}

export function bad(message: string, status = 400, code = "BAD_REQUEST") {
  return Response.json({ code, message }, { status });
}
