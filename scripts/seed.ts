/**
 * 种子数据：演示账号 + 两个项目 + 需求队列（覆盖全部演示路径）。
 * 运行：pnpm seed（需 Postgres 已启动）
 */
import { db, poolClose } from "../src/db-wrap";
import { users, projects, requirementBatches, requirements, issues } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/lib/crypto";
import { ensureProjectRepos } from "../src/lib/git";
import { ensureStageModelDefaults } from "../src/lib/models";
import { initialProjectAnalysis } from "../src/lib/pipeline/orchestrator";

async function main() {
  // 幂等初始化模式（compose/生产默认）：已有演示账号 → 直接跳过（保留全部数据）；
  // SEED_RESET=1 时强制重置（本地开发循环用）
  const force = process.env.SEED_RESET === "1";
  const email = "thomas@broccoli.dev";
  const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existingUser && !force) {
    console.log("• 已初始化（演示账号存在）——跳过 seed，数据保持不变。重置请用 SEED_RESET=1 pnpm seed");
    return;
  }
  if (existingUser && force) {
    console.log("• SEED_RESET=1 —— 清理并重建演示数据");
  }

  // 1. 演示账号
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ email, passwordHash: hashPassword("broccoli123"), displayName: "Thomas Zhang" })
      .returning();
    console.log("✓ 演示账号 thomas@broccoli.dev / broccoli123");
  } else {
    console.log("• 演示账号已存在");
  }

  // 清理旧项目（可重复运行）
  const old = await db.select().from(projects).where(eq(projects.userId, user.id));
  for (const p of old) {
    await db.delete(projects).where(eq(projects.id, p.id));
  }
  console.log(`• 已清理旧项目（${old.length} 个）`);

  // 2. 项目 A：失败暂停 + 5 需求（覆盖 确认/修复/串行 堆叠）
  const [projA] = await db
    .insert(projects)
    .values({
      userId: user.id,
      name: "acme/api-gateway",
      repoFullName: "acme/api-gateway",
      failurePolicy: "pause",
      originKind: "local",
      settings: { parallelStages: true },
    })
    .returning();
  await ensureStageModelDefaults(projA.id);
  await ensureProjectRepos(projA.id, {
    "package.json": JSON.stringify({ name: "api-gateway", type: "module", scripts: { test: "node --test tests/" }, private: true }, null, 2),
    "src/index.mjs": "// api-gateway 入口\nexport const app = { name: 'api-gateway' };\nexport default app;\n",
    "src/auth/session.mjs": "// 既有会话模块\nexport function currentSession() { return { expired: false }; }\n",
    "CLAUDE.md": "# 仓库约定\n\n- 使用 ESM（.mjs）与 node:test 编写测试\n- 每个模块必须有对应测试文件\n- 提交信息遵循 Conventional Commits，中文描述\n",
    "README.md": "# acme/api-gateway\n",
  });
  await initialProjectAnalysis(projA.id);

  // 3. 项目 B：失败自动跳过 + 3 需求（覆盖失败跳过与 base 回退）
  const [projB] = await db
    .insert(projects)
    .values({
      userId: user.id,
      name: "thomas/portfolio-site",
      repoFullName: "thomas/portfolio-site",
      failurePolicy: "skip_continue",
      originKind: "local",
      settings: { parallelStages: true },
    })
    .returning();
  await ensureStageModelDefaults(projB.id);
  await ensureProjectRepos(projB.id, {
    "package.json": JSON.stringify({ name: "portfolio-site", type: "module", scripts: { test: "node --test tests/" }, private: true }, null, 2),
    "index.html": "<h1>Portfolio</h1>\n",
    "README.md": "# thomas/portfolio-site\n",
  });
  await initialProjectAnalysis(projB.id);

  // 4. 需求队列
  async function submit(projectId: string, titles: string[], policy: string) {
    const [batch] = await db.insert(requirementBatches).values({ projectId, failurePolicy: policy }).returning();
    const rows = await db
      .insert(requirements)
      .values(titles.map((t, i) => ({ projectId, batchId: batch.id, seq: i + 1, title: t })))
      .returning();
    const { createRunForRequirement } = await import("../src/lib/pipeline/orchestrator");
    for (const r of rows) {
      await createRunForRequirement(r.id, projectId);
    }
    return rows;
  }

  await submit(projA.id, [
    "修复登录态过期后无限重定向的问题",
    "引入会话持久化存储，支持限流计数",
    "重构通知模块为事件驱动架构",
    "为 /api/orders 添加分页与筛选，page 参数必须校验：非数字或小于 1 的 page 必须抛出错误 [repair]",
    "补齐订单模块的单元测试",
  ], "pause");

  await submit(projB.id, [
    "更新个人简介与联系方式",
    "新增深色模式切换 [fail-tests]",
    "优化首页加载性能",
  ], "skip_continue");

  // 5. Issues（本地模拟 GitHub Issues，FR-C4）
  await db.insert(issues).values([
    { projectId: projA.id, number: 1, title: "文档站导航面包屑缺失", body: "文档页缺少层级导航，希望自动生成面包屑。" },
    { projectId: projA.id, number: 2, title: "接口 404 统一错误码", body: "所有 404 响应应返回统一的错误码与提示结构。" },
    { projectId: projB.id, number: 1, title: "作品集支持视频封面", body: "项目卡片希望支持视频封面预览。" },
  ]);

  console.log("✓ 项目 A acme/api-gateway：5 个需求（#2 选型确认 · #4 验收回溯修复）+ 2 个待同步 Issues + CLAUDE.md");
  console.log("✓ 项目 B thomas/portfolio-site：3 个需求（#2 测试失败 → 自动跳过 → base 回退）+ 1 个 Issue");
  console.log("");
  console.log("下一步：pnpm dev 启动后，调度器将自动开始执行两个项目的队列。");
}

main()
  .then(() => poolClose())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
