/**
 * 单元测试：阶段模型路由（src/lib/engine/claude.ts pickStageModel）
 * 语义：阶段显式配置（override/custom）> 账号接入默认 > 平台 env > 内置推荐
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStageModel } from "../../src/lib/engine/claude";

test("阶段显式配置优先：批次覆盖 override 生效", () => {
  assert.equal(
    pickStageModel("glm:glm-5.3-flash", "override", "glm:glm-5.3[1m]", undefined, "dev"),
    "glm:glm-5.3-flash",
  );
});

test("阶段显式配置优先：项目自定义 custom 生效", () => {
  assert.equal(
    pickStageModel("ds:deepseek-v4-pro", "custom", undefined, "glm:glm-5.3[1m]", "planning"),
    "ds:deepseek-v4-pro",
  );
});

test("阶段为推荐时：账号接入默认生效", () => {
  assert.equal(
    pickStageModel("claude-sonnet-4-5", "recommended", "glm:glm-5.3[1m]", undefined, "dev"),
    "glm:glm-5.3[1m]",
  );
});

test("账号默认留空：平台 env 生效", () => {
  assert.equal(pickStageModel("claude-opus-4-6", "recommended", "", "glm:glm-5.3[1m]", "planning"), "glm:glm-5.3[1m]");
});

test("全部留空：内置 claude-* 推荐映射", () => {
  assert.equal(pickStageModel(null, null, undefined, undefined, "planning"), "claude-opus-4-6");
  assert.equal(pickStageModel(null, null, undefined, undefined, "test_run"), "claude-haiku-4-5");
  assert.equal(pickStageModel(undefined, undefined, undefined, undefined, "unknown"), "claude-sonnet-4-5");
});

test("每阶段可各不相同（多模型并存的典型配置）", () => {
  const cfg: Record<string, { key: string; source: string }> = {
    planning: { key: "glm:glm-5.3[1m]", source: "custom" },
    dev: { key: "glm:glm-5.3-flash", source: "custom" },
    test_run: { key: "ds:deepseek-flash", source: "custom" },
  };
  const pick = (stage: string) => pickStageModel(cfg[stage]?.key, cfg[stage]?.source, undefined, undefined, stage);
  assert.equal(pick("planning"), "glm:glm-5.3[1m]");
  assert.equal(pick("dev"), "glm:glm-5.3-flash");
  assert.equal(pick("test_run"), "ds:deepseek-flash");
  assert.equal(pick("acceptance"), "claude-sonnet-4-5", "未配置的阶段走内置推荐");
});

export {};
