import { db } from "@/db";
import { credentials } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await db.select().from(credentials).where(eq(credentials.userId, user.id));
  return ok(
    rows.map((r) => ({
      provider: r.provider,
      hint: r.hint,
      lastVerifiedAt: r.lastVerifiedAt,
      configured: true,
    })),
  );
}

/** PUT：保存（加密落库 FR-H1，永不明文回显 AC-A2） */
export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { provider, secret } = (await req.json()) as { provider: string; secret: string };
  if (!["anthropic", "github"].includes(provider) || !secret) return bad("provider 与 secret 必填");
  const { ciphertext, nonce } = encryptSecret(secret);
  const hint = maskSecret(secret);
  const [existing] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.userId, user.id), eq(credentials.provider, provider)))
    .limit(1);
  if (existing) {
    await db.update(credentials).set({ ciphertext, nonce, hint }).where(eq(credentials.id, existing.id));
  } else {
    await db.insert(credentials).values({ userId: user.id, provider, ciphertext, nonce, hint });
  }
  return ok({ provider, hint });
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const provider = new URL(req.url).searchParams.get("provider");
  if (!provider) return bad("provider 必填");
  await db.delete(credentials).where(and(eq(credentials.userId, user.id), eq(credentials.provider, provider)));
  return ok({ deleted: provider });
}
