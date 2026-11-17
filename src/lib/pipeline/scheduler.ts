import { startQueuedRuns, driveRun, suspendExpired, applyConfirm } from "./orchestrator";
import { db } from "@/db";
import { taskRuns } from "@/db/schema";
import { eq, and, inArray, isNotNull } from "drizzle-orm";

/**
 * 调度器（dev 模式：进程内实现；生产为独立进程 + BullMQ，事件驱动见 design §6）。
 * 幂等性依赖 DB 事实源 + 原子认领（design §6「幂等与恢复」）。
 */

declare global {
  // eslint-disable-next-line no-var
  var __broccoliScheduler: { running: boolean; timer: NodeJS.Timeout | null } | undefined;
}

async function tick() {
  try {
    await startQueuedRuns();
    // 驱动运行中的 run
    const running = await db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(and(eq(taskRuns.state, "running"), isNotNull(taskRuns.startedAt)))
      .limit(20);
    for (const r of running) {
      await driveRun(r.id);
    }
    // 快照过期 → 挂起
    await suspendExpired();
  } catch (err) {
    console.error("[scheduler] tick error", err);
  }
}

export function startScheduler() {
  const state = (globalThis.__broccoliScheduler ??= { running: false, timer: null });
  if (state.running) return;
  state.running = true;
  const loop = async () => {
    await tick();
    if (state.running) state.timer = setTimeout(loop, 900);
  };
  void loop();
  console.log("[scheduler] started (interval 900ms)");
}

export function stopScheduler() {
  const state = globalThis.__broccoliScheduler;
  if (state?.timer) clearTimeout(state.timer);
  if (state) state.running = false;
}

// 保留引用避免 tree-shake 警告
void applyConfirm;
void inArray;
