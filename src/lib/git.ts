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

/** 初始化裸 origin + 工作区，并写入种子文件、提交到 main */
export async function ensureProjectRepos(projectId: string, seedFiles: Record<string, string>): Promise<void> {
  const dir = projectRepoDir(projectId);
  const origin = originPath(projectId);
  const work = workPath(projectId);
  await fs.mkdir(path.join(dir), { recursive: true });

  const originExists = await fs
    .access(path.join(origin, "HEAD"))
    .then(() => true)
    .catch(() => false);
  if (!originExists) {
    await git(dir, "init", "--bare", "--initial-branch=main", origin);
  }

  const workExists = await fs
    .access(path.join(work, ".git"))
    .then(() => true)
    .catch(() => false);
  if (!workExists) {
    await fs.mkdir(work, { recursive: true });
    await git(work, "clone", origin, ".");
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
export async function checkoutBranchFrom(projectId: string, branch: string, from: string): Promise<void> {
  const work = workPath(projectId);
  await git(work, "fetch", "origin");
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

export async function pushBranch(projectId: string, branch: string): Promise<void> {
  await git(workPath(projectId), "push", "--force-with-lease", "-u", "origin", branch);
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
