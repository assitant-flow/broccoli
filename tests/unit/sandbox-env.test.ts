/**
 * 单元测试：沙箱子进程环境白名单（src/lib/sandbox/safe-env.ts）
 * 目标：仓库测试代码读不到平台密钥（数据库连接串、主密钥、会话密钥、平台 Token）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxEnv } from "../../src/lib/sandbox/safe-env";

const PLATFORM_SECRETS = {
  DATABASE_URL: "postgres://broccoli:x@postgres:5432/broccoli",
  BROCCOLI_MASTER_KEY: "master-key-material",
  SESSION_SECRET: "session-secret-material",
  GITHUB_TOKEN: "ghp_platform",
  GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
  ANTHROPIC_AUTH_TOKEN: "sk-platform",
};

test("沙箱环境：不继承任何平台密钥", () => {
  const env = buildSandboxEnv({ PATH: "/usr/bin", HOME: "/home/node", ...PLATFORM_SECRETS });
  for (const key of Object.keys(PLATFORM_SECRETS)) {
    assert.equal(key in env, false, `${key} 不应进入沙箱`);
  }
  const values = Object.values(env).join(" ");
  for (const secret of Object.values(PLATFORM_SECRETS)) {
    assert.equal(values.includes(secret), false, "任何值都不应携带平台密钥");
  }
});

test("沙箱环境：保留运行所需的 PATH/HOME 并固定 CI 标记", () => {
  const env = buildSandboxEnv({ PATH: "/usr/bin:/bin", HOME: "/home/node" });
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/node");
  assert.equal(env.CI, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("沙箱环境：缺省变量不写入空值", () => {
  const env = buildSandboxEnv({});
  assert.equal("PATH" in env, false);
});

export {};
