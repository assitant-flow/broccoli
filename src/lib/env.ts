export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://broccoli:broccoli@localhost:5432/broccoli",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret",
  masterKey: process.env.BROCCOLI_MASTER_KEY ?? "dev-master-key-change-me-32bytes!!",
  maxConcurrency: Number(process.env.BROCCOLI_MAX_CONCURRENCY ?? 2),
  snapshotTtlHours: Number(process.env.BROCCOLI_SNAPSHOT_TTL_HOURS ?? 24),
  dataDir: process.env.BROCCOLI_DATA_DIR ?? ".data",
  engine: (process.env.BROCCOLI_ENGINE ?? "mock") as "mock" | "claude",
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
