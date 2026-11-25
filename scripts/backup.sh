#!/bin/sh
# 备份：Postgres 逻辑导出（custom 格式）+ 应用数据卷归档（仓库工作区 / 产物 / 服务日志）。
# 在仓库根目录执行；默认使用 .env.production 与 docker-compose.prod.yml。
#   BROCCOLI_COMPOSE_PROJECT=broccoli-prod ./scripts/backup.sh
set -eu

PROJECT="${BROCCOLI_COMPOSE_PROJECT:-broccoli}"
ENV_FILE="${ENV_FILE:-.env.production}"
DEST="${BACKUP_DIR:-./backups}/$(date +%Y%m%d-%H%M%S)"
COMPOSE="docker compose -p $PROJECT -f docker-compose.prod.yml --env-file $ENV_FILE"

mkdir -p "$DEST"
$COMPOSE exec -T postgres pg_dump -U broccoli -d broccoli --format=custom > "$DEST/db.dump"
docker run --rm \
  -v "${PROJECT}_appdata:/data:ro" \
  -v "$(cd "$DEST" && pwd):/backup" \
  alpine tar czf /backup/appdata.tgz -C /data .

echo "✓ 备份完成：$DEST（db.dump + appdata.tgz）"
echo "  恢复数据库：$COMPOSE exec -T postgres pg_restore -U broccoli -d broccoli --clean < $DEST/db.dump"
