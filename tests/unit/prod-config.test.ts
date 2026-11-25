/**
 * 单元测试：公网部署配置校验（src/lib/prod-config.ts）
 * 覆盖：默认/弱口令拒绝、https 要求、演示账号门控、local 沙箱确认、注册与共享凭证默认值。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkConfig,
  dbPasswordOf,
  isStrongSecret,
  resolveRegistration,
  resolveSeedDemo,
  resolveSharedCredentials,
} from "../../src/lib/prod-config";

const STRONG = {
  BROCCOLI_MODE: "public",
  SESSION_SECRET: "3f9c1e7b2d84f60a9e5c3b1d7f2e8a4c6b0d9e1f3a5b7c9d2e4f6a8b0c1d3e5f",
  BROCCOLI_MASTER_KEY: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
  DATABASE_URL: "postgres://broccoli:9f8e7d6c5b4a39281706f5e4@postgres:5432/broccoli",
  BROCCOLI_SITE_URL: "https://broccoli.example.com",
  BROCCOLI_SEED_DEMO: "0",
  BROCCOLI_REGISTRATION: "closed",
  BROCCOLI_SANDBOX: "local",
  BROCCOLI_ACK_LOCAL_SANDBOX: "1",
};

const keysOf = (issues: { key: string; level: string }[], level: string) =>
  issues.filter((i) => i.level === level).map((i) => i.key);

test("本地模式：默认配置不做拒绝（开发宽松）", () => {
  assert.deepEqual(checkConfig({}), []);
});

test("公网模式：完整强配置通过", () => {
  assert.deepEqual(checkConfig(STRONG), []);
});

test("公网模式：示例/默认 SESSION_SECRET 被拒", () => {
  const issues = checkConfig({ ...STRONG, SESSION_SECRET: "dev-session-secret-change-me" });
  assert.ok(keysOf(issues, "error").includes("SESSION_SECRET"));
});

test("公网模式：默认 BROCCOLI_MASTER_KEY 被拒", () => {
  const issues = checkConfig({ ...STRONG, BROCCOLI_MASTER_KEY: "dev-master-key-change-me-32bytes!!" });
  assert.ok(keysOf(issues, "error").includes("BROCCOLI_MASTER_KEY"));
});

test("公网模式：默认数据库口令 broccoli:broccoli 被拒", () => {
  const issues = checkConfig({ ...STRONG, DATABASE_URL: "postgres://broccoli:broccoli@postgres:5432/broccoli" });
  assert.ok(keysOf(issues, "error").includes("DATABASE_URL"));
});

test("公网模式：http 站点被拒；本地预演开关下降级为警告", () => {
  assert.ok(keysOf(checkConfig({ ...STRONG, BROCCOLI_SITE_URL: "http://localhost:8088" }), "error").includes("BROCCOLI_SITE_URL"));
  const relaxed = checkConfig({ ...STRONG, BROCCOLI_SITE_URL: "http://localhost:8088", BROCCOLI_INSECURE_HTTP: "1" });
  assert.deepEqual(keysOf(relaxed, "error"), []);
  assert.deepEqual(keysOf(relaxed, "warn"), ["BROCCOLI_SITE_URL"]);
});

test("公网模式：演示账号开启被拒", () => {
  const issues = checkConfig({ ...STRONG, BROCCOLI_SEED_DEMO: "1" });
  assert.ok(keysOf(issues, "error").includes("BROCCOLI_SEED_DEMO"));
});

test("公网模式：local 沙箱未确认被拒，确认后通过", () => {
  const { BROCCOLI_ACK_LOCAL_SANDBOX: _ack, ...noAck } = STRONG;
  assert.ok(keysOf(checkConfig(noAck), "error").includes("BROCCOLI_SANDBOX"));
  assert.deepEqual(checkConfig(STRONG), []);
});

test("公网模式：共享平台 Token 只给警告", () => {
  const issues = checkConfig({ ...STRONG, BROCCOLI_SHARED_CREDENTIALS: "1" });
  assert.deepEqual(keysOf(issues, "error"), []);
  assert.deepEqual(keysOf(issues, "warn"), ["BROCCOLI_SHARED_CREDENTIALS"]);
});

test("非法 BROCCOLI_MODE 被拒", () => {
  assert.ok(keysOf(checkConfig({ BROCCOLI_MODE: "prod" }), "error").includes("BROCCOLI_MODE"));
});

test("默认值：本地宽松、公网严格", () => {
  assert.equal(resolveRegistration({}), "open");
  assert.equal(resolveRegistration({ BROCCOLI_MODE: "public" }), "closed");
  assert.equal(resolveRegistration({ BROCCOLI_MODE: "public", BROCCOLI_REGISTRATION: "open" }), "open");
  assert.equal(resolveSharedCredentials({}), true);
  assert.equal(resolveSharedCredentials({ BROCCOLI_MODE: "public" }), false);
  assert.equal(resolveSeedDemo({}), true);
  assert.equal(resolveSeedDemo({ BROCCOLI_MODE: "public" }), false);
});

test("强度判定：hex 随机串通过；短串、低熵、含示例字样被拒", () => {
  assert.equal(isStrongSecret("3f9c1e7b2d84f60a9e5c3b1d7f2e8a4c6b0d9e1f3a5b7c9d2e4f6a8b0c1d3e5f"), true);
  assert.equal(isStrongSecret("short"), false);
  assert.equal(isStrongSecret("a".repeat(40)), false);
  assert.equal(isStrongSecret("this-is-an-example-value-0123456789"), false);
});

test("数据库口令解析：支持 URL 编码", () => {
  assert.equal(dbPasswordOf("postgres://u:p%40ss@h:5432/db"), "p@ss");
  assert.equal(dbPasswordOf("not-a-url"), null);
});

export {};
