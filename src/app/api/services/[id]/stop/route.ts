import { db } from "@/db";
import { projects, serviceEndpoints } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth";
import { stopServiceProcess } from "@/lib/services";

/** 停止服务（v2β）：kill 进程 + 状态落库 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const rows = await db
    .select({ svc: serviceEndpoints })
    .from(serviceEndpoints)
    .innerJoin(projects, eq(serviceEndpoints.projectId, projects.id))
    .where(and(eq(serviceEndpoints.id, id), eq(projects.userId, user.id)))
    .limit(1);
  if (!rows.length) return Response.json({ ok: false, message: "服务不存在" }, { status: 404 });
  const svc = rows[0].svc;
  await stopServiceProcess(svc.pid);
  await db.update(serviceEndpoints).set({ status: "stopped" }).where(eq(serviceEndpoints.id, id));
  return Response.json({ ok: true, message: `服务已停止（端口 ${svc.port}）` });
}
