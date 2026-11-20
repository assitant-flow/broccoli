/**
 * 单元测试：引擎杂项纯函数（slugify / 需求分类谓词 / StageFailure）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, StageFailure } from "../../src/lib/engine/types";
import {
  needsSelection,
  wantsFailure,
  wantsRepair,
  isServiceRequirement,
} from "../../src/lib/engine/mock";

test("slugify：ASCII 小写与连字符", () => {
  assert.equal(slugify("Fix Login Redirect!"), "fix-login-redirect");
});

test("slugify：剔除 [标记] 与多余连字符", () => {
  assert.equal(slugify("[fail-tests] some Task"), "some-task");
});

test("slugify：纯中文回退 req（分支/文件名由 seq 保证唯一）", () => {
  assert.equal(slugify("引入会话持久化存储"), "req");
});

test("slugify：空串回退 req", () => {
  assert.equal(slugify("!!!"), "req");
  assert.equal(slugify(""), "req");
});

test("needsSelection：存储/数据库/选型关键词触发", () => {
  assert.equal(needsSelection("引入会话持久化存储"), true);
  assert.equal(needsSelection("数据库选型"), true);
  assert.equal(needsSelection("修复登录重定向"), false);
});

test("wantsFailure：[fail-tests] 标记触发", () => {
  assert.equal(wantsFailure("新增深色模式切换 [fail-tests]"), true);
  assert.equal(wantsFailure("新增深色模式切换"), false);
});

test("wantsRepair：[repair] 标记触发", () => {
  assert.equal(wantsRepair("添加分页 [repair]"), true);
  assert.equal(wantsRepair("添加分页"), true); // 分页关键词也触发（演示场景）
  assert.equal(wantsRepair("修复登录"), false);
});

test("isServiceRequirement：启动/服务/端点/server 关键词触发", () => {
  assert.equal(isServiceRequirement("启动一个 HTTP 服务"), true);
  assert.equal(isServiceRequirement("新增 /api/version 端点"), true);
  assert.equal(isServiceRequirement("run the server"), true);
  assert.equal(isServiceRequirement("修复登录重定向"), false);
});

test("StageFailure：可被 instanceof 识别（驱动失败策略）", () => {
  const e = new StageFailure("测试未全部通过");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof StageFailure);
  assert.equal(e.name, "StageFailure");
});

export {};
