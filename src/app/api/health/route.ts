import { db } from "@/db";
import { sql } from "drizzle-orm";

/** 健康检查（容器/负载均衡探针）：应用进程 + 数据库连通 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, db: true, engine: process.env.BROCCOLI_ENGINE ?? "mock", sandbox: process.env.BROCCOLI_SANDBOX ?? "local" });
  } catch {
    return Response.json({ ok: false, db: false }, { status: 503 });
  }
}
