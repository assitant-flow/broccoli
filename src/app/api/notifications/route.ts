import { db } from "@/db";
import { notificationEvents, requirements, projects, taskRuns } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok } from "@/lib/api";

/** 站内通知（FR-E5）：联表补全项目名 / 需求标题 / 需求序号，便于列表页直接定位 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await db
    .select({
      id: notificationEvents.id,
      type: notificationEvents.type,
      dedupeKey: notificationEvents.dedupeKey,
      runId: notificationEvents.runId,
      createdAt: notificationEvents.createdAt,
      reqTitle: requirements.title,
      reqSeq: requirements.seq,
      projectName: projects.name,
    })
    .from(notificationEvents)
    .leftJoin(taskRuns, eq(notificationEvents.runId, taskRuns.id))
    .leftJoin(requirements, eq(taskRuns.requirementId, requirements.id))
    .leftJoin(projects, eq(taskRuns.projectId, projects.id))
    .where(and(eq(notificationEvents.userId, user.id), eq(notificationEvents.status, "sent")))
    .orderBy(desc(notificationEvents.createdAt))
    .limit(50);
  return ok(rows);
}
