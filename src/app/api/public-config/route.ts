import { env } from "@/lib/env";

/** 登录页所需的公开配置（不含任何密钥或口令） */
export async function GET() {
  return Response.json({
    mode: env.mode,
    registration: env.registration,
    demoLogin: env.mode === "local" && env.seedDemo,
    githubOAuth: !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET),
  });
}
