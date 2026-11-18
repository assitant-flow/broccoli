import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok } from "@/lib/api";
import { ensureProjectRepos } from "@/lib/git";
import { ensureStageModelDefaults } from "@/lib/models";
import { initialProjectAnalysis } from "@/lib/pipeline/orchestrator";
import { resolveGithubToken, verifyRepoAccess } from "@/lib/github";

const SEED_FILES = (name: string) => ({
  "package.json": JSON.stringify({ name, type: "module", scripts: { test: "node --test tests/" }, private: true }, null, 2),
  "src/index.mjs": `// ${name} 入口\nexport const app = { name: "${name}" };\nexport default app;\n`,
  "README.md": `# ${name}\n\n由 Broccoli 管理的项目（本地模拟 GitHub origin，真实 git 堆叠分支）。\n`,
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await db.select().from(projects).where(eq(projects.userId, user.id)).orderBy(projects.createdAt);
  return ok(rows.filter((p) => p.status === "active"));
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json()) as {
    name?: string; failurePolicy?: string; parallelStages?: boolean;
    originKind?: "local" | "github"; repoFullName?: string;
  };
  const name = (body.originKind === "github" ? (body.repoFullName ?? "").split("/")[1] : body.name)?.trim();
  if (!name) return Response.json({ code: "INVALID", message: "项目名或 repoFullName 必填" }, { status: 400 });

  const isGithub = body.originKind === "github";
  let githubBranch = "main";
  if (isGithub) {
    // github origin：验证 token 对仓库的访问（FR-A3/FR-B1）
    const token = await resolveGithubToken(user.id);
    if (!token) return Response.json({ code: "NO_TOKEN", message: "缺少 GitHub token（平台 GITHUB_TOKEN 或在引导页存入 PAT）" }, { status: 400 });
    const access = await verifyRepoAccess(token, body.repoFullName!);
    if (!access.ok) return Response.json({ code: "REPO", message: `仓库不可访问：${access.error}` }, { status: 400 });
    if (access.defaultBranch) githubBranch = access.defaultBranch;
  }

  const [project] = await db
    .insert(projects)
    .values({
      userId: user.id,
      name,
      repoFullName: isGithub ? body.repoFullName! : `${name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}/main`,
      defaultBranch: githubBranch,
      failurePolicy: body.failurePolicy === "skip_continue" ? "skip_continue" : "pause",
      originKind: isGithub ? "github" : "local",
      settings: { parallelStages: body.parallelStages !== false },
    })
    .returning();
  try {
    await ensureProjectRepos(project.id, isGithub ? {} : SEED_FILES(name), isGithub ? { remoteUrl: `https://github.com/${project.repoFullName}.git`, token: (await resolveGithubToken(user.id))! } : undefined);
  } catch (err) {
    // clone 失败 → 回滚项目行，返回可读原因（AC-B1）
    await db.delete(projects).where(eq(projects.id, project.id));
    return Response.json({ code: "CLONE", message: `仓库 clone 失败：${String(err).slice(0, 200)}` }, { status: 502 });
  }
  await ensureStageModelDefaults(project.id);
  await initialProjectAnalysis(project.id);
  return ok(project);
}
