import { execFile } from "child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { workPath } from "@/lib/git";
import type { Sandbox } from "./types";

const run = promisify(execFile);

/**
 * Docker 沙箱（design §7/§12 落地）：
 * - 每项目队列一个非特权容器：只读根文件系统、tmpfs /tmp、CPU/内存/PIDs 限额、cap 全部移除、no-new-privileges
 * - 容器挂 internal 网络（无宿主路由），唯一出口为白名单 egress proxy（分阶段规则 + 审计日志）
 * - 工作区 bind-mount 至 /workspace；token/LLM key 不进容器（push 与 LLM 调用均在宿主 Runner 侧）
 */

const NET_INTERNAL = "broccoli-sbx-internal";
const NET_EGRESS = "broccoli-sbx-egress";
const PROXY_NAME = "broccoli-egress";
const IMAGE_SANDBOX = "broccoli-sandbox:latest";
const IMAGE_PROXY = "broccoli-egress-proxy:latest";
const CONTAINER_PREFIX = "broccoli-sbx-";

function containerName(projectId: string) {
  return `${CONTAINER_PREFIX}${projectId.replace(/-/g, "").slice(0, 12)}`;
}

async function docker(args: string[], timeoutMs = 120000): Promise<string> {
  const { stdout } = await run("docker", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8 });
  return stdout.trim();
}

async function containerExists(name: string, requireRunning: boolean): Promise<boolean> {
  const args = ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}} {{.State}}"];
  const out = await docker(args).catch(() => "");
  const line = out.split("\n").find((l) => l.startsWith(name));
  if (!line) return false;
  return requireRunning ? line.includes("running") || line.includes("restarting") : true;
}

export class DockerSandbox implements Sandbox {
  readonly name = "docker" as const;
  private infraReady = false;

  /** 基础设施：镜像构建（缺失时）+ internal/egress 双网络 + 白名单代理容器 */
  async ensureInfra(): Promise<void> {
    if (this.infraReady) return;

    for (const [image, dockerfile, ctx] of [
      [IMAGE_SANDBOX, "Dockerfile.sandbox", "sandbox"],
      [IMAGE_PROXY, "Dockerfile.proxy", "sandbox"],
    ] as const) {
      const exists = await docker(["image", "inspect", image, "--format", "{{.Id}}"]).then(() => true).catch(() => false);
      if (!exists) {
        await docker(["build", "-q", "-f", dockerfile, "-t", image, ctx], 300000);
      }
    }

    for (const net of [NET_INTERNAL, NET_EGRESS]) {
      const exists = await docker(["network", "inspect", net, "--format", "{{.Name}}"]).then(() => true).catch(() => false);
      if (!exists) {
        await docker(["network", "create", ...(net === NET_INTERNAL ? ["--internal"] : []), net]);
      }
    }

    const proxyUp = await containerExists(PROXY_NAME, true);
    if (!proxyUp) {
      await docker(["rm", "-f", PROXY_NAME]).catch(() => {});
      await docker([
        "run", "-d", "--name", PROXY_NAME,
        "--network", NET_EGRESS,
        "-v", `${path.resolve("sandbox")}:/app:ro`,
        "-v", `${path.resolve(".data/sandbox-state")}:/state`,
        "--restart", "unless-stopped",
        IMAGE_PROXY,
      ]);
      await docker(["network", "connect", NET_INTERNAL, PROXY_NAME]);
    }

    await fs.mkdir(path.resolve(".data/sandbox-state"), { recursive: true });
    const phaseFile = path.resolve(".data/sandbox-state/current-phase");
    await fs.writeFile(phaseFile, "execute").catch(() => {});
    this.infraReady = true;
  }

  /** 切换出站阶段（prepare：放行依赖 registry；execute：仅 Anthropic/GitHub 域） */
  async setPhase(phase: "prepare" | "execute"): Promise<void> {
    const phaseFile = path.resolve(".data/sandbox-state/current-phase");
    await fs.mkdir(path.dirname(phaseFile), { recursive: true });
    await fs.writeFile(phaseFile, phase);
  }

  async ensureForRun(projectId: string, workspace: string): Promise<void> {
    await this.ensureInfra();
    const name = containerName(projectId);
    const running = await containerExists(name, true);
    if (running) return; // 容器随队列复用（FR-H3）

    await docker(["rm", "-f", name]).catch(() => {});
    await docker([
      "run", "-d", "--name", name,
      "--network", NET_INTERNAL,
      // 非特权加固（design §12）：只读根、tmpfs /tmp、资源限额、cap 全移除、no-new-privileges
      "--read-only",
      "--tmpfs", "/tmp:size=128m",
      "--memory", "512m",
      "--cpus", "1",
      "--pids-limit", "128",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "-u", "node",
      "-v", `${path.resolve(workspace)}:/workspace`,
      "-e", "HTTPS_PROXY=http://broccoli-egress:8080",
      "-e", "HTTP_PROXY=http://broccoli-egress:8080",
      "-e", "NO_PROXY=localhost,127.0.0.1,broccoli-egress",
      IMAGE_SANDBOX,
    ]);
    await docker(["network", "disconnect", NET_EGRESS, name]).catch(() => {});
  }

  async exec(projectId: string, args: string[], opts?: { timeoutMs?: number }) {
    const name = containerName(projectId);
    const command = args.join(" ");
    try {
      const res = await run("docker", ["exec", "-w", "/workspace", name, "sh", "-c", command], {
        timeout: opts?.timeoutMs ?? 120000,
        maxBuffer: 1024 * 1024 * 8,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return { stdout: res.stdout, failed: false };
    } catch (err: unknown) {
      return { stdout: String((err as { stdout?: string }).stdout ?? err), failed: true };
    }
  }

  async release(projectId: string): Promise<void> {
    const name = containerName(projectId);
    await docker(["rm", "-f", name]).catch(() => {});
  }
}

/** 供验证脚本复用的沙箱容器运行参数（与 ensureForRun 完全一致的加固配置） */
export function sandboxRunArgs(extra: string[] = []): string[] {
  return [
    "--read-only",
    "--tmpfs", "/tmp:size=128m",
    "--memory", "512m",
    "--cpus", "1",
    "--pids-limit", "128",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "-u", "node",
    "-e", "HTTPS_PROXY=http://broccoli-egress:8080",
    "-e", "HTTP_PROXY=http://broccoli-egress:8080",
    ...extra,
  ];
}

export const SANDBOX_NET_INTERNAL = NET_INTERNAL;
