import crypto from "node:crypto";
import { db } from "@/db";
import { credentials, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { signSession, encryptSecret, hashPassword } from "@/lib/crypto";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { env } from "@/lib/env";
import { cookies } from "next/headers";

/**
 * GitHub OAuth 回调：state 校验 → code 换 token → 拉取用户 → find-or-create
 * → token 加密入库（provider=github，github origin 项目直接可用）→ 会话 Cookie → 回首页。
 */
export async function GET(req: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "";
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const store = await cookies();
  const expectedState = store.get("broccoli_oauth_state")?.value;

  const fail = (msg: string) => Response.redirect(`${env.siteUrl}/login?oauth_error=${encodeURIComponent(msg)}`, 302);

  if (!clientId || !clientSecret) return fail("GitHub OAuth 未配置");
  if (!code || !state || !expectedState || state !== expectedState) return fail("state 校验失败，请重新登录");

  // 清理一次性 state
  store.set("broccoli_oauth_state", "", { httpOnly: true, path: "/", maxAge: 0 });

  // code → access_token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${env.siteUrl.replace(/\/$/, "")}/api/auth/github/callback`,
    }),
  });
  const tokenData = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  const accessToken = tokenData.access_token;
  if (!accessToken) return fail(tokenData.error_description ?? "code 换取 token 失败");

  // token → 用户信息（邮箱私有则用 noreply 地址）
  const ghUserRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "broccoli-dev" },
  });
  if (!ghUserRes.ok) return fail("GitHub 用户信息获取失败");
  const ghUser = (await ghUserRes.json()) as { login: string; email: string | null; name: string | null };

  let email = ghUser.email;
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "broccoli-dev" },
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
    }
  }
  email = email ?? `${ghUser.login}@users.noreply.github.com`;

  // find-or-create 用户（OAuth 用户无密码登录，随机占位 hash）
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    if (env.registration !== "open") return fail("注册已关闭，请联系管理员开通账号");
    [user] = await db
      .insert(users)
      .values({ email, passwordHash: hashPassword(crypto.randomUUID()), displayName: ghUser.name || ghUser.login })
      .returning();
  }

  // OAuth token 加密入库（provider=github）：github origin 项目免配 PAT
  const { ciphertext, nonce } = encryptSecret(accessToken);
  const hint = `oauth:${ghUser.login}`;
  const [existing] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.userId, user.id), eq(credentials.provider, "github")))
    .limit(1);
  if (existing) {
    await db.update(credentials).set({ ciphertext, nonce, hint }).where(eq(credentials.id, existing.id));
  } else {
    await db.insert(credentials).values({ userId: user.id, provider: "github", ciphertext, nonce, hint });
  }

  // 会话
  store.set(SESSION_COOKIE, signSession({ uid: user.id }), sessionCookieOptions());
  store.set("broccoli_oauth_state", "", { httpOnly: true, path: "/", maxAge: 0 });
  return Response.redirect(`${env.siteUrl}/`, 302);
}

