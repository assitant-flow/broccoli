/**
 * 沙箱容器 + 网络白名单专项验证（FR-H2/H3，design §7/§12）。
 * A 部分：基础设施断言（镜像/只读根/资源限额/白名单分阶段拦截/审计日志）——直接驱动 docker CLI。
 * B 部分：集成断言——server 需以 BROCCOLI_SANDBOX=docker 启动，流水线测试在容器内真实执行，完成即回收。
 * 运行：pnpm verify:sandbox
 */
import { execFile } from "child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const run = promisify(execFile);
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

async function docker(args: string[], timeoutMs = 180000): Promise<string> {
  const { stdout } = await run("docker", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8 });
  return stdout.trim();
}

/** 在一次性沙箱容器（与运行时完全一致的加固参数）内执行命令 */
async function sandboxExec(args: string[], timeoutMs = 90000): Promise<string> {
  const sandboxArgs = [
    "run", "--rm", "--network", "broccoli-sbx-internal",
    "--read-only", "--tmpfs", "/tmp:size=128m",
    "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "-u", "node",
    "-e", "HTTPS_PROXY=http://broccoli-egress:8080",
    "-e", "HTTP_PROXY=http://broccoli-egress:8080",
    "-w", "/tmp",
    "broccoli-sandbox:latest",
    "sh", "-c", args.join(" "),
  ];
  try {
    const { stdout } = await run("docker", sandboxArgs, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (err: unknown) {
    return `__FAILED__:${String((err as { stderr?: string }).stderr ?? err).slice(0, 120)}`;
  }
}

async function setPhase(phase: string) {
  const stateDir = ".data/sandbox-state";
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(`${stateDir}/current-phase`, phase);
  await new Promise((r) => setTimeout(r, 1200)); // proxy watchFile 轮询间隔
}

async function main() {
  console.log("== 沙箱容器 + 网络白名单专项验证（FR-H2/H3）==\n");

  // A0. Docker 可用性
  let dockerOk = true;
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15000 });
  } catch {
    dockerOk = false;
  }
  check("Docker 可用", dockerOk);
  if (!dockerOk) process.exit(1);

  // A1. 基础设施就绪（镜像构建 + 双网络 + 白名单代理）
  await docker(["build", "-q", "-f", "sandbox/Dockerfile.sandbox", "-t", "broccoli-sandbox:latest", "sandbox"], 300000);
  await docker(["build", "-q", "-f", "sandbox/Dockerfile.proxy", "-t", "broccoli-egress-proxy:latest", "sandbox"], 300000);
  for (const net of ["broccoli-sbx-internal", "broccoli-sbx-egress"]) {
    const exists = await docker(["network", "inspect", net, "--format", "{{.Name}}"]).then(() => true).catch(() => false);
    if (!exists) await docker(["network", "create", ...(net.includes("internal") ? ["--internal"] : []), net]);
  }
  const proxyRunning = await docker(["ps", "--filter", `name=^/broccoli-egress$`, "--format", "{{.Names}}"]).catch(() => "");
  if (!proxyRunning.includes("broccoli-egress")) {
    await docker(["rm", "-f", "broccoli-egress"]).catch(() => {});
    await docker([
      "run", "-d", "--name", "broccoli-egress", "--network", "broccoli-sbx-egress",
      "-v", `${process.cwd()}/sandbox:/app:ro`,
      "-v", `${process.cwd()}/.data/sandbox-state:/state`,
      "--restart", "unless-stopped", "broccoli-egress-proxy:latest",
    ]);
    await docker(["network", "connect", "broccoli-sbx-internal", "broccoli-egress"]);
  }
  check("基础设施就绪（镜像 ×2 + 双网络 + 白名单代理）", true);

  // A2. 只读根文件系统
  const ro = await sandboxExec(["touch /usr/should-fail && echo RW || echo RO"]);
  check("根文件系统只读（写 /usr 被拒）", ro === "RO", ro.slice(0, 40));

  // A3. 资源限额生效（512MB 内存下申请 700MB 应失败）；判定值以 base64 输出，
  // 避免报错回显源码中的明文标记造成假阳性（"OK" 的 base64 = T0s=）
  const memScript = 'try { Buffer.alloc(700*1024*1024); console.log(Buffer.from("OK").toString("base64")); } catch { console.error("OOM"); }';
  const mem = await sandboxExec([`node -e "${memScript}"`]);
  check("内存限额生效（512m，700MB 分配失败）", !mem.includes("T0s="), `out=${mem.slice(0, 50)}`);

  // A4. execute 阶段白名单：GitHub API 放行，外域拦截
  await setPhase("execute");
  const gh = await sandboxExec(["curl -s -o /dev/null -w \"%{http_code}\" https://api.github.com"]);
  check("execute 阶段：api.github.com 放行（FR-H2 白名单）", gh === "200" || gh === "401" || gh === "403", `http=${gh}`);
  const deny = await sandboxExec(["curl -s -o /dev/null -w \"%{http_code}\" --max-time 15 https://example.com"]);
  check("execute 阶段：example.com 被白名单拦截", deny === "" || deny === "000" || deny.includes("__FAILED__"), `res=${deny.slice(0, 30)}`);

  // A5. prepare 阶段白名单反转：registry 放行，GitHub 拦截
  await setPhase("prepare");
  const npm = await sandboxExec(["curl -s -o /dev/null -w \"%{http_code}\" --max-time 20 https://registry.npmjs.org"]);
  check("prepare 阶段：npm registry 放行（分阶段白名单）", npm === "200", `http=${npm}`);
  const ghBlocked = await sandboxExec(["curl -s -o /dev/null -w \"%{http_code}\" --max-time 15 https://api.github.com"]);
  check("prepare 阶段：api.github.com 被拦截（分阶段反转）", ghBlocked === "" || ghBlocked === "000" || ghBlocked.includes("__FAILED__"), `res=${ghBlocked.slice(0, 30)}`);
  await setPhase("execute");

  // A6. 审计日志存在（proxy stdout）
  const logs = await docker(["logs", "broccoli-egress"]).catch(() => "");
  check("egress 审计日志记录判定（FR-H2 审计）", logs.includes("[egress][audit]") && logs.includes("DENY"));

  // B. 集成断言：server 需以 BROCCOLI_SANDBOX=docker 启动（否则流水线回落宿主执行，此处仍会通过但不含容器证据）
  console.log("");
  {
    await http("/api/auth/login", "POST", { email: "thomas@broccoli.dev", password: "broccoli123" });
    const proj = await http<{ id: string }>("/api/projects", "POST", { name: `sandbox-lab-${Date.now() % 100000}` });
    await http(`/api/projects/${proj.data.id}/requirements`, "POST", {
      items: ["新增 utils/ping 模块，ping() 返回 pong 字符串"],
    });
    const done = await waitFor("集成：流水线任务在容器内完成（测试执行入容器）", async () => {
      const d = await http<{ requirements: { status: string }[] }>(`/api/projects/${proj.data.id}`, "GET").then((r) => r.data!);
      return d.requirements[0].status === "done";
    }, 300000);
    check("集成：流水线在 docker 沙箱下完成（FR-H2/H3）", done);
    // 容器证据：测试报告记录沙箱类型（docker 模式下运行时写入）
    const runId = (await http<{ requirements: { latestRunId: string | null }[] }>(`/api/projects/${proj.data.id}`, "GET").then((r) => r.data!)).requirements[0].latestRunId!;
    const report = await fetch(`${BASE}/api/artifacts?runId=${runId}&name=${encodeURIComponent("测试报告.md")}`, { headers: { cookie } }).then((r) => r.text());
    check("集成：测试在容器内执行（报告含沙箱类型 docker）", report.includes("沙箱：docker"));
    // 回收断言：完成即释放（docker ps 无该容器）
    await new Promise((r) => setTimeout(r, 2500));
    const running = await docker(["ps", "--format", "{{.Names}}"]).catch(() => "");
    check("集成：任务完成后容器已回收（FR-H3 空闲回收）", !running.includes("broccoli-sbx-"));
  }

  console.log("\n========================================");
  if (failures === 0) console.log("✅ 沙箱容器 + 网络白名单专项验证全部通过");
  else console.log(`❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
