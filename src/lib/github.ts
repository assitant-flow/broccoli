import { db } from "@/db";
import { credentials } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";
import { env } from "./env";

/**
 * GitHub REST 适配器（真实集成，FR-A3/FR-F1/F2/F3/FR-C4 的 github origin 支持）。
 * Token 解析优先级：平台级 env GITHUB_TOKEN → 用户存入的 PAT（credentials provider=github）。
 */

export async function resolveGithubToken(userId: string): Promise<string | null> {
  if (env.sharedCredentials && env.githubToken) return env.githubToken;
  const [cred] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.userId, userId), eq(credentials.provider, "github")))
    .limit(1);
  if (!cred) return null;
  try {
    const key = decryptSecret(cred.ciphertext).trim();
    return key || null;
  } catch {
    return null;
  }
}

async function gh<T = unknown>(token: string, path: string, method = "GET", body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "broccoli-dev",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data: data as T };
}

export function parseRepo(fullName: string): { owner: string; repo: string } | null {
  const m = fullName.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** 验证 token 对仓库的访问（FR-B1 github origin） */
export async function verifyRepoAccess(token: string, repoFullName: string): Promise<{ ok: boolean; private?: boolean; defaultBranch?: string; error?: string }> {
  const r = parseRepo(repoFullName);
  if (!r) return { ok: false, error: "repoFullName 需为 owner/repo 形式" };
  const res = await gh<{ private: boolean; default_branch: string }>(token, `/repos/${r.owner}/${r.repo}`);
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}（无权限或仓库不存在）` };
  return { ok: true, private: res.data.private, defaultBranch: res.data.default_branch };
}

export interface RealPr {
  number: number;
  htmlUrl: string;
  state: string;
}

export async function createPullRequest(token: string, repoFullName: string, params: { head: string; base: string; title: string; body: string }): Promise<{ ok: boolean; pr?: RealPr; error?: string }> {
  const r = parseRepo(repoFullName);
  if (!r) return { ok: false, error: "repoFullName 非法" };
  const res = await gh<{ number: number; html_url: string; state: string }>(token, `/repos/${r.owner}/${r.repo}/pulls`, "POST", {
    title: params.title,
    head: params.head,
    base: params.base,
    body: params.body,
  });
  if (!res.ok) {
    const msg = (res.data as { message?: string })?.message ?? `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, pr: { number: res.data.number, htmlUrl: res.data.html_url, state: res.data.state } };
}

export async function mergePullRequest(token: string, repoFullName: string, number: number): Promise<{ ok: boolean; error?: string }> {
  const r = parseRepo(repoFullName);
  if (!r) return { ok: false, error: "repoFullName 非法" };
  const res = await gh<{ merged: boolean }>(token, `/repos/${r.owner}/${r.repo}/pulls/${number}/merge`, "PUT", {
    merge_method: "merge",
    commit_title: `Merge PR #${number} (Broccoli)`,
  });
  if (!res.ok) {
    const msg = (res.data as { message?: string })?.message ?? `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true };
}

export async function closePullRequest(token: string, repoFullName: string, number: number): Promise<{ ok: boolean; error?: string }> {
  const r = parseRepo(repoFullName);
  if (!r) return { ok: false, error: "repoFullName 非法" };
  const res = await gh<{ state: string }>(token, `/repos/${r.owner}/${r.repo}/pulls/${number}`, "PATCH", { state: "closed" });
  return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
}

export interface RealIssue {
  number: number;
  title: string;
  body: string;
  state: string;
}

/** 仓库 open issues（排除 PR；FR-C4） */
export async function listOpenIssues(token: string, repoFullName: string): Promise<{ ok: boolean; issues?: RealIssue[]; error?: string }> {
  const r = parseRepo(repoFullName);
  if (!r) return { ok: false, error: "repoFullName 非法" };
  const res = await gh<{ number: number; title: string; body: string | null; state: string; pull_request?: unknown }[]>(
    token,
    `/repos/${r.owner}/${r.repo}/issues?state=open&per_page=30`,
  );
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return {
    ok: true,
    issues: (res.data ?? [])
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", state: i.state })),
  };
}

export async function closeIssue(token: string, repoFullName: string, number: number): Promise<{ ok: boolean; error?: string }> {
  const r = parseRepo(repoFullName);
  if (!r) return { ok: false, error: "repoFullName 非法" };
  const res = await gh<{ state: string }>(token, `/repos/${r.owner}/${r.repo}/issues/${number}`, "PATCH", { state: "closed" });
  return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
}

/** 向仓库写入初始文件（contents API，验证脚本用） */
export async function putFile(token: string, repoFullName: string, path: string, content: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const r = parseRepo(repoFullName);
  if (!r) return { ok: false, error: "repoFullName 非法" };
  const existing = await gh<{ sha: string }>(token, `/repos/${r.owner}/${r.repo}/contents/${path}`);
  const res = await gh(token, `/repos/${r.owner}/${r.repo}/contents/${path}`, "PUT", {
    message,
    content: Buffer.from(content).toString("base64"),
    ...(existing.ok ? { sha: existing.data.sha } : {}),
  });
  return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
}
