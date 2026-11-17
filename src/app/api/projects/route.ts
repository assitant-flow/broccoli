import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok } from "@/lib/api";
import { ensureProjectRepos } from "@/lib/git";
import { ensureStageModelDefaults } from "@/lib/models";
import { initialProjectAnalysis } from "@/lib/pipeline/orchestrator";

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
  const body = (await req.json()) as { name: string; failurePolicy?: string; parallelStages?: boolean };
  const name = body.name?.trim();
  if (!name) return Response.json({ code: "INVALID", message: "项目名必填" }, { status: 400 });

  const [project] = await db
    .insert(projects)
    .values({
      userId: user.id,
      name,
      repoFullName: `${name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}/main`,
      failurePolicy: body.failurePolicy === "skip_continue" ? "skip_continue" : "pause",
      originKind: "local",
      settings: { parallelStages: body.parallelStages !== false },
    })
    .returning();
  await ensureProjectRepos(project.id, SEED_FILES(name));
  await ensureStageModelDefaults(project.id);
  await initialProjectAnalysis(project.id);
  return ok(project);
}
