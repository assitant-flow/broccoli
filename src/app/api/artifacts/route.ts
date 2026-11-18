import fs from "node:fs/promises";
import path from "node:path";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { bad } from "@/lib/api";
import { env } from "@/lib/env";

/** 产物查看（实现计划 / 测试报告 / diff / 验收报告，FR-E3） */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  const name = url.searchParams.get("name");
  if (!runId || !name || name.includes("..") || name.includes("/")) return bad("runId 与 name 必填");
  const p = path.resolve(process.cwd(), env.dataDir, "artifacts", runId, name);
  try {
    const content = await fs.readFile(p, "utf8");
    return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("// 产物文件不存在", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
