import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/* ============ 用户与凭证 ============ */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

/** provider: anthropic | github */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    provider: text("provider").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    hint: text("hint").notNull().default(""),
    lastVerifiedAt: timestamp("last_verified_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("credentials_user_provider").on(t.userId, t.provider)],
);

/* ============ 项目 ============ */

/** originKind: local（demo 本地裸仓模拟 GitHub）| github（真实 Octokit，env 门控） */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    /** 堆叠 base 指针：最后一个成功任务的分支（FR-D6/AC-F1） */
    lastSuccessBranch: text("last_success_branch"),
    /** failurePolicy: pause | skip_continue */
    failurePolicy: text("failure_policy").notNull().default("pause"),
    originKind: text("origin_kind").notNull().default("local"),
    status: text("status").notNull().default("active"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("projects_user_idx").on(t.userId)],
);

/* ============ 需求队列 ============ */

export const requirementBatches = pgTable("requirement_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  /** pause | skip_continue（批次快照策略，FR-C3） */
  failurePolicy: text("failure_policy").notNull().default("pause"),
  /** 阶段模型临时覆盖（FR-D18）：{ [stageType]: modelKey }，仅对该批次任务生效 */
  stageModelOverrides: jsonb("stage_model_overrides").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

/** status: queued | active | done | failed | skipped | suspended | cancelled */
export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    batchId: uuid("batch_id"),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("queued"),
    latestRunId: uuid("latest_run_id"),
    /** 依赖图（v2α）：依赖同项目内某需求的 seq；该需求 done 后才启动，失败/跳过则级联跳过 */
    dependsOnSeq: integer("depends_on_seq"),
    /** 级联跳过原因（依赖图/失败策略） */
    skipReason: text("skip_reason"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("requirements_project_idx").on(t.projectId, t.seq)],
);

/* ============ 任务执行 ============ */

/** state: queued | preparing | running | wait_confirm | completed | failed | cancelled | suspended */
export const taskRuns = pgTable(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requirementId: uuid("requirement_id").notNull(),
    projectId: uuid("project_id").notNull(),
    attemptNo: integer("attempt_no").notNull().default(1),
    state: text("state").notNull().default("queued"),
    branch: text("branch"),
    baseBranch: text("base_branch"),
    currentStage: text("current_stage"),
    /** 阶段化上下文 */
    confirmQuestion: jsonb("confirm_question").$type<ConfirmQuestion | null>(),
    confirmAnswer: text("confirm_answer"),
    confirmExpiresAt: timestamp("confirm_expires_at", { mode: "date" }),
    snapshot: jsonb("snapshot").$type<Record<string, unknown> | null>(),
    repairRound: integer("repair_round").notNull().default(0),
    // 堆叠链修复时的 base 覆盖（FR-F3）
    baseOverride: text("base_override"),
    error: text("error"),
    startedAt: timestamp("started_at", { mode: "date" }),
    endedAt: timestamp("ended_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("task_runs_req_idx").on(t.requirementId), index("task_runs_state_idx").on(t.state)],
);

export type ConfirmQuestion = {
  question: string;
  options: { key: string; label: string; description?: string; recommended?: boolean }[];
  allowFreeText: boolean;
  context?: string;
};

/** type: planning | dev | test_design | test_run | acceptance | delivery */
/** state: queued | running | wait_confirm | completed | failed | skipped */
export const taskStages = pgTable(
  "task_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    type: text("type").notNull(),
    seq: integer("seq").notNull(),
    state: text("state").notNull().default("queued"),
    modelKey: text("model_key"),
    /** recommended | custom */
    modelSource: text("model_source").notNull().default("recommended"),
    summary: text("summary"),
    startedAt: timestamp("started_at", { mode: "date" }),
    endedAt: timestamp("ended_at", { mode: "date" }),
  },
  (t) => [uniqueIndex("task_stages_run_type").on(t.runId, t.type)],
);

/** state: queued | running | completed | cancelled */
export const subtasks = pgTable(
  "subtasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull().default("queued"),
    ownerStageId: uuid("owner_stage_id"),
  },
  (t) => [index("subtasks_run_idx").on(t.runId, t.seq)],
);

/** status: defined | achieved | unverified | failed */
export const acceptanceCriteria = pgTable(
  "acceptance_criteria",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    content: text("content").notNull(),
    verifyStage: text("verify_stage").notNull().default("acceptance"),
    status: text("status").notNull().default("defined"),
    evidence: text("evidence"),
    achievedByStageId: uuid("achieved_by_stage_id"),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("acceptance_criteria_run_idx").on(t.runId, t.seq)],
);

