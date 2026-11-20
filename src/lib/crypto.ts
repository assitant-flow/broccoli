import crypto from "node:crypto";
import { env } from "./env";

/* ============ 密码（scrypt，FR-A1） ============ */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ============ 凭证加密（AES-256-GCM，FR-H1） ============ */

function kek(): Buffer {
  return crypto.createHash("sha256").update(env.masterKey).digest();
}

export function encryptSecret(plain: string): { ciphertext: string; nonce: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([iv, tag, enc]).toString("base64"), nonce: iv.toString("hex") };
}

export function decryptSecret(ciphertext: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", kek(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** 界面回显掩码（永不明文回显，AC-A2） */
export function maskSecret(plain: string): string {
  if (plain.length <= 10) return "•".repeat(plain.length);
  return `${plain.slice(0, 8)}${"•".repeat(Math.max(8, plain.length - 12))}${plain.slice(-4)}`;
}

/* ============ 会话签名 Cookie ============ */

export function signSession(payload: object, ttlMs = 1000 * 60 * 60 * 24 * 7): string {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const data = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = crypto.createHmac("sha256", env.sessionSecret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifySession<T = { uid: string; exp: number }>(token: string | undefined): T | null {
  if (!token) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = crypto.createHmac("sha256", env.sessionSecret).update(data).digest("base64url");
  // 畸形签名长度不同会导致 timingSafeEqual 抛异常 —— 长度守卫后再比较
  const sigBuf = Buffer.from(sig, "base64url");
  const expectedBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload as T;
  } catch {
    return null;
  }
}
