import type { ConfirmQuestion } from "@/db/schema";
import type { StageType } from "@/lib/env";

export interface StageContext {
  runId: string;
  stageId: string;
  stageType: StageType;
  projectId: string;
  userId: string;
  requirement: { id: string; seq: number; title: string; description: string };
  project: { id: string; name: string; repoFullName: string; defaultBranch: string; failurePolicy: string };
  branch: string;
  baseBranch: string;
  workspace: string;
  repairRound: number;
  /** 非空表示从「等待确认」恢复，回答已注入上下文（FR-D4） */
  confirmAnswer?: string | null;
  /** 记忆注入内容（已确认记忆 + 待确认提案，提案即注入 FR-G3） */
  injections: string[];
  /** 用户介入讨论的补充说明（FR-E6） */
  userMessages: string[];
  subtasks: { seq: number; title: string; state: string }[];
  criteria: { seq: number; content: string; verifyStage: string; status: string }[];
  nextPrNumber: number;
}

export interface StageArtifactOut {
  name: string;
  kind: "plan" | "diff" | "testcase" | "report" | "pr" | "confirm";
  storageKey?: string;
  meta?: Record<string, unknown>;
}

export interface StageOutput {
  summary: string;
  artifacts: StageArtifactOut[];
  /** 规划阶段产出（FR-D11） */
  subtaskTitles?: string[];
  criteria?: { content: string; verifyStage: string }[];
  criteriaUpdates?: { seq: number; status: "achieved" | "failed" | "unverified"; evidence?: string }[];
  /** 记忆提案（交付阶段生成，FR-G2） */
  memoryProposals?: { type: "convention" | "decision" | "lesson" | "fact"; content: string }[];
  /** 引擎请求用户决策 → 任务转「等待确认」（FR-D4） */
  confirm?: ConfirmQuestion;
  /** 交付阶段启动的服务（v2β 产物）：编排器落库 service_endpoints 并展示访问地址 */
  services?: { name: string; url: string; port: number; pid: number; logPath: string }[];
  /** 测试执行：无测试命令时跳过（FR-D9/AC-D9） */
  skipped?: boolean;
  tokens?: { in: number; out: number };
}

/** 引擎判定阶段失败（走 FR-D6 失败策略） */
export class StageFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageFailure";
  }
}

export interface ExecutionEngine {
  readonly name: "mock" | "claude";
  runStage(ctx: StageContext): Promise<StageOutput>;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ASCII slug（中文需求回退 req，分支/文件名含 seq 保证唯一） */
export function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return ascii || "req";
}
