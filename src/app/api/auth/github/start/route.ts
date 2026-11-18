import crypto from "node:crypto";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/auth";
import { cookies } from "next/headers";

/**
 * GitHub OAuth 登录（FR-A3 完整形态）——发起授权。
 * 需要 .env 配置 GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET；
 * 未配置时返回可读错误（登录页按钮同时隐藏）。
 * 回调地址 = BROCCOLI_SITE_URL + /api/auth/github/callback。
 */
export async function GET(req: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? "";
  if (!clientId || !process.env.GITHUB_OAUTH_CLIENT_SECRET) {
    return Response.json(
      { code: "OAUTH_NOT_CONFIGURED", message: "GitHub OAuth 未配置：需在 .env 设置 GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET" },
      { status: 501 },
    );
  }

  // CSRF state：随机值写入短命 cookie，回调时比对
  const state = crypto.randomBytes(16).toString("hex");
  const store = await cookies();
  store.set("broccoli_oauth_state", state, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 600 });

  const redirectUri = `${env.siteUrl.replace(/\/$/, "")}/api/auth/github/callback`;
  // repo（仓库读写，github origin 项目使用）+ read:user/user:email（账号识别）
  const scope = "repo read:user user:email";
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  void SESSION_COOKIE;
  return Response.redirect(url.toString(), 302);
}
