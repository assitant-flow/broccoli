# 公网部署指南

> 本文档对应 `docker-compose.prod.yml`（公网编排）。本地自用仍用 `docker-compose.yml`，两者互不干扰。

## 0. 先确认适用边界（上线前必读）

这套部署是**单实例、面向可信用户**的公网形态。它**不适合**直接向不可信的陌生人开放注册，原因是执行沙箱：

- 用户接入的 GitHub 仓库，其测试脚本在应用容器内执行（`BROCCOLI_SANDBOX=local`）。
- 恶意仓库可以在容器内读取数据卷（其他用户的工作区、产物）与数据库连接串。
- 因此公网编排要求显式确认：`BROCCOLI_ACK_LOCAL_SANDBOX=1`，否则拒绝启动。

要对陌生用户开放，需要先把测试执行迁到独立的 Docker 沙箱（经 docker-socket-proxy 或独立 runner 主机），这是后续迭代的工作项。

已内置的加固（无需额外配置）：

| 项 | 行为 |
|---|---|
| 启动守卫 | `BROCCOLI_MODE=public` 时，弱口令、默认值、http 站点、演示账号等配置错误直接拒绝启动 |
| 演示账号 | 公网恒关闭；口令不再下发到前端 |
| 注册 | 默认关闭，由管理员用 `pnpm user:create` 开通 |
| 平台共享 Token | 公网关闭：访客不会消耗你的 Anthropic / GitHub 额度 |
| 登录防护 | 同 IP 15 分钟 30 次、同账号 8 次，超限返回 429 |
| 会话 Cookie | https 站点强制 `Secure`，`HttpOnly`，`SameSite=Lax` |
| 产物访问 | 仅本人可读，路径严格校验（修复了旧版路径遍历） |
| 沙箱环境 | 测试子进程不继承数据库连接串、主密钥、会话密钥、平台 Token |
| 容器 | 应用以非 root（uid 1000）运行；数据库不发布端口；仅 Caddy 对外 |
| HTTPS | Caddy 自动申请 Let's Encrypt 证书，并下发 HSTS |
| 响应头 | `X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy`、`Permissions-Policy` |

## 1. 服务器准备

- 配置建议：2 vCPU / 4 GB 内存 / 40 GB 磁盘，Ubuntu 22.04+ 或 Debian 12。
- 安装 Docker Engine 与 compose 插件（v2.20+）。
- 防火墙只开放 22（建议改为密钥登录并限制来源）、80、443。
- DNS：域名 A 记录指向服务器公网 IP，**先生效再启动**（Caddy 申请证书依赖正确解析）。

## 2. 获取代码与配置

```bash
git clone <仓库地址> broccoli && cd broccoli
git checkout v0.1.0            # 建议部署带 tag 的版本
cp .env.production.example .env.production
chmod 600 .env.production
```

编辑 `.env.production`，至少填写：

- `BROCCOLI_DOMAIN`、`BROCCOLI_SITE_URL`（同一个域名，后者带 `https://`）
- `SESSION_SECRET`：`openssl rand -hex 32`
- `BROCCOLI_MASTER_KEY`：`openssl rand -hex 32`（**设定后不可更换**，否则已存的 Token 无法解密）
- `POSTGRES_PASSWORD`：`openssl rand -hex 24`
- `BROCCOLI_ACK_LOCAL_SANDBOX=1`（确认第 0 节的边界后）

## 3. 启动

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs app | head -30
```

启动守卫会在日志里逐项输出校验结果。若 `app` 反复重启，说明有配置未通过：看日志中以 `✗` 开头的行，修正 `.env.production` 后执行 `up -d` 即可。

验证：`curl -sI https://<你的域名>/` 应返回 `200` 与 `Strict-Transport-Security` 头。

## 4. 开通账号

注册默认关闭，由管理员开通。口令通过交互输入，避免进入 shell 历史：

```bash
read -rsp "账号密码（至少 8 位）: " PW; echo
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec -e USER_EMAIL=you@example.com -e USER_PASSWORD="$PW" app ./node_modules/.bin/tsx scripts/create-user.ts
unset PW
```

如需开放自助注册，设置 `BROCCOLI_REGISTRATION=open` 后 `up -d`（风险自负，建议配合邀请制）。

