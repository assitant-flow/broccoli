import { db } from "@/db";
import { memoryItems, projects } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth";

/** 记忆导出（FR-G9 P2）：Markdown 下载 —— 记忆可拥有、可迁移 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return new Response("not found", { status: 404 });
  const items = await db.select().from(memoryItems).where(eq(memoryItems.projectId, id)).orderBy(memoryItems.createdAt);

  const TYPE_LABEL: Record<string, string> = { decision: "决策", convention: "规范", lesson: "教训", fact: "事实" };
  const md = [
    `# Broccoli 记忆导出 · ${project.name}`,
    "",
    `> 导出时间 ${new Date().toLocaleString("zh-CN")} · 共 ${items.length} 条 · 可迁移为仓库 CLAUDE.md（FR-G9）`,
    "",
    ...items.map((i) => `- [${TYPE_LABEL[i.type] ?? i.type}] ${i.content}`),
  ].join("\n");

  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="broccoli-memories-${project.name}.md"`,
    },
  });
}
