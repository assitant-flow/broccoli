/**
 * 端到端 smoke：按发布检查单（requirements §6）驱动全部功能并断言终态。
 * 前置：Postgres 已启动 + pnpm seed 已执行 + pnpm dev 已在 3000 端口运行。
 * 运行：pnpm smoke
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000";
let cookie = "";
let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

async function http<T = unknown>(p: string, method: string = "GET", body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data: data as T };
}

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 240000): Promise<boolean> {
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

type Req = { id: string; seq: number; title: string; status: string; latestRunId: string | null; dependsOnSeq: number | null; skipReason: string | null };
type Run = { id: string; requirementId: string; state: string; currentStage: string | null; error: string | null; baseBranch: string | null };
type ProjectData = { project: { id: string; name: string; lastSuccessBranch: string | null }; requirements: Req[]; runs: Run[]; prs: { id: string; number: number; baseBranch: string; branch: string; diffStat: string }[] };

async function main() {
  console.log("== Broccoli 端到端 smoke（发布检查单 §6）==\n");

  // 1. 认证
  const login = await http("/api/auth/login", "POST", { email: "thomas@broccoli.dev", password: "broccoli123" });
  check("登录（FR-A1）", login.status === 200);
  const me = await http<{ email: string }>("/api/auth/me", "GET");
  check("会话有效", me.data?.email === "thomas@broccoli.dev");

  // 项目数据
  const list = await http<{ id: string; name: string }[]>("/api/projects", "GET");
  const projA = list.data!.find((p) => p.name === "acme/api-gateway")!;
  const projB = list.data!.find((p) => p.name === "thomas/portfolio-site")!;
  const A = () => http<ProjectData>(`/api/projects/${projA.id}`, "GET").then((r) => r.data!);
  const B = () => http<ProjectData>(`/api/projects/${projB.id}`, "GET").then((r) => r.data!);

  // 2. 仪表盘
  const dash = await http<{ projects: unknown[]; stats: Record<string, number> }>("/api/dashboard", "GET");
  check("仪表盘聚合（FR-E1）", dash.status === 200 && dash.data.projects.length === 2);

  // 3. 并发启动：两个项目同时执行（AC-D1）
  await new Promise((r) => setTimeout(r, 4000));
  const d1 = await http<{ stats: { running: number; maxConcurrency: number } }>("/api/dashboard", "GET");
  check("项目间并行 & 并发上限（FR-D1/AC-D1）", d1.data.stats.running <= d1.data.stats.maxConcurrency, `running=${d1.data.stats.running}/${d1.data.stats.maxConcurrency}`);

  // 4. 项目 B：#2 测试失败 → skip_continue 自动跳过 → #3 继续（base 回退，AC-D6）
  const bOk = await waitFor("B#2 测试失败 → 自动跳过；B#3 继续完成", async () => {
    const d = await B();
    const r2 = d.requirements.find((r) => r.seq === 2)!;
    const r3 = d.requirements.find((r) => r.seq === 3)!;
    return r2.status === "failed" && r3.status === "done";
  });
  check("失败自动跳过策略 + base 回退（FR-D6）", bOk);
  const bData = await B();
  const b3Run = bData.runs.find((r) => r.requirementId === bData.requirements.find((r) => r.seq === 3)!.id)!;
  check("跳过后分支 base 回退至最后成功分支（AC-F1）", b3Run.baseBranch === "broccoli/1-req", `base=${b3Run.baseBranch}`);

  // 5. 项目 A：#2 规划选型 → 等待确认 → 邮件 → 作答恢复（FR-D4/D5/E4）
  const aData0 = await A();
  const req2 = aData0.requirements.find((r) => r.seq === 2)!;
  const run2Id = req2.latestRunId!;
  const waitOk = await waitFor("A#2 进入等待确认（结构化提问）", async () => {
    const d = await A();
    const run = d.runs.find((r) => r.id === req2.latestRunId)!;
    return run.state === "wait_confirm" && !!run.currentStage;
  }, 180000);
  check("结构化确认提问（FR-D4）", waitOk);
  const runDetail = await http<{ run: { confirmQuestion: { options: { key: string; label: string; recommended?: boolean }[] } } }>(`/api/runs/${run2Id}`, "GET");
  check("提问含预设选项 + 推荐（AC-D4）", runDetail.data.run.confirmQuestion.options.length >= 2 && runDetail.data.run.confirmQuestion.options.some((o) => o.recommended));
  const confirmRes = await http<{ ok: boolean }>(`/api/runs/${run2Id}/confirm`, "POST", { answer: "PostgreSQL + Redis", optionKey: "postgres" });
  check("用户作答 → 恢复执行（AC-D4）", confirmRes.data.ok === true);

  // 关键邮件
  const outboxDir = path.join(process.cwd(), ".data", "outbox");
  const outboxExists = fs.existsSync(outboxDir) && fs.readdirSync(outboxDir).some((f) => f.includes("wait_confirm"));
  check("等待确认关键邮件（FR-E4 P0）", outboxExists);

  // 6. 项目 A 全部完成（#4 含验收回溯修复）
  const allDone = await waitFor("A 5 个需求全部完成（含 #2 确认恢复 / #4 回溯修复）", async () => {
    const d = await A();
    return d.requirements.every((r) => r.status === "done");
  }, 420000);
  check("成功标准：5/5 完成并开出堆叠 PR", allDone);

  const aFinal = await A();
  check("堆叠 PR ×5（FR-F1）", aFinal.prs.length === 5);
  const lastPr = aFinal.prs[aFinal.prs.length - 1];
  check("堆叠链：PR base 指向前序分支", aFinal.prs.slice(1).every((p) => aFinal.prs.some((q) => q.branch === p.baseBranch)));
  check("last_success_branch 推进", aFinal.project.lastSuccessBranch === lastPr.branch);

  // 验收标准与回溯修复
  const run4Id = aFinal.requirements.find((r) => r.seq === 4)!.latestRunId!;
  const canvas4 = await http<{ run: { repairRound: number }; criteria: { content: string; status: string; evidence: string | null }[] }>(`/api/runs/${run4Id}`, "GET");
  check("验收回溯修复执行（FR-D14）", canvas4.data.run.repairRound >= 1, `repairRound=${canvas4.data.run.repairRound}`);
  check("验收标准全部达成（AC-D14 交付门禁）", canvas4.data.criteria.every((c) => c.status === "achieved") && canvas4.data.criteria.length >= 4);
  const canvas2 = await http<{ criteria: { content: string; status: string; evidence: string | null }[] }>(`/api/runs/${req2.latestRunId!}`, "GET");
  check("选型符合用户决定（AC-D11）", canvas2.data.criteria.some((c) => c.content.includes("PostgreSQL + Redis") && c.status === "achieved"));

  // 7. 阶段模型配置（FR-D17）
  const cfg = await http<{ stages: { stageType: string; modelKey: string; source: string }[] }>(`/api/projects/${projA.id}/stage-configs`, "GET");
  check("分阶段模型配置 + 推荐（FR-D17）", cfg.data.stages.length === 6 && cfg.data.stages.every((s) => s.modelKey));
  await http(`/api/projects/${projA.id}/stage-configs`, "PUT", { updates: [{ stageType: "dev", modelKey: "claude-opus-4-6" }] });
  const cfg2 = await http<{ stages: { stageType: string; source: string }[] }>(`/api/projects/${projA.id}/stage-configs`, "GET");
  check("自定义模型生效（AC-D17）", cfg2.data.stages.find((s) => s.stageType === "dev")!.source === "custom");
  await http(`/api/projects/${projA.id}/stage-configs`, "POST");
  const cfg3 = await http<{ stages: { stageType: string; source: string }[] }>(`/api/projects/${projA.id}/stage-configs`, "GET");
  check("恢复全部推荐", cfg3.data.stages.every((s) => s.source === "recommended"));

  // 8. 记忆系统（FR-G2/G4/G6）
  const memA = await http<{ proposals: { id: string; status: string; injectedCount: number; type: string; content: string }[]; items: unknown[] }>(`/api/projects/${projA.id}/memories`, "GET");
  check("任务后记忆提案生成（FR-G2）", memA.data.proposals.length >= 5);
  check("提案注入计数（提案即注入 FR-G3）", memA.data.proposals.some((p) => p.injectedCount > 0));
  const firstProposal = memA.data.proposals[0];
  const rejectRes = await http<{ impacted: { runId: string; reqSeq: number }[] }>(`/api/proposals/${firstProposal.id}`, "DELETE");
  check("否决提案 + 依赖追溯（FR-G6/AC-G6）", rejectRes.status === 200 && Array.isArray(rejectRes.data.impacted), `impacted=${rejectRes.data.impacted?.length}`);
  const batchConfirm = await http<{ confirmed: number }>(`/api/projects/${projA.id}/memories`, "POST", {});
  check("批量确认提案（AC-G4）", batchConfirm.data.confirmed >= 3, `confirmed=${batchConfirm.data.confirmed}`);

  // 9. 用量统计（FR-H4）
  const usage = await http<{ totals: { in: number; out: number; seconds: number } }>("/api/usage", "GET");
  check("用量统计（FR-H4）", usage.data.totals.in > 0 && usage.data.totals.out > 0);

  // 10. PR 真实 diff（本地 git）
  const diff = await fetch(`${BASE}/api/prs/${lastPr.id}/diff`, { headers: { cookie } });
  const diffText = await diff.text();
  check("PR diff 真实生成（FR-D8/AC-F1）", diff.status === 200 && diffText.includes("diff --git"));

  // 11. 通知去重
  const notifs = await http<{ dedupeKey: string }[]>("/api/notifications", "GET");
  const dedupes = new Set(notifs.data.map((n) => n.dedupeKey));
  check("通知去重（AC-E4）", dedupes.size === notifs.data.length);

  // 12. CLAUDE.md 仓库约定注入（FR-G8）与初始项目分析（FR-G7）
  const run1Id = aFinal.requirements.find((r) => r.seq === 1)!.latestRunId!;
  const canvas1 = await http<{ run: { snapshot: { injections?: string[] } | null } }>(`/api/runs/${run1Id}`, "GET");
  check("CLAUDE.md 协同注入（FR-G8）", (canvas1.data.run.snapshot?.injections ?? []).some((s) => s.includes("CLAUDE.md")));
  const memAfter = await http<{ proposals: { content: string }[] }>(`/api/projects/${projA.id}/memories`, "GET");
  check("初始项目分析提案（FR-G7）", memAfter.data.proposals.some((p) => p.content.includes("初始分析")));

  // 13. PR 界面合并（FR-F2）：真实 git merge 到 base
  const pr1 = aFinal.prs.find((p) => p.number === 1)!;
  const mergeRes = await http<{ ok: boolean; message: string }>(`/api/prs/${pr1.id}/actions`, "POST", { action: "merge" });
  check("PR 界面合并（FR-F2）", mergeRes.data.ok === true, mergeRes.data.message);
  const prsAfterMerge = await http<{ number: number; status: string }[]>(`/api/projects/${projA.id}/prs`, "GET");
  check("合并状态落库", prsAfterMerge.data.find((p) => p.number === 1)!.status === "merged");

  // 14. 堆叠链修复（FR-F3/AC-F3）：关闭 #3 及后继，受影响需求基于新 base 重跑
  const pr3 = aFinal.prs.find((p) => p.number === 3)!;
  const rebaseRes = await http<{ ok: boolean; requeued: number }>(`/api/prs/${pr3.id}/actions`, "POST", { action: "rebase" });
  check("堆叠链修复触发（FR-F3）", rebaseRes.data.ok === true && rebaseRes.data.requeued === 3, `requeued=${rebaseRes.data.requeued}`);
  const rerunDone = await waitFor("重跑的需求全部再次完成", async () => {
    const d = await A();
    return d.requirements.filter((r) => r.seq >= 3).every((r) => r.status === "done");
  }, 300000);
  check("堆叠链修复后全部重新交付", rerunDone);
  const prsAfterRebase = await http<{ number: number; status: string }[]>(`/api/projects/${projA.id}/prs`, "GET");
  check("新 PR 开出（#3–#5 关闭，新节点接续）", prsAfterRebase.data.length >= 8 && prsAfterRebase.data.filter((p) => p.status === "closed").length >= 3, `total=${prsAfterRebase.data.length}`);
  const aRe = await A();
  const req3Runs = aRe.runs.filter((r) => r.requirementId === aRe.requirements.find((r) => r.seq === 3)!.id);
  check("重跑为新执行实例（attempt 2）", req3Runs.length === 2 && req3Runs[1].baseBranch === pr3.baseBranch, `base=${req3Runs[1].baseBranch}`);

  // 15. Issues 同步（FR-C4）：拉入队列 → 执行 → 状态回写关闭
  const issuesList = await http<{ id: string; number: number; state: string }[]>(`/api/projects/${projA.id}/issues`, "GET");
  const openIssues = issuesList.data.filter((i) => i.state === "open");
  check("Issues 列表（本地模拟 origin）", openIssues.length >= 2);
  const pullRes = await http<{ created: string[] }>(`/api/projects/${projA.id}/issues`, "POST", { issueIds: openIssues.map((i) => i.id) });
  check("Issue 拉入队列（FR-C4）", pullRes.data.created.length === openIssues.length);
  const issuesDone = await waitFor("拉入的需求全部完成", async () => {
    const d = await A();
    return openIssues.every(() => d.requirements.length >= 7 && d.requirements.slice(5).every((r) => r.status === "done"));
  }, 300000);
  check("Issues 拉入后由流水线完成", issuesDone);
  const issuesClosed = await http<{ state: string }[]>(`/api/projects/${projA.id}/issues`, "GET");
  check("Issue 状态回写关闭（FR-C4）", issuesClosed.data.every((i) => i.state === "closed"));

  // 16. 介入讨论（FR-E6/AC-E6）
  const targetRun = (await A()).requirements[5].latestRunId!;
  const msgRes = await http<{ ok: boolean }>(`/api/runs/${targetRun}/messages`, "POST", { text: "登录态需要兼容旧版客户端，token 格式不要变" });
  check("介入讨论消息（FR-E6）", msgRes.status === 200);
  const msgs = await http<{ role: string; text: string }[]>(`/api/runs/${targetRun}/messages`, "GET");
  check("消息存储与 agent 应答", msgs.data.some((m) => m.role === "user") && msgs.data.some((m) => m.role === "agent" && m.text.includes("补充说明")));

  // 17. 记忆导出（FR-G9 P2）
  const exportRes = await fetch(`${BASE}/api/projects/${projA.id}/memories/export`, { headers: { cookie } });
  const exportText = await exportRes.text();
  check("记忆导出 Markdown（FR-G9）", exportRes.status === 200 && exportText.includes("Broccoli 记忆导出"));

  // 18. 用量聚合含任务标题（FR-H4）
  const usage2 = await http<{ byRun: { reqTitle: string }[] }>("/api/usage", "GET");
  check("用量聚合关联任务", usage2.data.byRun.length > 0 && usage2.data.byRun.every((r) => !!r.reqTitle));

  // 19. 项目设置（FR-B3）
  const patchRes = await http<{ defaultBranch: string }>(`/api/projects/${projA.id}`, "PATCH", { defaultBranch: "main", settings: { env: { API_KEY: "secret-1" } } });
  const projAfter = await http<{ project: { defaultBranch: string; settings: { env?: Record<string, string> } } }>(`/api/projects/${projA.id}`, "GET");
  check("项目设置：默认分支 + 环境变量（FR-B3）", projAfter.data.project.defaultBranch === "main" && projAfter.data.project.settings?.env?.API_KEY === "secret-1", JSON.stringify(projAfter.data.project?.settings ?? projAfter.data).slice(0, 160));
  void patchRes;

  // 20. 依赖图（v2α）：@N 语法声明依赖 → 依赖失败 → 级联跳过
  await http(`/api/projects/${projB.id}/requirements`, "POST", {
    items: ["@3 [fail-tests] 依赖失败级联示范", "@4 普通后续需求"],
  });
  const depOk = await waitFor("依赖需求失败 → 级联跳过后续", async () => {
    const d = await B();
    const r4 = d.requirements.find((r) => r.seq === 4)!;
    const r5 = d.requirements.find((r) => r.seq === 5)!;
    return r4.status === "failed" && r5.status === "skipped" && !!r5.skipReason;
  }, 240000);
  const bDep = await B();
  const r5 = bDep.requirements.find((r) => r.seq === 5)!;
  check("依赖图：@N 语法 + 失败级联跳过（v2α）", depOk, r5.skipReason?.slice(0, 60));

  // 21. 记忆写回仓库（FR-G9 后半）：确认记忆 → CLAUDE.md → 提交 main
  await http(`/api/projects/${projB.id}/memories`, "POST", {}); // 批量确认 B 的提案
  const wb = await http<{ ok: boolean; message: string }>(`/api/projects/${projB.id}/memories/write-back`, "POST");
  check("记忆写回仓库 CLAUDE.md（FR-G9）", wb.data.ok === true, wb.data.message);
  const bProjId = projB.id;
  const claudeMd = (() => { try { return fs.readFileSync(path.join(process.cwd(), ".data", "repos", bProjId, "work", "CLAUDE.md"), "utf8"); } catch { return ""; } })();
  check("写回内容真实落库（CLAUDE.md in origin main）", claudeMd.includes("Broccoli 记忆写回"));

  // 22. 用户级偏好记忆（v2α FR-G10）：跨项目注入
  await http("/api/user/preferences", "POST", { content: "跨项目偏好：commit 信息使用中文" });
  const prefs = await http<{ content: string }[]>("/api/user/preferences", "GET");
  check("用户偏好保存（FR-G10）", prefs.data.some((p) => p.content.includes("commit 信息使用中文")));
  const lab = await http<{ id: string }>("/api/projects", "POST", { name: "prefs-lab" });
  await http(`/api/projects/${lab.data.id}/requirements`, "POST", { items: ["新增示例端点 /ping"] });
  let labRunId = "";
  await waitFor("偏好注入项目完成一个任务", async () => {
    const d = await http<ProjectData>(`/api/projects/${lab.data.id}`, "GET").then((r) => r.data!);
    const run = d.runs.find((r) => r.requirementId === d.requirements[0].id);
    if (run?.state === "completed") { labRunId = run.id; return true; }
    return false;
  }, 180000);
  const labCanvas = await http<{ run: { snapshot: { injections?: string[] } | null } }>(`/api/runs/${labRunId}`, "GET");
  check("个人偏好跨项目注入（FR-G10）", (labCanvas.data.run.snapshot?.injections ?? []).some((s) => s.includes("跨项目偏好")));
  await http(`/api/projects/${lab.data.id}`, "DELETE");

  console.log("\n========================================");
  if (failures === 0) {
    console.log("✅ 全部检查通过 —— MVP 全部功能（P0 + P1）+ 迭代 v2α 端到端可用");
  } else {
    console.log(`❌ ${failures} 项检查失败`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
