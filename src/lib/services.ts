import { spawn } from "child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

/**
 * 服务生命周期（任务产出：启动的服务，v2β）。
 * 服务 = 交付阶段从仓库工作区真实启动的 node 进程（host 侧，工作区 bind 可见）；
 * 端口从 3930 起探测分配，健康检查通过后才登记 service_endpoints。
 * MVP 局限：服务随平台进程存亡（平台重启后标记 stopped）；docker 沙箱模式下
 * 服务同样 host 侧启动（工作区 bind 可见），生产形态改为容器内启动 + 端口发布（v2）。
 */

const PORT_BASE = 3930;
const PORT_MAX = 3990;

export interface StartedService {
  name: string;
  url: string;
  port: number;
  pid: number;
  logPath: string;
}

async function portFree(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function allocatePort(preferred: number): Promise<number> {
  for (let p = preferred; p <= PORT_MAX; p++) {
    if (await portFree(p)) return p;
  }
  for (let p = PORT_BASE; p < preferred; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`无可用端口（${PORT_BASE}-${PORT_MAX}）`);
}

/** 启动服务脚本（node <script>，PORT env 注入），健康检查通过后返回访问信息 */
export async function startService(params: {
  projectId: string;
  runId: string;
  name: string;
  scriptPath: string;
  preferredPort: number;
}): Promise<StartedService> {
  const port = await allocatePort(params.preferredPort);
  const logDir = path.join(process.cwd(), env.dataDir, "services");
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${params.runId.slice(0, 8)}-${port}.log`);
  const logFd = await fs.open(logPath, "w");

  const child = spawn("node", [params.scriptPath], {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
    env: { ...process.env, PORT: String(port), BROCCOLI_SERVICE: "1", GIT_TERMINAL_PROMPT: "0" },
    cwd: path.dirname(params.scriptPath),
  });
  child.unref();
  await logFd.close();

  // 健康检查：最多 8 秒轮询
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        return { name: params.name, url, port, pid: child.pid ?? 0, logPath };
      }
    } catch {
      /* 未就绪继续轮询 */
    }
  }
  // 启动失败：杀掉残留进程并抛错
  if (child.pid) try { process.kill(child.pid); } catch { /* 已退出 */ }
  const log = await fs.readFile(logPath, "utf8").catch(() => "");
  throw new Error(`服务健康检查失败（${url}）：${log.slice(0, 200)}`);
}

/** 停止服务进程 */
export async function stopServiceProcess(pid: number | null): Promise<boolean> {
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** 探测服务是否仍在响应 */
export async function probeService(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}
