/**
 * 服务产物专项验证（v2β）：服务类任务交付后真实启动 HTTP 服务，
 * 访问地址登记并在任务页/项目页 API 可查，响应内容正确，可停止。
 * 前置：pnpm dev 运行中（BROCCOLI_SANDBOX 任意）。运行：pnpm verify:services
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

async function main() {
  console.log("== 服务产物专项验证（v2β：服务地址产出 + 文件清单）==\n");

  await http("/api/auth/login", "POST", { email: "thomas@broccoli.dev", password: "broccoli123" });

  // 1. 建项目 + 提交服务类需求
  const proj = await http<{ id: string }>("/api/projects", "POST", { name: `service-lab-${Date.now() % 100000}`, failurePolicy: "skip_continue" });
  const pid = proj.data.id;
  const P = () => http<{ requirements: { id: string; seq: number; status: string; latestRunId: string | null }[]; runs: { id: string; requirementId: string; state: string }[]; prs: { number: number }[] }>(`/api/projects/${pid}`, "GET").then((r) => r.data!);
  await http(`/api/projects/${pid}/requirements`, "POST", {
    items: ["启动一个状态检查 HTTP 服务，访问任意路径返回运行状态 JSON"],
  });
  check("提交服务类需求", proj.status === 200);

  // 2. 流水线完成
  const done = await waitFor("服务类任务完成（含真实服务启动）", async () => {
    const d = await P();
    return d.requirements[0].status === "done";
  }, 240000);
  check("流水线完成", done);
  const d1 = await P();
  const run1 = d1.runs.find((r) => r.requirementId === d1.requirements[0].id)!;

  // 3. 服务 API：项目服务列表有 running 服务
  const services = await http<{ id: string; name: string; url: string; port: number; status: string; runId: string }[]>(`/api/projects/${pid}/services`, "GET");
  const svc = services.data.find((s) => s.status === "running");
  check("服务地址已登记且运行中（项目 API）", !!svc, svc ? `${svc.url}` : "无 running 服务");

  // 4. 真实访问：GET URL → 200 + JSON 含 service/status
  if (svc) {
    const res = await fetch(svc.url);
    const body = (await res.json().catch(() => ({}))) as { service?: string; status?: string; requirement?: number };
    check("服务真实可访问（HTTP 200）", res.status === 200);
    check("响应内容正确（service/status/requirement）", body.status === "ok" && body.requirement === 1, JSON.stringify(body).slice(0, 80));
  }

  // 5. 任务产物：run 画布含 kind=service 产物 + 文件清单（meta.files）
  const canvas = await http<{ artifacts: { kind: string; name: string; meta: { url?: string; files?: string[] } }[] }>(`/api/runs/${run1.id}`, "GET");
  const svcArtifact = canvas.data.artifacts.find((a) => a.kind === "service");
  check("任务产物含服务地址（kind=service）", !!svcArtifact, svcArtifact?.meta?.url);
  const manifest = [...new Set(canvas.data.artifacts.flatMap((a) => a.meta?.files ?? []))];
  check("文件清单产出（dev meta.files 非空）", manifest.length > 0, manifest.join(",").slice(0, 80));

  // 6. 停止服务 → 状态 stopped，URL 不可达
  if (svc) {
    const stop = await http<{ ok: boolean }>(`/api/services/${svc.id}/stop`, "POST");
    check("停止服务 API", stop.data.ok === true);
    await new Promise((r) => setTimeout(r, 800));
    const after = await http<{ status: string }[]>(`/api/projects/${pid}/services`, "GET");
    check("停止后状态落库（stopped）", after.data.every((s) => s.status === "stopped"));
    let unreachable = false;
    try { const res = await fetch(svc.url, { signal: AbortSignal.timeout(1500) }); unreachable = res.status >= 500; } catch { unreachable = true; }
    check("停止后 URL 不再可达", unreachable);
  }

  // 7. 清理
  await http(`/api/projects/${pid}`, "DELETE");

  console.log("\n========================================");
  if (failures === 0) console.log("✅ 服务产物专项验证全部通过");
  else console.log(`❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
