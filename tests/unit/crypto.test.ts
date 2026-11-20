/**
 * 单元测试：加密与会话（src/lib/crypto.ts）
 * 运行：pnpm test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  encryptSecret,
  decryptSecret,
  maskSecret,
  signSession,
  verifySession,
} from "../../src/lib/crypto";

test("密码：哈希可验证，错误密码被拒", () => {
  const hash = hashPassword("broccoli123");
  assert.ok(hash.includes(":"), "哈希应含 salt 前缀");
  assert.equal(verifyPassword("broccoli123", hash), true);
  assert.equal(verifyPassword("wrong-pass", hash), false);
});

test("密码：相同密码每次哈希不同（随机 salt）", () => {
  const a = hashPassword("same-pass");
  const b = hashPassword("same-pass");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("same-pass", a), true);
  assert.equal(verifyPassword("same-pass", b), true);
});

test("凭证加密：AES-256-GCM 往返还原明文", () => {
  const secret = "sk-ant-api03-test-token-value";
  const { ciphertext, nonce } = encryptSecret(secret);
  assert.ok(nonce.length === 24, "nonce 为 12 字节 hex");
  assert.ok(!ciphertext.includes(secret), "密文不含明文");
  assert.equal(decryptSecret(ciphertext), secret);
});

test("凭证加密：密文被篡改时解密失败", () => {
  const { ciphertext } = encryptSecret("another-secret-value");
  const raw = Buffer.from(ciphertext, "base64");
  raw[raw.length - 1] ^= 0xff; // 篡改最后一字节
  assert.throws(() => decryptSecret(raw.toString("base64")));
});

test("凭证掩码：中段隐藏、保留首尾", () => {
  const masked = maskSecret("sk-ant-api03-abcdef-wxyz-3fA2");
  assert.ok(masked.startsWith("sk-ant-a"));
  assert.ok(masked.endsWith("3fA2"));
  assert.ok(!masked.includes("abcdef"), "中段不得回显");
});

test("会话：签名可验证、篡改签名被拒", () => {
  const token = signSession({ uid: "u-123" });
  const payload = verifySession<{ uid: string; exp: number }>(token);
  assert.ok(payload && payload.uid === "u-123");
  const tampered = token.slice(0, -4) + "AAAA";
  assert.equal(verifySession(tampered), null);
});

test("会话：过期 token 被拒", () => {
  const expired = signSession({ uid: "u-1" }, -1000); // exp 已过
  assert.equal(verifySession(expired), null);
});

test("会话：畸形 token 被拒", () => {
  assert.equal(verifySession(undefined), null);
  assert.equal(verifySession(""), null);
  assert.equal(verifySession("not-a-token"), null);
  assert.equal(verifySession("a.b"), null);
});

export {};
