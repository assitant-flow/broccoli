import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, taskRuns } from "@/db/schema";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { bad } from "@/lib/api";
import { env } from "@/lib/env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response("// 产物文件不存在", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * 产物查看（FR-E3）。
 * 安全：runId 必须是 UUID 且 run 属于当前用户（旧版仅校验 name，runId 可携带 ../ 读取任意文件，
 * 且未校验归属）；name 禁止分隔符与 ..；解析后的绝对路径必须落在 artifacts 根目录内。
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") ?? "";
  const name = url.searchParams.get("name") ?? "";
  if (!UUID_RE.test(runId) || !name || /[/\\\0]/.test(name) || name.includes("..")) {
    return bad("runId 与 name 参数无效");
  }

  const [owned] = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .innerJoin(projects, eq(taskRuns.projectId, projects.id))
    .where(and(eq(taskRuns.id, runId), eq(projects.userId, user.id)))
    .limit(1);
  if (!owned) return notFound();

  const root = path.resolve(process.cwd(), env.dataDir, "artifacts");
  const file = path.resolve(root, runId, name);
  if (!file.startsWith(root + path.sep)) return bad("非法路径");

  try {
    const content = await fs.readFile(file, "utf8");
    return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return notFound();
  }
}
