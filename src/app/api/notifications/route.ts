import { db } from "@/db";
import { notificationEvents } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok } from "@/lib/api";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await db
    .select()
    .from(notificationEvents)
    .where(and(eq(notificationEvents.userId, user.id), eq(notificationEvents.status, "sent")))
    .orderBy(desc(notificationEvents.createdAt))
    .limit(20);
  return ok(rows);
}
