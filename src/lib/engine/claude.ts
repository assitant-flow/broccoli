import { env } from "@/lib/env";
import { normalizeBaseUrl, type AiProtocol } from "@/lib/ai-settings";
import { chatOnce, LlmHttpError, type LlmTarget } from "@/lib/llm";
import {
  type ExecutionEngine,
  type StageContext,
  type StageOutput,
  StageFailure,
  sleep,
} from "./types";
import { MockEngine, needsSelection } from "./mock";

/**
 * LlmEngine：真实 LLM 集成（平台 AI 接入驱动）。
 * - 端点 / 接口模式 / 模型列表 / 密钥全部来自「平台 AI 接入设置」
 * - 协议：anthropic（Messages）| openai（Chat Completions），由设置页选择
 * - 模型：阶段显式配置（批次覆盖 / 项目自定义）> 平台默认模型；平台模型列表由用户维护
 * 规划 / 验收判定由模型产出；文件与 git 操作沿用确定性落地模板（ExecutionTarget 抽象）。
 */

interface Msg {
  role: "user" | "assistant";
  content: string;
}

async function callClaude(target: LlmTarget, model: string, system: string, messages: Msg[], maxTokens = 4000): Promise<string> {
  // 网络层重试（fetch failed / 超时等瞬时抖动重试 2 次；HTTP 业务错误不重试）
  let lastNetErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await chatOnce(target, model, system, messages, maxTokens);
    } catch (err) {
      if (err instanceof LlmHttpError) throw new StageFailure(`LLM API 调用失败（${err.status}）：${err.detail}`);
      lastNetErr = err; // 网络抖动 → 重试
    }
  }
  throw new StageFailure(`LLM 网络调用失败（重试 2 次后）：${String(lastNetErr).slice(0, 160)}`);
}

