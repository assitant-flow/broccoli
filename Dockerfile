# Broccoli 应用镜像（数据库用 docker-compose 的 postgres 服务）
FROM node:22-alpine AS base
# pnpm 与锁文件版本一致。构建期即预取 pnpm 原生二进制（pnpm 12 首次运行时才下载），
# 缓存目录全局只读，运行期禁止 corepack 联网：非 root 运行时不再尝试写入缓存
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
 && corepack prepare pnpm@12.16.1 --activate \
 && pnpm -v \
 && chmod -R a+rX /opt/corepack
ENV COREPACK_ENABLE_NETWORK=0

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 构建期仅需要依赖可解析，DB 不参与构建
RUN pnpm exec tsc --noEmit && pnpm build

FROM base AS runtime
WORKDIR /app
# git（Runner 侧仓库操作）与 curl（healthcheck）。数据目录预先归属 uid 1000：
# 生产编排以 user: 1000:1000 运行，具名卷首次挂载会继承镜像内的属主
RUN apk add --no-cache git curl \
 && mkdir -p /app/.data \
 && chown 1000:1000 /app/.data
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -sf http://localhost:3000/api/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
