/**
 * 生产配置校验入口（容器 entrypoint 第 1 步调用；亦可手动运行：pnpm check:prod）。
 * 与启动守卫（src/instrumentation.ts）使用同一套规则；存在错误时以非零退出码拒绝继续。
 */
import { checkConfig } from "../src/lib/prod-config";

const issues = checkConfig(process.env);
for (const issue of issues) {
  console.log(`${issue.level === "error" ? "✗" : "⚠"} ${issue.key}：${issue.message}`);
}
const errors = issues.filter((issue) => issue.level === "error").length;
if (errors > 0) {
  console.error(`配置校验未通过（${errors} 项错误），拒绝启动。`);
  process.exit(1);
}
console.log(issues.length > 0 ? "✓ 配置校验通过（含警告，见上）" : "✓ 配置校验通过");

export {};
