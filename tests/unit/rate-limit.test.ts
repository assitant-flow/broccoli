/**
 * 单元测试：滑动窗口限流与客户端 IP 取值（src/lib/rate-limit.ts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeRateLimit, peekRateLimit, clientIp } from "../../src/lib/rate-limit";

test("限流：窗口内达到上限后拒绝，并给出重试秒数", () => {
  const key = "t:limit:basic";
  for (let i = 0; i < 3; i++) assert.equal(consumeRateLimit(key, 3, 1000, 0).allowed, true);
  const blocked = consumeRateLimit(key, 3, 1000, 0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 1);
});

test("限流：窗口过后恢复放行", () => {
  const key = "t:limit:recover";
  for (let i = 0; i < 2; i++) consumeRateLimit(key, 2, 1000, 0);
  assert.equal(consumeRateLimit(key, 2, 1000, 500).allowed, false);
  assert.equal(consumeRateLimit(key, 2, 1000, 1001).allowed, true);
});

test("限流：被拒的尝试不计入窗口（不会越拒越久）", () => {
  const key = "t:limit:denied-not-counted";
  consumeRateLimit(key, 1, 1000, 0);
  for (let t = 100; t < 900; t += 100) consumeRateLimit(key, 1, 1000, t);
  assert.equal(consumeRateLimit(key, 1, 1000, 1001).allowed, true, "第一次命中滑出窗口后应放行");
});

test("限流：不同 key 相互独立", () => {
  consumeRateLimit("t:limit:a", 1, 1000, 0);
  assert.equal(consumeRateLimit("t:limit:a", 1, 1000, 0).allowed, false);
  assert.equal(consumeRateLimit("t:limit:b", 1, 1000, 0).allowed, true);
});

test("只检查不记录：反复 peek 不消耗额度（成功登录不计失败）", () => {
  const key = "t:peek:no-record";
  for (let i = 0; i < 5; i++) assert.equal(peekRateLimit(key, 1, 1000, 0).allowed, true);
  assert.equal(consumeRateLimit(key, 1, 1000, 0).allowed, true, "首次记录仍放行");
  assert.equal(peekRateLimit(key, 1, 1000, 0).allowed, false, "达到上限后 peek 即拒绝");
});

test("客户端 IP：取 X-Forwarded-For 最右一跳（防左侧伪造）", () => {
  const req = new Request("http://x", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
  assert.equal(clientIp(req), "203.0.113.9");
});

test("客户端 IP：无代理头时退化为 X-Real-IP 或 unknown", () => {
  assert.equal(clientIp(new Request("http://x", { headers: { "x-real-ip": "10.0.0.7" } })), "10.0.0.7");
  assert.equal(clientIp(new Request("http://x")), "unknown");
});

export {};
