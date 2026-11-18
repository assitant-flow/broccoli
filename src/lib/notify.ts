import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { notificationEvents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { env } from "./env";

/**
 * 通知（FR-E4）：关键状态邮件 —— MVP 以 OutboxMailer 落盘 .data/outbox/ 模拟投递，
 * dedupeKey = runId:type 防重复轰炸（AC-E4）；生产换 SMTP/Resend 适配器。
 */

export type NotifyType = "wait_confirm" | "failed" | "suspended" | "completed";

export async function notify(params: {
  userId: string;
  type: NotifyType;
  runId: string;
  projectName: string;
  requirementTitle: string;
  requirementSeq: number;
  summary: string;
}): Promise<boolean> {
  const dedupeKey = `${params.runId}:${params.type}`;
  try {
    await db.insert(notificationEvents).values({ userId: params.userId, type: params.type, runId: params.runId, dedupeKey });
  } catch {
    return false; // 重复通知（AC-E4 防轰炸）
  }

  const dir = path.resolve(process.cwd(), env.dataDir, "outbox");
  await fs.mkdir(dir, { recursive: true });
  const titleMap: Record<NotifyType, string> = {
    wait_confirm: "⏸ 任务等待你的确认",
    failed: "✗ 任务执行失败",
    suspended: "💤 任务已挂起（快照超时）",
    completed: "✓ 任务完成 · PR 已开出",
  };
  const content = [
    `To: user-${params.userId}@broccoli.local`,
    `Subject: [Broccoli] ${titleMap[params.type]} · ${params.projectName} 需求 #${params.requirementSeq}`,
    "",
    titleMap[params.type],
    "",
    `项目：${params.projectName}`,
    `需求 #${params.requirementSeq}：${params.requirementTitle}`,
    `状态：${params.summary}`,
    "",
    `→ 处理：${env.siteUrl}/runs/${params.runId}`,
    "",
    "（MVP 演示：本邮件写入 outbox 模拟投递，生产环境接入 Resend/SMTP）",
  ].join("\n");
  await fs.writeFile(path.join(dir, `${Date.now()}-${params.type}-${params.runId.slice(0, 8)}.eml`), content);
  return true;
}

export async function listNotifications(userId: string, limit = 20) {
  return db
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.userId, userId))
    .orderBy(notificationEvents.createdAt)
    .limit(limit);
}
