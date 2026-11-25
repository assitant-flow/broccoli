import { checkConfig } from "@/lib/prod-config";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 启动守卫：公网模式（BROCCOLI_MODE=public）配置不合规则拒绝启动，不带病上线
  const issues = checkConfig(process.env);
  for (const issue of issues) {
    console.log(`[config] ${issue.level === "error" ? "✗" : "⚠"} ${issue.key}: ${issue.message}`);
  }
  if (issues.some((issue) => issue.level === "error")) {
    console.error("[config] 生产配置校验未通过，拒绝启动（详见 docs/DEPLOY-PUBLIC.md）");
    process.exit(1);
  }

  const { startScheduler } = await import("@/lib/pipeline/scheduler");
  startScheduler();
}
