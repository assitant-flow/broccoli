import { execFile } from "child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

const run = promisify(execFile);

/** 本地 git 层：以裸仓模拟 GitHub origin（demo 模式，AC-F1 的真实分支/堆叠/diff 均真实执行） */

export function projectRepoDir(projectId: string) {
  return path.join(process.cwd(), env.dataDir, "repos", projectId);
}

export function originPath(projectId: string) {
  return path.join(projectRepoDir(projectId), "origin.git");
}

export function workPath(projectId: string) {
  return path.join(projectRepoDir(projectId), "work");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 1024 * 1024 * 16 });
  return stdout.trim();
}

/** github origin 的鉴权参数：token 经 http.extraheader 注入，命令级生效、不写入 .git/config（design §12）；
 *  强制 HTTP/1.1（规避 GitHub HTTPS 偶发 HTTP2 framing 层错误） */
function authArgs(token?: string): string[] {
  const base = ["-c", "http.version=HTTP/1.1", "-c", "http.postBuffer=524288000"];
  if (!token) return base;
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  return [...base, "-c", `http.extraheader=AUTHORIZATION: basic ${b64}`];
}

/** 网络型 git 命令：禁用交互提示（防挂起）+ 超时 + 失败重试一次 */
async function gitNet(cwd: string, token: string | undefined, args: string[], timeoutMs = 180000): Promise<void> {
  const attempt = () =>
    run("git", [...authArgs(token), ...args], {
      cwd,
      maxBuffer: 1024 * 1024 * 16,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
  try {
    await attempt();
  } catch (err) {
    // 网络类瞬时失败（HTTP2 framing / 连接重置等）重试一次
    await new Promise((r) => setTimeout(r, 2000));
    await attempt();
  }
}

export interface GitOriginOpts {
  /** github origin 的远程地址；缺省 = 本地裸仓 origin */
  remoteUrl?: string;
  /** github origin 的访问 token（clone/fetch/push 窗口内使用） */
  token?: string;
}

/** 初始化 origin + 工作区：本地模式 init 裸仓并写种子文件；github 模式 clone 真实远程仓库 */
export async function ensureProjectRepos(projectId: string, seedFiles: Record<string, string>, opts?: GitOriginOpts): Promise<void> {
  const dir = projectRepoDir(projectId);
  const work = workPath(projectId);
  await fs.mkdir(path.join(dir), { recursive: true });

  const workExists = await fs
    .access(path.join(work, ".git"))
    .then(() => true)
    .catch(() => false);
  if (workExists) return;

  if (opts?.remoteUrl) {
    // 真实 GitHub 仓库：clone 远程（token 仅经 extraheader 传入；HTTP/1.1 + 防挂起 + 重试）
    await fs.mkdir(work, { recursive: true });
    await gitNet(work, opts.token, ["clone", opts.remoteUrl, "."], 180000);
    await git(work, "config", "user.email", "agent@broccoli.dev");
    await git(work, "config", "user.name", "Broccoli Agent");
  } else {
    const origin = originPath(projectId);
    await git(dir, "init", "--bare", "--initial-branch=main", origin);
    await fs.mkdir(work, { recursive: true });
    await git(work, "clone", origin, ".");
    // 仓库级身份必须先于任何 commit（CI runner 无全局 git 身份）
    await git(work, "config", "user.email", "agent@broccoli.dev");
    await git(work, "config", "user.name", "Broccoli Agent");
    for (const [rel, content] of Object.entries(seedFiles)) {
      const p = path.join(work, rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content);
    }
    await git(work, "add", "-A");
    await git(work, "commit", "-m", "chore: 初始化项目骨架");
    await git(work, "push", "origin", "main");
  }
}

export async function currentBranch(projectId: string): Promise<string> {
  return git(workPath(projectId), "rev-parse", "--abbrev-ref", "HEAD");
}

/** 检出（-B：从 from 重建本地分支 —— 重试/堆叠链修复要求每次尝试都从 base 重新开始） */
export async function checkoutBranchFrom(projectId: string, branch: string, from: string, opts?: GitOriginOpts): Promise<void> {
  const work = workPath(projectId);
  await gitNet(work, opts?.token, ["fetch", "origin"], 120000);
  await git(work, "checkout", "-B", branch, from);
}

export async function commitAll(projectId: string, message: string): Promise<boolean> {
  const work = workPath(projectId);
  const status = await git(work, "status", "--porcelain");
  if (!status) return false;
  await git(work, "add", "-A");
  await git(work, "commit", "-m", message);
  return true;
}

export async function pushBranch(projectId: string, branch: string, opts?: GitOriginOpts): Promise<void> {
  await gitNet(workPath(projectId), opts?.token, ["push", "--force-with-lease", "-u", "origin", branch], 120000);
}

export async function diffStat(projectId: string, base: string, head: string): Promise<string> {
  const work = workPath(projectId);
  try {
    return await git(work, "diff", `origin/${base}...${head}`, "--stat");
  } catch {
    return await git(work, "diff", base, head, "--stat");
  }
}

export async function diffPatch(projectId: string, base: string, head: string): Promise<string> {
  const work = workPath(projectId);
  try {
    return await git(work, "diff", `origin/${base}...${head}`);
  } catch {
    return await git(work, "diff", base, head);
  }
}

export async function changedFiles(projectId: string, base: string, head: string): Promise<string[]> {
  const work = workPath(projectId);
  try {
    const out = await git(work, "diff", "--name-only", `origin/${base}...${head}`);
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function hasUncommitted(projectId: string): Promise<boolean> {
  const status = await git(workPath(projectId), "status", "--porcelain");
  return Boolean(status);
}

/** 切换到既有分支/引用（PR 合并前重置到 origin 状态） */
export async function checkoutExisting(projectId: string, ref: string): Promise<void> {
  const work = workPath(projectId);
  await git(work, "fetch", "origin");
  await git(work, "checkout", ref);
  try {
    await git(work, "reset", "--hard", `origin/${ref}`);
  } catch {
    /* 本地分支（无 origin 副本） */
  }
}

/** 合并分支（--no-ff 保留 PR 历史，FR-F2） */
export async function mergeBranch(projectId: string, branch: string, message: string): Promise<void> {
  await git(workPath(projectId), "merge", "--no-ff", branch, "-m", message);
}

/** 检出仓库约定文件（FR-G8） */
export async function readRepoFile(projectId: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workPath(projectId), rel), "utf8");
  } catch {
    return null;
  }
}
