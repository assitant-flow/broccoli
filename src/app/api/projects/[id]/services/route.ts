import { db } from "@/db";
import { serviceEndpoints } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth";
import { probeService, stopServiceProcess } from "@/lib/services";
import { projects } from "@/db/schema";
import { and } from "drizzle-orm";

/** 项目的服务访问地址列表（v2β）：探活后返回 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return new Response("not found", { status: 404 });

  const rows = await db
    .select()
    .from(serviceEndpoints)
    .where(eq(serviceEndpoints.projectId, id))
    .orderBy(desc(serviceEndpoints.createdAt));

  // 探活：URL 不可达且 DB 标记 running → 自动修正为 stopped（平台重启后进程消亡）
  const out = [];
  for (const s of rows) {
    if (s.status === "running") {
      const alive = await probeService(s.url);
      if (!alive) {
        await db.update(serviceEndpoints).set({ status: "stopped" }).where(eq(serviceEndpoints.id, s.id));
        out.push({ ...s, status: "stopped" });
        continue;
      }
    }
    out.push(s);
  }
  return Response.json(out);
}