/** kind: plan | diff | testcase | report | pr | confirm */
export const stageArtifacts = pgTable(
  "stage_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stageId: uuid("stage_id").notNull(),
    runId: uuid("run_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    storageKey: text("storage_key"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("stage_artifacts_stage_idx").on(t.stageId)],
);

export const stageLogs = pgTable(
  "stage_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    stageId: uuid("stage_id"),
    ts: timestamp("ts", { mode: "date" }).notNull().defaultNow(),
    level: text("level").notNull().default("info"),
    line: text("line").notNull(),
  },
  (t) => [index("stage_logs_run_idx").on(t.runId)],
);

/* ============ 容器与快照 ============ */

/** state: preparing | active | released */
export const containerLeases = pgTable("container_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  userId: uuid("user_id").notNull(),
  runId: uuid("run_id"),
  state: text("state").notNull().default("preparing"),
  reason: text("reason").notNull().default(""),
  startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { mode: "date" }),
});

/** status: active | consumed | expired */
export const sessionSnapshots = pgTable("session_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  stageId: uuid("stage_id"),
  sdkSessionId: text("sdk_session_id").notNull().default(""),
  patchObjectKey: text("patch_object_key").notNull().default(""),
  baseBranch: text("base_branch"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
});

/* ============ 记忆系统 ============ */

/** type: convention | decision | lesson | fact */
/** status: pending | confirmed | rejected */
export const memoryProposals = pgTable(
  "memory_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    sourceRunId: uuid("source_run_id"),
    type: text("type").notNull().default("decision"),
    content: text("content").notNull(),
    status: text("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("memory_proposals_project_idx").on(t.projectId, t.status)],
);

/** status: confirmed | disabled */
export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 项目级记忆；用户级偏好（v2α）时为空，改以 user_id 归属 */
    projectId: uuid("project_id"),
    /** 用户级偏好记忆（v2α，FR-G10）：非空时跨该项目所有者的全部项目注入 */
    userId: uuid("user_id"),
    type: text("type").notNull().default("decision"),
    content: text("content").notNull(),
    status: text("status").notNull().default("confirmed"),
    sourceProposalId: uuid("source_proposal_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("memory_items_project_idx").on(t.projectId, t.status), index("memory_items_user_idx").on(t.userId)],
);

export const memoryInjections = pgTable("memory_injections", {
  id: uuid("id").primaryKey().defaultRandom(),
  proposalId: uuid("proposal_id"),
  itemId: uuid("item_id"),
  targetRunId: uuid("target_run_id").notNull(),
  injectedAt: timestamp("injected_at", { mode: "date" }).notNull().defaultNow(),
});

/* ============ 分阶段模型配置 ============ */

/** stageType: planning | dev | test_design | test_run | acceptance | delivery */
export const stageModelConfigs = pgTable(
  "stage_model_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    stageType: text("stage_type").notNull(),
    modelKey: text("model_key").notNull(),
    /** recommended | custom */
    source: text("source").notNull().default("recommended"),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("stage_model_configs_proj_stage").on(t.projectId, t.stageType)],
);

/* ============ 通知 / 用量 / 审计 ============ */

/** type: wait_confirm | failed | suspended | completed */
export const notificationEvents = pgTable(
  "notification_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    type: text("type").notNull(),
    runId: uuid("run_id"),
    dedupeKey: text("dedupe_key").notNull().unique(),
    status: text("status").notNull().default("sent"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("notification_events_user_idx").on(t.userId, t.createdAt)],
);

export const usageRecords = pgTable("usage_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  runId: uuid("run_id"),
  stageId: uuid("stage_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  containerSeconds: integer("container_seconds").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

/* ============ PR（本地模拟 GitHub 时落库） ============ */

/** status: open | merged | closed */
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id"),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").notNull().default("open"),
    diffStat: text("diff_stat").notNull().default(""),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pull_requests_proj_number").on(t.projectId, t.number)],
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
});

export const boolCol = boolean;

/* ============ Issues 同步（FR-C4）与介入讨论（FR-E6） ============ */

/** state: open | closed（本地模拟 GitHub Issues；PR 开出后状态回写） */
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    state: text("state").notNull().default("open"),
    syncedRequirementId: uuid("synced_requirement_id"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { mode: "date" }),
  },
  (t) => [uniqueIndex("issues_proj_number").on(t.projectId, t.number)],
);

/** 介入讨论（FR-E6）：用户在任务详情页与 agent 的补充说明往来 */
export const runMessages = pgTable(
  "run_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    /** user | agent */
    role: text("role").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("run_messages_run_idx").on(t.runId)],
);

/* ============ 服务端点（任务产出：启动的服务地址，v2β） ============ */

/** status: running | stopped（服务在任务交付时启动，项目页展示访问地址） */
export const serviceEndpoints = pgTable(
  "service_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    port: integer("port").notNull(),
    pid: integer("pid"),
    status: text("status").notNull().default("running"),
    logPath: text("log_path"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("service_endpoints_project_idx").on(t.projectId)],
);
