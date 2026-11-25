#!/bin/sh
# 运行期不调用 pnpm：非 root 运行时 pnpm 会尝试按锁文件重装依赖（因属主与存储目录不同而失败）。
# 直接使用安装好的可执行文件即可。
set -e

echo "[entrypoint] 1/4 配置校验（BROCCOLI_MODE=public 时严格；不通过则拒绝启动）"
./node_modules/.bin/tsx scripts/check-prod.ts

echo "[entrypoint] 2/4 数据库 schema 同步（drizzle push，网络失败自动重试）"
ok=""
for i in 1 2 3 4 5; do
  if ./node_modules/.bin/drizzle-kit push --force; then ok=1; break; fi
  echo "[entrypoint] push 第 $i 次失败，5 秒后重试…"
  sleep 5
done
if [ -z "$ok" ]; then
  # schema 可能已在（重启场景）：探测关键表，存在则继续启动
  if ./node_modules/.bin/tsx -e "
    import postgres from 'postgres';
    const c = postgres(process.env.DATABASE_URL);
    const t = await c\`select to_regclass('public.users') as t\`;
    if (!t[0].t) { console.error('schema 缺失且 push 持续失败'); process.exit(1); }
    await c.end();
  "; then
    echo "[entrypoint] schema 已存在，跳过 push 继续启动"
  fi
fi

echo "[entrypoint] 3/4 演示数据（仅 BROCCOLI_SEED_DEMO=1 时幂等初始化）"
if [ "${BROCCOLI_SEED_DEMO:-1}" = "1" ]; then
  for i in 1 2 3; do
    if ./node_modules/.bin/tsx scripts/seed.ts; then break; fi
    echo "[entrypoint] seed 第 $i 次失败，5 秒后重试…"
    sleep 5
  done
else
  echo "[entrypoint] 跳过演示数据（BROCCOLI_SEED_DEMO=${BROCCOLI_SEED_DEMO}）"
fi

echo "[entrypoint] 4/4 启动 Broccoli（next start）"
exec ./node_modules/.bin/next start
