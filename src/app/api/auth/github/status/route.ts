import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok } from "@/lib/api";

/** OAuth 配置状态（登录页据此显示/隐藏 GitHub 登录按钮） */
export async function GET() {
  const configured = !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);
  const user = await getSessionUser();
  return ok({ configured, loggedIn: !!user });
}
