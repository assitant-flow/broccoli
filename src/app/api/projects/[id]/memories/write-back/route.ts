import { db } from "@/db";
import { auditLogs, memoryItems, projects, taskRuns } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth";
import { commitAll, ensureProjectRepos, git, gitNet, pushBranch, workPath } from "@/lib/git";
import { resolveGithubToken } from "@/lib/github";
import fs from "node:fs/promises";
import path from "node:path";

const TYPE_LABEL: Record<string, string> = { decision: "决策", convention: "规范", lesson: "教训", fact: "事实" };

/** 记忆写回仓库（FR-G9 后半）：确认记忆 → CLAUDE.md → 平台提交到 main 并推送 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id))).limit(1);
  if (!project) return Response.json({ ok: false, message: "项目不存在" }, { status: 404 });

  const [{ count: active }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskRuns)
    .where(and(eq(taskRuns.projectId, id), inArray(taskRuns.state, ["preparing", "running", "wait_confirm"])));
  if (active > 0) {
    return Response.json({ ok: false, message: "队列执行中，请等待任务进入终态后再写回（避免工作区冲突）" }, { status: 409 });
  }

  const items = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.projectId, id), eq(memoryItems.status, "confirmed")));
  if (items.length === 0) return Response.json({ ok: false, message: "没有已确认记忆可写回" }, { status: 400 });

  const md = [
    "# CLAUDE.md",
    "",
    `> 由 Broccoli 记忆写回生成（${new Date().toLocaleString("zh-CN")}）· 共 ${items.length} 条 · 请勿手工排序，平台按确认时间维护`,
    "",
    ...items.map((i) => `- [${TYPE_LABEL[i.type] ?? i.type}] ${i.content}`),
  ].join("\n");

  // 写回必须落在默认分支：流水线结束后工作区通常停留在最后一次执行的 broccoli/* 分支，
  // 直接 commit 会把 CLAUDE.md 提交到特性分支，随后「推送 main」成为静默 no-op（历史缺陷）。
  const work = workPath(project.id);
  const branch = project.defaultBranch;
  const token = (project.originKind === "github" ? await resolveGithubToken(user.id) : undefined) ?? undefined;
  if (project.originKind !== "github") await ensureProjectRepos(project.id, {}, undefined);
  // 显式按分支名 fetch 并以 FETCH_HEAD 为基：克隆自空裸仓库的工作区可能没有
  // refs/remotes/origin/* 追踪引用（无 fetch refspec），origin/main 不可解析
  await gitNet(work, token, ["fetch", "origin", branch], 60000);
  await git(work, "checkout", "-B", branch, "FETCH_HEAD");

  await fs.writeFile(path.join(work, "CLAUDE.md"), md);
  const committed = await commitAll(project.id, "chore: Broccoli 记忆写回（CLAUDE.md，FR-G9）");
  if (!committed) return Response.json({ ok: false, message: "写回内容与仓库现状一致，无变更" }, { status: 400 });
  await pushBranch(project.id, branch, { token });
  const commit = await git(work, "rev-parse", "--short", "HEAD");

  await db.insert(auditLogs).values({
    actor: "user",
    action: "memory_write_back",
    target: `project:${id}`,
    detail: { count: items.length, branch, commit },
  });
  return Response.json({ ok: true, message: `已写回 ${items.length} 条记忆到 CLAUDE.md 并推送到 ${branch}`, commit, branch });
}
