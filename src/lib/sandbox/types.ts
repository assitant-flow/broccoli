import { execFile } from "child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 沙箱抽象（design §7：ExecutionTarget 落地面）——命令在受控执行环境中运行 */
export interface Sandbox {
  readonly name: "local" | "docker";
  /** 队列激活时确保执行环境就绪（docker 模式：基础设施 + 项目容器） */
  ensureForRun(projectId: string, workspace: string): Promise<void>;
  /** 在沙箱内执行命令（cwd 相对沙箱工作区根） */
  exec(projectId: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; failed: boolean }>;
  /** 队列空闲/进入等待确认时释放 */
  release(projectId: string): Promise<void>;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

export { run as execFileP };
