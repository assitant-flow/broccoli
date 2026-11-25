/**
 * 单元测试：阶段模型路由（src/lib/engine/claude.ts pickStageModel）
 * 语义：阶段显式配置（override/custom）> 平台默认模型；不再内置任何厂商模型名。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStageModel } from "../../src/lib/engine/claude";

test("阶段显式配置优先：批次覆盖 override 生效", () => {
  assert.equal(pickStageModel("model-a", "override", "model-default"), "model-a");
});

test("阶段显式配置优先：项目自定义 custom 生效", () => {
  assert.equal(pickStageModel("model-b", "custom", "model-default"), "model-b");
});

test("未显式配置：用平台默认模型", () => {
  assert.equal(pickStageModel("", "recommended", "model-default"), "model-default");
  assert.equal(pickStageModel(null, null, "model-default"), "model-default");
});

test("平台未配置模型：返回空串（由引擎提示去设置页配置，而不是回落到某个内置模型）", () => {
  assert.equal(pickStageModel("", "recommended", ""), "");
  assert.equal(pickStageModel(undefined, undefined, undefined), "");
  assert.equal(pickStageModel("  ", "recommended", "  "), "");
});

test("每阶段可各不相同（平台模型列表内的多模型并存）", () => {
  const cfg: Record<string, { key: string; source: string }> = {
    planning: { key: "model-strong", source: "custom" },
    dev: { key: "model-fast", source: "custom" },
    test_run: { key: "model-cheap", source: "custom" },
  };
  const pick = (stage: string) => pickStageModel(cfg[stage]?.key, cfg[stage]?.source, "model-default");
  assert.equal(pick("planning"), "model-strong");
  assert.equal(pick("dev"), "model-fast");
  assert.equal(pick("test_run"), "model-cheap");
  assert.equal(pick("acceptance"), "model-default", "未配置的阶段走平台默认");
});

export {};
