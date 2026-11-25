/**
 * 沙箱子进程环境白名单。
 * 仓库测试代码在子进程中执行：不继承平台密钥（DATABASE_URL / BROCCOLI_MASTER_KEY /
 * SESSION_SECRET / 平台 Token），即使接入的仓库脚本恶意也读不到这些凭据。
 */
const PASS_THROUGH = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"] as const;

export function buildSandboxEnv(base: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: "1", GIT_TERMINAL_PROMPT: "0", NODE_ENV: "test" };
  for (const key of PASS_THROUGH) {
    const value = base[key];
    if (value) out[key] = value;
  }
  return out;
}