## 5. GitHub OAuth 登录（可选）

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. Homepage URL：`https://<你的域名>`
3. Authorization callback URL：`https://<你的域名>/api/auth/github/callback`
4. 把 Client ID / Client Secret 填入 `.env.production`，执行 `up -d`。登录页会出现「使用 GitHub 登录」。

注册关闭时，OAuth 只能登录已存在的账号；新 GitHub 用户会被提示联系管理员。

## 6. 用户接入自己的 AI

公网不共用平台 Token。每位用户登录后在「接入设置」填写自己的 Anthropic 兼容端点与 Token（加密存储，界面只回显掩码）。

## 7. 备份与恢复

`scripts/backup.sh` 导出数据库（pg_dump）并归档应用数据卷（仓库工作区、产物、服务日志）。

```bash
# 手动执行；项目名默认取目录名，与 docker compose ps 显示一致
BROCCOLI_COMPOSE_PROJECT=broccoli ./scripts/backup.sh

# 每日 03:00 自动备份（crontab -e）
0 3 * * * cd /opt/broccoli && BROCCOLI_COMPOSE_PROJECT=broccoli ./scripts/backup.sh >> /var/log/broccoli-backup.log 2>&1
```

**备份不含主密钥。** 恢复时必须使用同一个 `BROCCOLI_MASTER_KEY`，所以请把 `.env.production` 单独离线保存。

恢复数据库：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec -T postgres pg_restore -U broccoli -d broccoli --clean < backups/<时间戳>/db.dump
```

定期做一次恢复演练，备份未验证过等于没有备份。

## 8. 升级与回滚

```bash
git fetch --tags && git checkout <新版本 tag>
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

应用启动时会自动同步数据库 schema（drizzle push）。升级前先执行备份。

回滚：`git checkout <旧 tag>` 后重新 `up -d --build`。注意 schema 只升不降：若新版本已改动表结构，回滚需要从升级前的备份恢复数据库。

## 9. 运维速查

| 操作 | 命令 |
|---|---|
| 状态 | `... ps` |
| 日志 | `... logs -f app` |
| 重启应用 | `... restart app` |
| 停止 | `... down`（数据卷保留） |

资源上限已设置：app 2 GB、postgres 1 GB、caddy 256 MB；日志单文件 10 MB、保留 3 个。

## 10. 上线前安全清单

- [ ] `.env.production` 权限为 600，未提交到仓库
- [ ] 防火墙只开放 80/443（22 限制来源或仅密钥登录）
- [ ] 数据库未对外暴露（编排文件中 postgres 无 `ports`）
- [ ] 演示账号与平台共享 Token 已关闭（编排文件中已固定为 0）
- [ ] 注册策略已确认（默认 closed）
- [ ] 已确认沙箱边界（第 0 节），`BROCCOLI_ACK_LOCAL_SANDBOX=1` 仅用于可信用户
- [ ] 备份已执行并完成一次恢复演练
- [ ] 已把 `BROCCOLI_MASTER_KEY` 与 `.env.production` 离线保存

## 11. 已知限制

- **单实例**：限流计数在进程内存中，容器重启后清零。多实例部署需要换成 Redis。
- **沙箱隔离**：见第 0 节，当前 local 沙箱只适合可信用户。
- **无 WAF / DDoS 防护**：建议在域名前接入 Cloudflare 等代理。
- **主密钥不可丢失**：丢失 `BROCCOLI_MASTER_KEY` 后，已存的 AI / GitHub Token 无法恢复，用户需重新填写。
- **服务地址仅本机可达**：交付阶段启动的服务运行在应用容器内。公网编排未发布服务端口，页面上的服务地址只在服务器本机可达（本地 `docker-compose.yml` 已发布 3930–3990 供本机访问）。对外暴露服务需要为其增加 Caddy 路由，属于后续工作。

## 12. 排错

| 现象 | 处理 |
|---|---|
| `app` 反复重启 | `logs app` 中查看 `✗` 项，修正 `.env.production` |
| HTTPS 证书申请失败 | 确认 DNS 已生效，且 80/443 可从公网访问 |
| 502 Bad Gateway | 应用未就绪：`logs app`，等待健康检查通过 |
| 登录返回 429 | 同 IP 或同账号超限，等待 15 分钟；或检查是否有反向代理未正确传递 `X-Forwarded-For` |
