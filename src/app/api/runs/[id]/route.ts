import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { getCanvas } from "@/lib/pipeline/orchestrator";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { db } from "@/db";

/** 执行画布聚合（FR-D16）：run + 6 阶段 + 子任务 + 验收标准 + 产物 + 日志 + PR */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const data = await getCanvas(id);
  if (!data || data.project?.userId !== user.id) return bad("任务不存在", 404, "NOT_FOUND");
  return ok(data);
}

void projects;
void eq;
void db;
