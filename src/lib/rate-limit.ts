/**
 * 进程内滑动窗口限流（单实例部署；多实例需换 Redis，见 docs/DEPLOY-PUBLIC.md）。
 * 状态挂在 globalThis，热重载不丢计数。
 */

type Store = Map<string, number[]>;
const g = globalThis as unknown as { __broccoliRateLimit?: Store };
const store: Store = (g.__broccoliRateLimit ??= new Map());

export type RateResult = { allowed: boolean; retryAfterSec: number };

/** 只检查不记录：窗口内已达 limit 则拒绝 */
export function peekRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  const recent = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** 记录一次尝试：窗口内已达 limit 则拒绝（不计入），否则计入并放行 */
export function consumeRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  const recent = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    store.set(key, recent);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
  }
  recent.push(now);
  store.set(key, recent);
  if (store.size > 10_000) sweep(now, windowMs);
  return { allowed: true, retryAfterSec: 0 };
}

function sweep(now: number, windowMs: number) {
  for (const [key, hits] of store) {
    if (!hits.length || now - hits[hits.length - 1] >= windowMs) store.delete(key);
  }
}

/**
 * 客户端 IP：取 X-Forwarded-For 的最右一跳（由反向代理 Caddy 追加的真实来源），
 * 不取左侧——左侧可由客户端任意伪造。无代理直连时退化为 X-Real-IP 或 unknown。
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").map((s) => s.trim()).filter(Boolean).pop() ?? "unknown";
  return req.headers.get("x-real-ip") ?? "unknown";
}
