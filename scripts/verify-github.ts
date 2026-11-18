/**
 * 真实 GitHub 集成端到端验证（FR-A3/B1/F1/F2/C4 github origin）：
 * 真实仓库 clone → 流水线执行 → 真实分支 push → 真实 PR 开出 → 平台合并（真实 API）
 * → Issues 真实拉取/回写。前置：.env 配置 GITHUB_TOKEN + 测试仓库存在。
 * 运行：pnpm verify:github
 */
const BASE = "http://localhost:3000";
const REPO = "AlpherJang/broccoli-demo";
let cookie = "";
let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

async function http<T = unknown>(p: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const t = await res.text();
  let d: unknown = null;
  try { d = JSON.parse(t); } catch { d = t; }
  return { status: res.status, data: d as T };
}

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 300000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      console.log(`  … ${desc}（${Math.round((Date.now() - start) / 1000)}s）`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  … 超时：${desc}`);
  return false;
}

async function ghApi<T = unknown>(path: string, method = "GET", body?: unknown): Promise<{ ok: boolean; data: T }> {
  const token = (await import("node:fs")).readFileSync(".env", "utf8").match(/GITHUB_TOKEN=(\S+)/)?.[1] ?? "";
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "broccoli-verify" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let d: unknown = null;
  try { d = text ? JSON.parse(text) : null; } catch { d = text; }
  return { ok: res.ok, data: d as T };
}

async function main() {
  console.log(`== 真实 GitHub 集成验证（${REPO}）==\n`);

  // 0. 仓库就绪检查（README 已存在即视为就绪）
  const readme = await ghApi(`/repos/${REPO}/contents/README.md`);
  check("仓库就绪（README 存在）", readme.ok);

  // 1. 登录 + 创建 github origin 项目（真实 clone）
  await http("/api/auth/login", "POST", { email: "thomas@broccoli.dev", password: "broccoli123" });
  const proj = await http<{ id: string; name: string; defaultBranch: string; originKind: string }>("/api/projects", "POST", {
    originKind: "github", repoFullName: REPO, failurePolicy: "pause",
  });
  check("创建 github origin 项目（验证访问 + 真实 clone）", proj.status === 200 && proj.data.originKind === "github", `defaultBranch=${proj.data.defaultBranch}`);
  const pid = proj.data.id;
  const P = () => http<{ project: { id: string; lastSuccessBranch: string | null }; requirements: { id: string; seq: number; status: string; latestRunId: string | null }[]; runs: { id: string; requirementId: string; state: string; attemptNo: number; branch: string | null }[]; prs: { id: string; number: number; status: string; branch: string; baseBranch: string }[] }>(`/api/projects/${pid}`, "GET").then((r) => r.data!);

  // 2. 提交需求 → 流水线 → 真实分支 + 真实 PR
  const reqs = await http<{ requirements: { id: string }[] }>(`/api/projects/${pid}/requirements`, "POST", {
    items: [`新增 utils/greet 模块，greet(name) 返回问候字符串（版本标记 v${Date.now() % 100000}）`],
  });
  check("提交需求", reqs.status === 200);

  const doneOk = await waitFor("任务完成（真实仓库分支 push + 真实 PR 开出）", async () => {
    const d = await P();
    return d.requirements[0].status === "done" && d.prs.length >= 1;
  }, 300000);
  check("流水线在真实仓库上完成（FR-D10）", doneOk);
  const d1 = await P();
  const pr = d1.prs[0];

  // 3. 真实 PR 存在性核验（GitHub API 视角）
  const realPr = await ghApi<{ number: number; state: string; head: { ref: string }; base: { ref: string } }>(`/repos/${REPO}/pulls/${pr.number}`);
  check(
    "真实 PR 经 GitHub API 核验存在且 open（FR-F1）",
    realPr.ok && realPr.data.state === "open" && realPr.data.head.ref === pr.branch && realPr.data.base.ref === pr.baseBranch,
    `#${realPr.data?.number} ${realPr.data?.head?.ref}→${realPr.data?.base?.ref}`,
  );

  // 4. 平台合并 → 真实 merged
  const merge = await http<{ ok: boolean; message: string }>(`/api/prs/${pr.id}/actions`, "POST", { action: "merge" });
  check("平台界面合并 → 真实 GitHub merge API（FR-F2）", merge.data.ok === true, merge.data.message);
  const realMerged = await ghApi<{ merged: boolean; state: string }>(`/repos/${REPO}/pulls/${pr.number}`);
  check("GitHub API 确认真实 merged", realMerged.ok && realMerged.data.merged === true);

  // 5. 真实 Issues：API 造一个 issue → 平台拉入队列 → 流水线完成 → 状态回写关闭
  const mkIssue = await ghApi<{ number: number }>(`/repos/${REPO}/issues`, "POST", {
    title: `新增 utils/farewell 模块，farewell(name) 返回告别语（v${Date.now() % 100000}）`,
    body: "由 verify-github 创建的验证 issue（FR-C4 状态回写）",
  });
  check("创建真实 Issue", mkIssue.ok, `#${mkIssue.data?.number}`);
  await new Promise((r) => setTimeout(r, 1500));
  const mirrored = await waitFor("平台镜像到真实 open Issue（FR-C4）", async () => {
    const list = await http<{ id: string; number: number; state: string }[]>(`/api/projects/${pid}/issues`, "GET");
    return list.data.some((i) => i.number === mkIssue.data.number && i.state === "open");
  }, 30000);
  const issuesList = await http<{ id: string; number: number; state: string }[]>(`/api/projects/${pid}/issues`, "GET");
  const openIssue = issuesList.data.find((i) => i.number === mkIssue.data.number && i.state === "open");
  check("平台拉取到真实 open Issue（FR-C4）", mirrored && !!openIssue);
  const pull = await http<{ created: string[] }>(`/api/projects/${pid}/issues`, "POST", { issueIds: [openIssue!.id] });
  check("Issue 拉入队列", pull.data.created.length === 1);
  const issueDone = await waitFor("Issue 需求流水线完成", async () => {
    const d = await P();
    return d.requirements[1]?.status === "done";
  }, 300000);
  check("Issue 需求完成", issueDone);
  const realIssueClosed = await ghApi<{ state: string }>(`/repos/${REPO}/issues/${mkIssue.data.number}`);
  check("真实 Issue 状态回写关闭（FR-C4）", realIssueClosed.ok && realIssueClosed.data.state === "closed");

  // 6. 堆叠核验：#2 分支基于 #1
  const d2 = await P();
  const pr2 = d2.prs.find((p) => p.number === d1.prs[0].number + 1) ?? d2.prs[1];
  check("Issue PR 堆叠于首个 PR 分支（AC-F1）", !!pr2 && pr2.baseBranch === d1.prs[0].branch, `base=${pr2?.baseBranch}`);

  console.log("\n========================================");
  if (failures === 0) console.log(`✅ 真实 GitHub 集成验证全部通过（仓库 ${REPO}）`);
  else console.log(`❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
