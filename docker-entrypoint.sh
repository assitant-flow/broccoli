#!/bin/sh
set -e
echo "[entrypoint] 1/3 数据库 schema 同步（drizzle push，网络失败自动重试）"
ok=""
for i in 1 2 3 4 5; do
  if pnpm exec drizzle-kit push --force; then ok=1; break; fi
  echo "[entrypoint] push 第 $i 次失败，5 秒后重试…"
  sleep 5
done
if [ -z "$ok" ]; then
  # schema 可能已在（重启场景）：探测一下关键表，存在则继续启动
  if pnpm exec tsx -e "
    import postgres from 'postgres';
    const c = postgres(process.env.DATABASE_URL);
    const t = await c\`select to_regclass('public.users') as t\`;
    if (!t[0].t) { console.error('schema 缺失且 push 持续失败'); process.exit(1); }
    await c.end();
  "; then
    echo "[entrypoint] schema 已存在，跳过 push 继续启动"
  fi
fi

echo "[entrypoint] 2/3 幂等初始化数据（已有数据则跳过）"
for i in 1 2 3; do
  if pnpm exec tsx scripts/seed.ts; then break; fi
  echo "[entrypoint] seed 第 $i 次失败，5 秒后重试…"
  sleep 5
done

echo "[entrypoint] 3/3 启动 Broccoli（next start）"
exec pnpm start