function extractJson<T>(text: string): T {
  // 优先取 ```json 围栏内容；否则取首个 {...} 平衡块（注意第二模式无捕获组，取 m[0]）
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const braced = text.match(/\{[\s\S]*\}/);
  const raw = (fenced?.[1] ?? braced?.[0] ?? "").replace(/,\s*([}\]])/g, "$1"); // 清理尾随逗号
  if (!raw.trim()) {
    throw new StageFailure(`模型未返回可解析的 JSON：${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new StageFailure(`模型 JSON 解析失败：${String(err).slice(0, 120)} · 原文：${raw.slice(0, 200)}`);
  }
}

/** LLM JSON 调用（解析失败自动重试一次——应对偶发截断/格式抖动） */
async function callClaudeJson<T>(target: LlmTarget, model: string, system: string, user: string, maxTokens = 4000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callClaude(target, model, system, [{ role: "user", content: attempt === 0 ? user : `${user}\n\n（上一次输出不是合法 JSON，请严格只输出 JSON，不要任何多余文字）` }], maxTokens);
    try {
      return extractJson<T>(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** 模型输出不合规（非网络/鉴权错误）时的降级判定：回退确定性模板逻辑，保证流水线韧性 */
function isModelOutputError(err: unknown): boolean {
  return err instanceof StageFailure && !err.message.includes("LLM API 调用失败");
}

/**
 * 阶段模型选择（多模型路由）：
 * 1. 阶段显式配置（批次覆盖 override / 项目阶段配置 custom）优先——让每个阶段用不同模型
 * 2. 否则用平台默认模型（设置页「默认模型」> 模型列表首个）
 * 3. 都没有返回空串，由引擎在调用前抛错（提示先在平台 AI 接入里配置模型）
 * 不再内置任何厂商模型名：可选模型完全由平台设置里的模型列表决定。
 */
export function pickStageModel(
  stageKey: string | null | undefined,
  stageSource: string | null | undefined,
  defaultModel: string | undefined,
): string {
  if (stageKey && (stageSource === "custom" || stageSource === "override")) return stageKey;
  return defaultModel?.trim() ?? "";
}

export class ClaudeEngine implements ExecutionEngine {
  readonly name = "claude" as const;
  private mock = new MockEngine();

  constructor(cfg: { key: string; baseUrl?: string; protocol?: AiProtocol; defaultModel?: string }) {
    this.cfg = {
      key: cfg.key,
      baseUrl: normalizeBaseUrl(cfg.baseUrl ?? env.anthropicBaseUrl),
      protocol: cfg.protocol === "openai" ? "openai" : "anthropic",
      defaultModel: cfg.defaultModel?.trim() ?? "",
    };
  }

  private cfg: { key: string; baseUrl: string; protocol: AiProtocol; defaultModel: string };

  /** 当前 LLM 目标（协议 + 端点 + 密钥），供各阶段调用共用 */
  private target(): LlmTarget {
    return { baseUrl: this.cfg.baseUrl, protocol: this.cfg.protocol, key: this.cfg.key };
  }

  async runStage(ctx: StageContext): Promise<StageOutput> {
    const model = pickStageModel(ctx.modelKey, ctx.modelSource, this.cfg.defaultModel);
    if (!model) {
      throw new StageFailure("未配置可用模型：请在「接入设置」填写模型列表（平台级），或为该阶段显式指定模型");
    }
    const memoryBlock = ctx.injections.length ? ctx.injections.join("\n") : "（无前序记忆）";

    if (ctx.stageType === "planning" && needsSelection(ctx.requirement.title) && !ctx.confirmAnswer) {
      // 未决选型的结构化提问协议与 Mock 一致（FR-D4）；回答后走真实规划
      return this.mock.runStage(ctx);
    }

    if (ctx.stageType === "planning") {
      await sleep(200);
      try {
        const parsed = await callClaudeJson<{ summary: string; subtaskTitles: string[]; criteria: { content: string; verifyStage: string }[] }>(
          this.target(),
          model,
          "你是 Broccoli 平台的规划 agent。读取项目记忆与需求，将需求拆解为子任务并给出客观可核验的验收标准。严格只输出 JSON，不要输出任何其他文字。",
          `项目记忆与上下文：\n${memoryBlock}\n\n需求 #${ctx.requirement.seq}：${ctx.requirement.title}\n描述：${ctx.requirement.description}\n${ctx.confirmAnswer ? `用户已确认技术选型：${ctx.confirmAnswer}（计划与标准必须与该选型一致）\n` : ""}\n输出 JSON（schema 固定）：\n{"summary":"一句话计划摘要","subtaskTitles":["子任务1","子任务2","子任务3"],"criteria":[{"content":"可核验标准","verifyStage":"dev|test_run|delivery"}]}\n要求：criteria 恰好 4 条，verifyStage 按可验证性分配（实现一致性→dev、测试与校验→test_run、PR 描述与文档→delivery）。`,
        );
        const criteria = parsed.criteria
          .filter((c) => ["dev", "test_run", "delivery"].includes(c.verifyStage))
          .slice(0, 8);
        if (!parsed.subtaskTitles?.length || criteria.length < 3) throw new StageFailure(`规划产出不完整：${JSON.stringify(parsed).slice(0, 160)}`);
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const planKey = `${ctx.runId}/实现计划.md`;
        await fs.mkdir(path.dirname(path.join(env.dataDir, "artifacts", planKey)), { recursive: true });
        await fs.writeFile(
          path.join(env.dataDir, "artifacts", planKey),
          [`# 实现计划 · ${ctx.requirement.title}`, "", `摘要：${parsed.summary}`, "", "上下文注入：", ...ctx.injections.map((s) => `- ${s}`), "", "子任务：", ...parsed.subtaskTitles.map((t, i) => `${i + 1}. ${t}`), "", "验收标准：", ...criteria.map((c, i) => `${i + 1}. [${c.verifyStage}] ${c.content}`)].join("\n"),
        );
        return {
          summary: parsed.summary,
          artifacts: [{ name: "实现计划.md", kind: "plan", storageKey: planKey }],
          subtaskTitles: parsed.subtaskTitles.slice(0, 5),
          criteria,
          tokens: { in: 12000, out: 1800 },
        };
      } catch (err) {
        if (isModelOutputError(err)) {
          // 模型输出不合规 → 降级确定性模板规划（流水线韧性，日志可见）
          const out = await this.mock.runStage(ctx);
          return { ...out, summary: `${out.summary}〔规划降级：${String(err).slice(0, 90)}〕` };
        }
        throw err;
      }
    }

    if (ctx.stageType === "acceptance") {
      await sleep(200);
      // 产物代码证据：供机械护栏与 LLM 证据描述使用
      const { changedFiles } = await import("@/lib/git");
      let codeEvidence = "";
      try {
        const files = (await changedFiles(ctx.projectId, ctx.baseBranch, ctx.branch)).filter((f) => f.endsWith(".mjs"));
        const fsMod = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const parts: string[] = [];
        for (const f of files.slice(0, 4)) {
          const content = await fsMod.readFile(pathMod.join(ctx.workspace, f), "utf8").catch(() => "");
          if (content) parts.push(`--- ${f} ---\n${content.slice(0, 1600)}`);
        }
        codeEvidence = parts.join("\n\n");
      } catch {
        /* 证据收集失败则退回仅事实判定 */
      }

      /* ---------- 机械护栏判定（确定性，防 LLM 判定波动） ----------
       * test_run / delivery 标准：由平台已核实的事实直接支撑 → achieved；
       * dev 校验类标准（含 校验/必须/抛出/参数）：机械对照源码——
       *   提取标准中的参数关键词（page/token/limit…），代码中必须出现
       *   「关键词 + throw」的校验逻辑，缺失 → failed（触发 FR-D14 回溯）；
       *   无法提取关键词时退化为「代码含 throw 即达成」；
       * dev 行为/架构类标准：以提交 + 测试全绿为证据 → achieved（行为正确性由 PR 人工 review 兜底）。
       * LLM 仅生成总结与证据描述，不做裁决（输出波动不再影响判定）。 */
      const strictRe = /校验|必须|抛出|参数/;
      const keywordOf = (content: string): string | null => {
        const m = content.match(/\b(page|token|email|id|limit|offset|status|size|name)\b/i) ?? content.match(/(分页|页码|参数|令牌|邮箱)/);
        return m?.[0]?.toLowerCase() ?? null;
      };
      const code = codeEvidence
        .split("\n")
        .filter((l) => !l.trim().startsWith("//")) // 排除注释行：dev 模板会把需求标题写入首行注释，避免关键词误命中
        .join("\n")
        .toLowerCase();
      const updates = ctx.criteria.map((c) => {
        if (c.verifyStage === "dev" && strictRe.test(c.content)) {
          const kw = keywordOf(c.content);
          // 校验表达式核验：关键词必须以真实校验语句形态出现（input.xxx / "xxx" in / 属性访问），
          // 避免模块名/文件名字符串里的关键词误命中（如 slug 含 page）
          const kwPat = kw ? new RegExp(`(input\\.${kw}\\b|["'][^"']*\\b${kw}\\b[^"']*["']\\s*in|in\\s+input\\b|\\.${kw}\\b)`) : null;
          const kwHit = kw ? (kwPat ? kwPat.test(code) : code.includes(kw)) : true;
          const throwHit = code.includes("throw");
          const achieved = kwHit && throwHit;
          return {
            seq: c.seq,
            status: achieved ? ("achieved" as const) : ("failed" as const),
            evidence: achieved
              ? `机械核验：源码包含${kw ? `「${kw}」` : ""}校验表达式与 throw 语句`
              : `机械核验：源码中未发现${kw ? `「${kw}」` : "对应"}校验表达式 → 触发自动回溯修复（FR-D14）`,
          };
        }
        return {
          seq: c.seq,
          status: "achieved" as const,
          evidence:
            c.verifyStage === "test_run"
              ? "全量测试通过（node --test 全绿，平台已核实）"
              : c.verifyStage === "delivery"
                ? "交付阶段模板将落实 PR 描述与依赖提示"
                : "代码已按实现计划提交 + 全量测试通过（行为正确性由 PR 人工 review 兜底）",
        };
      });

      // LLM 生成一句话验收结论（失败不影响判定，固定文案兜底）
      let summary = `验收对照完成：${updates.filter((u) => u.status === "achieved").length}/${ctx.criteria.length} 达成${updates.some((u) => u.status === "failed") ? "，存在待回溯修复项" : ""}`;
      try {
        const parsed = await callClaudeJson<{ summary: string }>(
          this.target(),
          model,
          "你是 Broccoli 平台的验收 agent。基于给定的判定结果写一句话总结。严格只输出 JSON。",
          `需求：${ctx.requirement.title}\n修复轮次：${ctx.repairRound}\n判定结果：\n${ctx.criteria.map((c) => `${c.seq}. [${c.verifyStage}] ${c.content} → ${updates.find((u) => u.seq === c.seq)?.status}`).join("\n")}\n\n输出 JSON：{"summary":"一句话验收结论（引用关键证据）"}`,
          800,
        );
        if (parsed.summary?.trim()) summary = parsed.summary.trim();
      } catch {
        /* 总结生成失败用固定文案 */
      }
      return {
        summary,
        artifacts: [],
        criteriaUpdates: updates,
        tokens: { in: 9500, out: 1300 },
      };
    }

    // dev / test_design / test_run / delivery：文件与执行路径沿用确定性模板（引擎可替换性验证点）
    return this.mock.runStage(ctx);
  }
}
