import { env } from "@/lib/env";
import { LocalSandbox } from "./local";
import { DockerSandbox } from "./docker";
import type { Sandbox } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __broccoliSandbox: Sandbox | undefined;
}

/** 沙箱选择：BROCCOLI_SANDBOX=docker 启用容器隔离；默认 local（宿主进程，开发/CI 模式） */
export async function getSandbox(): Promise<Sandbox> {
  if (globalThis.__broccoliSandbox) return globalThis.__broccoliSandbox;
  const sandbox: Sandbox = env.sandbox === "docker" ? new DockerSandbox() : new LocalSandbox();
  globalThis.__broccoliSandbox = sandbox;
  return sandbox;
}

export { LocalSandbox, DockerSandbox };
export type { Sandbox };
