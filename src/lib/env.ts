export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://broccoli:broccoli@localhost:5432/broccoli",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret",
  masterKey: process.env.BROCCOLI_MASTER_KEY ?? "dev-master-key-change-me-32bytes!!",
  maxConcurrency: Number(process.env.BROCCOLI_MAX_CONCURRENCY ?? 2),
  snapshotTtlHours: Number(process.env.BROCCOLI_SNAPSHOT_TTL_HOURS ?? 24),
  dataDir: process.env.BROCCOLI_DATA_DIR ?? ".data",
  engine: (process.env.BROCCOLI_ENGINE ?? "mock") as "mock" | "claude",
  /** 执行沙箱：local（宿主进程，开发/CI）| docker（容器隔离 + 白名单 egress proxy） */
  sandbox: (process.env.BROCCOLI_SANDBOX ?? "local") as "local" | "docker",
  /** 记忆注入阈值（v2β FR-G11）：确认记忆+提案+偏好总数超过后进入检索模式 */
  memoryInjectThreshold: Number(process.env.BROCCOLI_MEMORY_INJECT_THRESHOLD ?? 16),
  /** 检索模式 top-K 上限 */
  memoryTopK: Number(process.env.BROCCOLI_MEMORY_TOP_K ?? 12),
  /** 检索模式注入字符预算 */
  memoryInjectBudgetChars: Number(process.env.BROCCOLI_MEMORY_BUDGET_CHARS ?? 6000),
  /** 可选 embeddings 端点（OpenAI 兼容 /embeddings）；配置后启用向量检索，失败自动回落关键词检索 */
  embeddingsUrl: process.env.BROCCOLI_EMBEDDINGS_URL ?? "",
  embeddingsModel: process.env.BROCCOLI_EMBEDDINGS_MODEL ?? "text-embedding-3-small",
  embeddingsKey: process.env.BROCCOLI_EMBEDDINGS_KEY ?? "",
  /** Anthropic 兼容 API（可指向本地 router / 代理；默认官方端点） */
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, ""),
  /** 覆盖全部阶段的模型名（如 router 的 glm:glm-5.3[1m]）；空 = 用各阶段配置的 claude-* 模型 */
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "",
  /** 平台级 Anthropic Token（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY），优先于用户 BYO key */
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "",
  /** 平台级 GitHub Token（repo scope）；originKind=github 项目使用 */
  githubToken: process.env.GITHUB_TOKEN ?? "",
  /** 验收回路最大自动修复轮数（FR-D14，默认 1） */
  maxRepairRounds: Number(process.env.BROCCOLI_MAX_REPAIR_ROUNDS ?? 1),
  siteUrl: process.env.BROCCOLI_SITE_URL ?? "http://localhost:3000",
};

export const STAGE_TYPES = ["planning", "dev", "test_design", "test_run", "acceptance", "delivery"] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const STAGE_LABELS: Record<StageType, string> = {
  planning: "规划 · Planning",
  dev: "开发实现",
  test_design: "测试用例编写",
  test_run: "测试执行",
  acceptance: "验收对照",
  delivery: "交付",
};

/** 平台推荐模型（静态映射，FR-D17） */
export const RECOMMENDED_MODELS: Record<StageType, string> = {
  planning: "claude-opus-4-6",
  dev: "claude-sonnet-4-5",
  test_design: "claude-sonnet-4-5",
  test_run: "claude-haiku-4-5",
  acceptance: "claude-sonnet-4-5",
  delivery: "claude-haiku-4-5",
};
