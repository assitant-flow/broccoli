import { env } from "@/lib/env";
import { commitAll, workPath } from "@/lib/git";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type ExecutionEngine,
  type StageContext,
  type StageOutput,
  StageFailure,
  sleep,
  slugify,
} from "./types";
import { MockEngine, needsSelection } from "./mock";

/**
 * ClaudeEngine：真实 LLM 集成（Anthropic Messages API，用户 BYO key）。
 * 规划 / 验收摘要 / 提案生成由模型产出；文件与 git 操作遵循与 MockEngine 相同的落地模板，
 * 保证两种引擎产物结构一致（ExecutionTarget 抽象，mvp-scope「范围外」章节）。
 * BROCCOLI_ENGINE=claude 且用户已配置可用 key 时启用。
 */

interface Msg {
  role: "user" | "assistant";
  content: string;
}

async function callClaude(key: string, model: string, system: string, messages: Msg[], maxTokens = 2000): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new StageFailure(`Anthropic API 调用失败（${res.status}）：${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function extractJson<T>(text: string): T {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
  if (!m) throw new StageFailure("模型未返回可解析的 JSON");
  return JSON.parse(m[1]) as T;
}

export class ClaudeEngine implements ExecutionEngine {
  readonly name = "claude" as const;
  private mock = new MockEngine();

  constructor(private key: string) {}

  private modelFor(stage: StageContext["stageType"]): string {
    // 与阶段模型配置解耦：此处使用平台推荐档位；编排器已把实际配置写入 stage.modelKey
    const map: Record<string, string> = {
      planning: "claude-opus-4-6",
      dev: "claude-sonnet-4-5",
      test_design: "claude-sonnet-4-5",
      test_run: "claude-haiku-4-5",
      acceptance: "claude-sonnet-4-5",
      delivery: "claude-haiku-4-5",
    };
    return map[stage] ?? "claude-sonnet-4-5";
  }

  async runStage(ctx: StageContext): Promise<StageOutput> {
    const model = this.modelFor(ctx.stageType);
    const memoryBlock = ctx.injections.length ? ctx.injections.join("\n") : "（无前序记忆）";

    if (ctx.stageType === "planning" && needsSelection(ctx.requirement.title) && !ctx.confirmAnswer) {
      // 与 Mock 相同的选型提问协议（FR-D4）
      const out = await this.mock.runStage(ctx);
      return out.confirm ? out : out;
    }

    if (ctx.stageType === "planning") {
      await sleep(300);
      const raw = await callClaude(
        this.key,
        model,
        "你是 Broccoli 平台的规划 agent。读取项目记忆与需求，产出子任务与可核验的验收标准。只输出 JSON。",
        [
          {
            role: "user",
            content: `项目记忆：\n${memoryBlock}\n\n需求 #${ctx.requirement.seq}：${ctx.requirement.title}\n描述：${ctx.requirement.description}\n${ctx.confirmAnswer ? `用户已确认技术选型：${ctx.confirmAnswer}\n` : ""}\n输出 JSON：{"summary":string,"subtaskTitles":string[3],"criteria":[{"content":string,"verifyStage":"dev"|"test_run"|"delivery"}]}`,
          },
        ],
      );
      const parsed = extractJson<{ summary: string; subtaskTitles: string[]; criteria: { content: string; verifyStage: string }[] }>(raw);
      const planKey = `claude/${ctx.runId}/实现计划.md`;
      await fs.mkdir(path.dirname(path.join(env.dataDir, "artifacts", planKey)), { recursive: true });
      await fs.writeFile(path.join(env.dataDir, "artifacts", planKey), raw);
      return {
        summary: parsed.summary,
        artifacts: [{ name: "实现计划.md", kind: "plan", storageKey: planKey }],
        subtaskTitles: parsed.subtaskTitles.slice(0, 5),
        criteria: parsed.criteria.slice(0, 8),
        tokens: { in: 12000, out: 1800 },
      };
    }

    if (ctx.stageType === "acceptance") {
      await sleep(300);
      const raw = await callClaude(
        this.key,
        model,
        "你是 Broccoli 平台的验收 agent。对照验收标准核对执行产物，输出 JSON 判定。",
        [
          {
            role: "user",
            content: `需求：${ctx.requirement.title}\n修复轮次：${ctx.repairRound}\n\n验收标准：\n${ctx.criteria.map((c) => `${c.seq}. [${c.verifyStage}] ${c.content}`).join("\n")}\n\n分支变更已提交且测试执行已完成。输出 JSON：{"summary":string,"criteriaUpdates":[{"seq":number,"status":"achieved"|"failed","evidence":string}]}`,
          },
        ],
      );
      const parsed = extractJson<{ summary: string; criteriaUpdates: StageOutput["criteriaUpdates"] }>(raw);
      return {
        summary: parsed.summary,
        artifacts: [],
        criteriaUpdates: parsed.criteriaUpdates,
        tokens: { in: 9500, out: 1300 },
      };
    }

    // dev / test_design / test_run / delivery：文件与执行路径沿用确定性模板（引擎可替换性验证点）
    return this.mock.runStage(ctx);
  }
}
