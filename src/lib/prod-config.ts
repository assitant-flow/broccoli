/**
 * 公网部署配置校验（BROCCOLI_MODE=public 时严格执行）。
 * 纯函数、无副作用：启动守卫（instrumentation）与入口脚本（check-prod）共用。
 * local 模式保持开发宽松行为（默认密钥、演示账号、共享平台 Token 均可用）。
 */

export type Raw = Record<string, string | undefined>;
export type ConfigIssue = { level: "error" | "warn"; key: string; message: string };

/** 含示例/默认字样的口令一律拒绝（hex 随机串天然不命中这些词） */
const WEAK_PATTERN = /change|example|replace|default|password|secret$|^dev-|broccoli-dev/i;

export function isStrongSecret(value: string | undefined): boolean {
  if (!value || value.length < 32) return false;
  if (WEAK_PATTERN.test(value)) return false;
  return new Set(value).size >= 8; // 字符种类过少（低熵）视为弱口令
}

const DEFAULT_DB_PASSWORDS = new Set(["broccoli", "postgres", "password", "change-me"]);

export function dbPasswordOf(url: string | undefined): string | null {
  const m = url?.match(/^postgres(?:ql)?:\/\/[^:@/]+:([^@]*)@/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function resolveMode(raw: Raw): "local" | "public" {
  return raw.BROCCOLI_MODE === "public" ? "public" : "local";
}

/** 注册策略：显式声明优先；未声明 → 公网 closed、本地 open */
export function resolveRegistration(raw: Raw): "open" | "closed" {
  if (raw.BROCCOLI_REGISTRATION === "open" || raw.BROCCOLI_REGISTRATION === "closed") return raw.BROCCOLI_REGISTRATION;
  return resolveMode(raw) === "public" ? "closed" : "open";
}

/** 平台共享凭证（ANTHROPIC_AUTH_TOKEN / GITHUB_TOKEN 对所有账号可用）：公网默认关闭 */
export function resolveSharedCredentials(raw: Raw): boolean {
  if (raw.BROCCOLI_SHARED_CREDENTIALS === "1") return true;
  if (raw.BROCCOLI_SHARED_CREDENTIALS === "0") return false;
  return resolveMode(raw) === "local";
}

/** 演示账号（固定口令种子）：公网默认关闭 */
export function resolveSeedDemo(raw: Raw): boolean {
  if (raw.BROCCOLI_SEED_DEMO === "1") return true;
  if (raw.BROCCOLI_SEED_DEMO === "0") return false;
  return resolveMode(raw) === "local";
}

export function checkConfig(raw: Raw): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const err = (key: string, message: string) => issues.push({ level: "error", key, message });
  const warn = (key: string, message: string) => issues.push({ level: "warn", key, message });

  if (raw.BROCCOLI_MODE && raw.BROCCOLI_MODE !== "local" && raw.BROCCOLI_MODE !== "public") {
    err("BROCCOLI_MODE", "仅支持 local 或 public");
  }
  if (resolveMode(raw) !== "public") return issues;

  if (!isStrongSecret(raw.SESSION_SECRET)) err("SESSION_SECRET", "需 ≥32 位随机串（openssl rand -hex 32），不能含示例或默认字样");
  if (!isStrongSecret(raw.BROCCOLI_MASTER_KEY)) err("BROCCOLI_MASTER_KEY", "需 ≥32 位随机串；设定后不可更换（否则已存 Token 无法解密）");

  const pw = dbPasswordOf(raw.DATABASE_URL);
  if (!pw || pw.length < 12 || DEFAULT_DB_PASSWORDS.has(pw)) {
    err("DATABASE_URL", "数据库口令需 ≥12 位且不能是默认值（postgres://用户:口令@主机:端口/库）");
  }

  const site = raw.BROCCOLI_SITE_URL ?? "";
  if (!site.startsWith("https://")) {
    if (raw.BROCCOLI_INSECURE_HTTP === "1") warn("BROCCOLI_SITE_URL", "当前为 http（BROCCOLI_INSECURE_HTTP=1），仅限本地预演");
    else err("BROCCOLI_SITE_URL", "公网必须为 https:// 域名（OAuth 回调与安全 Cookie 依赖它）");
  }

  if (resolveSeedDemo(raw)) err("BROCCOLI_SEED_DEMO", "公网禁止演示账号（固定口令），请设为 0");
  if (raw.BROCCOLI_REGISTRATION && raw.BROCCOLI_REGISTRATION !== "open" && raw.BROCCOLI_REGISTRATION !== "closed") {
    err("BROCCOLI_REGISTRATION", "仅支持 open 或 closed");
  }
  if ((raw.BROCCOLI_SANDBOX ?? "local") === "local" && raw.BROCCOLI_ACK_LOCAL_SANDBOX !== "1") {
    err("BROCCOLI_SANDBOX", "local 沙箱在应用容器内执行仓库测试代码（可触达数据卷与数据库连接），仅适用于可信用户；确认风险后设置 BROCCOLI_ACK_LOCAL_SANDBOX=1");
  }
  if (raw.BROCCOLI_SHARED_CREDENTIALS === "1") {
    warn("BROCCOLI_SHARED_CREDENTIALS", "平台 Token 将被所有账号共用（费用与 GitHub 权限外溢）");
  }
  return issues;
}
