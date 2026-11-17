import { db } from "@/db";
import { requirements } from "@/db/schema";
import { eq, inArray, and } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { projects } from "@/db/schema";

/** 队列调整顺序（FR-C2）：仅对排队中的需求生效 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return bad("项目不存在", 404, "NOT_FOUND");
  const { order } = (await req.json()) as { order: string[] };
  const queued = await db
    .select()
    .from(requirements)
    .where(and(eq(requirements.projectId, id), eq(requirements.status, "queued")));
  const queuedIds = new Set(queued.map((q) => q.id));
  let seq = 1;
  for (const rid of order) {
    if (!queuedIds.has(rid)) continue;
    await db.update(requirements).set({ seq }).where(inArray(requirements.id, [rid]));
    seq += 1;
  }
  // 其余非 queued 的保持原 seq 不动（允许空洞，展示层排序处理）
  return ok({ reordered: order.length });
}
