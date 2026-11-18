import { execFile } from "child_process";
import { promisify } from "node:util";
import path from "node:path";
import { workPath } from "@/lib/git";
import type { Sandbox } from "./types";

const run = promisify(execFile);

/** 本地沙箱：现状行为——宿主进程在工作区目录内执行（无隔离，默认模式） */
export class LocalSandbox implements Sandbox {
  readonly name = "local" as const;

  async ensureForRun(): Promise<void> {
    /* 本地模式无环境准备 */
  }

  async exec(projectId: string, args: string[], opts?: { timeoutMs?: number }) {
    const cwd = workPath(projectId);
    try {
      const res = await run(args[0], args.slice(1), {
        cwd,
        maxBuffer: 1024 * 1024 * 8,
        timeout: opts?.timeoutMs ?? 120000,
        shell: true, // 支持 glob（node --test "tests/*.test.mjs"）
      });
      return { stdout: res.stdout, failed: false };
    } catch (err: unknown) {
      return { stdout: String((err as { stdout?: string }).stdout ?? err), failed: true };
    }
  }

  async release(): Promise<void> {
    /* 无需释放 */
  }
}

export function localWorkspace(projectId: string): string {
  return path.join("local", projectId);
}
