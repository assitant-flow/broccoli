/**
 * 挂起超时路径专项验证（FR-D5/AC-D5）：
 * TTL 调小 → 等待确认超时 → 自动挂起（快照过期）→ 队列继续 → 重新入队 → 回答 → 完成。
 * 前置：server 以 BROCCOLI_SNAPSHOT_TTL_HOURS=0.01 启动。运行：pnpm verify:suspend
 */
const BASE = "http://localhost:3000";
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

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 180000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      console.log(`  … ${desc}（${Math.round((Date.now() - start) / 1000)}s）`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`  … 超时：${desc}`);
  return false;
}

type Req = { id: string; seq: number; title: string; status: string; latestRunId: string | null };
type Run = { id: string; requirementId: string; state: string; error: string | null; attemptNo: number };
type ProjectData = { project: { id: string; name: string }; requirements: Req[]; runs: Run[] };

async function main() {
  console.log("== 挂起超时路径专项验证（FR-D5/AC-D5）==\n");

  await http("/api/auth/login", "POST", { email: "thomas@broccoli.dev", password: "broccoli123" });

  // 临时项目
  const proj = await http<{ id: string; name: string }>("/api/projects", "POST", { name: "suspend-lab", failurePolicy: "pause" });
  check("创建临时项目", proj.status === 200, proj.data.name);
  const pid = proj.data.id;
  const P = () => http<ProjectData>(`/api/projects/${pid}`, "GET").then((r) => r.data!);

  // 两条需求：#1 触发选型确认；#2 独立
  await http(`/api/projects/${pid}/requirements`, "POST", {
    items: ["为定时任务引入持久化存储层", "新增健康检查端点 /healthz"],
  });

  // 1. run1 → 等待确认
  const waitOk = await waitFor("需求 #1 进入等待确认", async () => {
    const d = await P();
    const run = d.runs.find((r) => r.requirementId === d.requirements.find((q) => q.seq === 1)!.id)!;
    return run.state === "wait_confirm";
  }, 60000);
  check("结构化提问触发（FR-D4）", waitOk);

  // 2. TTL 过期 → 自动挂起
  const suspOk = await waitFor("等待确认超时 → 自动挂起", async () => {
    const d = await P();
    const run = d.runs.find((r) => r.requirementId === d.requirements.find((q) => q.seq === 1)!.id)!;
    const req = d.requirements.find((q) => q.seq === 1)!;
    return run.state === "suspended" && req.status === "suspended";
  }, 120000);
  check("超时自动挂起（FR-D5/AC-D5）", suspOk);
  const d1 = await P();
  const run1 = d1.runs.find((r) => r.requirementId === d1.requirements.find((q) => q.seq === 1)!.id)!;

  // 3. 挂起通知（站内 + outbox 邮件）
  const notifs = await http<{ type: string }[]>("/api/notifications", "GET");
  check("挂起站内通知（FR-E5）", notifs.data.some((n) => n.type === "suspended"));
  const fs = await import("node:fs/promises");
  const outbox = await fs.readdir(".data/outbox").catch(() => [] as string[]);
  check("挂起邮件落盘（FR-E4）", outbox.some((f) => f.includes("suspended")));

  // 4. 队列继续：#2 在 #1 挂起后启动并完成
  const contOk = await waitFor("挂起后队列继续，#2 独立完成", async () => {
    const d = await P();
    const run2 = d.runs.find((r) => r.requirementId === d.requirements.find((q) => q.seq === 2)!.id)!;
    return run2?.state === "completed";
  }, 120000);
  check("挂起不阻塞队列（AC-D5 队列继续）", contOk);

  // 5. 重新入队 → 再次等待确认 → 立即回答 → 完成
  const req1 = d1.requirements.find((q) => q.seq === 1)!;
  await http(`/api/requirements/${req1.id}/requeue`, "POST");
  const rewaitOk = await waitFor("重新入队后再次进入等待确认", async () => {
    const d = await P();
    const run = d.runs.find((r) => r.requirementId === req1.id && r.attemptNo === 2)!;
    return run?.state === "wait_confirm";
  }, 60000);
  check("挂起需求可重新入队（AC-D5）", rewaitOk);
  const d2 = await P();
  const run1v2 = d2.runs.find((r) => r.requirementId === req1.id && r.attemptNo === 2)!;
  const ans = await http<{ ok: boolean }>(`/api/runs/${run1v2.id}/confirm`, "POST", { answer: "PostgreSQL + Redis", optionKey: "postgres" });
  check("挂起后回答确认恢复正常", ans.data.ok === true);
  const doneOk = await waitFor("重新入队的需求执行完成", async () => {
    const d = await P();
    const run = d.runs.find((r) => r.requirementId === req1.id && r.attemptNo === 2)!;
    return run?.state === "completed";
  }, 120000);
  check("恢复后全流程跑通", doneOk);

  // 6. 清理：删除项目（顺带验证 FR-B3 删除路径）
  const del = await http<{ deleted: string }>(`/api/projects/${pid}`, "DELETE");
  const gone = await http<{ status: number }>(`/api/projects/${pid}`, "GET");
  check("删除项目（FR-B3）+ 清理", del.status === 200 && gone.status === 404);

  console.log("\n========================================");
  if (failures === 0) console.log("✅ 挂起超时路径验证全部通过");
  else console.log(`❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
