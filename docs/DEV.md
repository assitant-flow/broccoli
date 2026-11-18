# Broccoli 开发与运行指南

> 本仓库已实现 [requirements](requirements.md) / [design](design.md) 定义的 **MVP 全部 P0 功能**，并附带离线演示模式（无需 Anthropic key / GitHub 授权即可端到端跑通）。本文档说明如何运行、演示脚本覆盖哪些验收路径、以及与设计文档的偏差清单。**当前状态：**已支持 `docker compose up -d` 一键全栈部署**（自动建表+幂等种子+健康检查；容器内真实 LLM/真实仓库全链路已验证）。`pnpm verify:retrieval` 12 项全绿（记忆检索优化 v2β：BM25-lite+可选向量）。`pnpm smoke` 53 项断言全绿（真实 LLM 引擎，含 FR-D18 批次模型覆盖）；`pnpm verify:github` 13 项（真实 GitHub 集成）；`pnpm verify:suspend` 11 项（挂起路径）；`pnpm verify:sandbox` 13 项（沙箱容器+网络白名单）——全部通过。**

## 快速开始

> CI：GitHub Actions（push/PR 触发）—— typecheck + 完整 e2e smoke（Postgres service 容器）。Docker：`docker compose up -d postgres app`（应用镜像多阶段构建，数据库走 compose 服务）。

```bash
# 0. 依赖：Node ≥ 22、Docker（跑 Postgres）、pnpm
pnpm install

# 1. 启动数据库（Postgres 16，docker compose）
pnpm db:up

# 2. 建表（drizzle push）
pnpm db:push

# 3. 种子数据（演示账号 + 两个项目 + 覆盖全部路径的需求队列）
pnpm seed

# 4. 启动应用（调度器随 instrumentation 自动启动）
pnpm dev          # http://localhost:3000

# 5. 端到端验收（发布检查单 §6 的 26 项断言）
pnpm smoke
```

演示账号：`thomas@broccoli.dev` / `broccoli123`（登录页有「一键体验」按钮）。

**沙箱模式**：`.env` 配置 `BROCCOLI_SANDBOX=docker` 后，每队列一个非特权容器（只读根、tmpfs /tmp、512MB/1CPU/PIDs 128、cap-drop ALL、no-new-privileges；随队列复用、空闲/终态回收），容器挂 internal 网络、唯一出口为白名单 egress proxy（分阶段规则：prepare=依赖 registry，execute=Anthropic/GitHub 域；判定写审计日志）。专项验证：`pnpm verify:sandbox`（基建 8 项 + 集成 5 项，全部通过）。剩余风险：进程绕过 proxy env 的直连由 internal 网络收敛、v2 透明拦截（见 design §12）。

**真实 LLM 模式**：`.env` 中 `BROCCOLI_ENGINE=claude` + `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`（已验证：本地 AI router 代理 GLM）。规划与验收由真实模型产出；模型输出异常自动降级模板逻辑保证流水线韧性；验收采用机械护栏判定（校验类标准对照源码核验、行为类标准以测试证据支撑）防 LLM 判定波动。

## 演示数据覆盖的场景

| 项目 | 需求 | 演示路径 |
|---|---|---|
| acme/api-gateway（失败暂停） | ① 修复登录重定向 | 常规六阶段流水线：规划 → 开发∥测试 → 测试执行 → 验收 → 交付 |
| | ② 会话持久化存储 | **规划抛出数据库选型结构化提问** → 快照挂起 + 邮件 → 回答后恢复 |
| | ③ 通知模块事件化 | 常规 + 前序记忆/提案注入 |
| | ④ 订单分页筛选 `[repair]` | **验收对照发现缺口 → 自动回溯修复一轮（FR-D14）→ 重验通过** |
| | ⑤ 订单单元测试 | 堆叠链第 5 节点 |
| thomas/portfolio-site（失败自动跳过） | ② 深色模式 `[fail-tests]` | **测试失败 → 自动跳过 → 队列继续 + base 回退（FR-D6）** |

所有阶段的文件操作、git 分支/提交/堆叠、`node --test` 测试执行均为**真实执行**（本地裸仓模拟 GitHub origin，PR 落库、diff 真实生成）。

## 架构与实现对照

按 [design](design.md) 实现，以下为 **dev 模式简化**（接口缝隙已保留，生产替换即可）：

| design 文档 | 实现 | 生产切换点 |
|---|---|---|
| Postgres 16（唯一事实源） | ✅ docker compose + Drizzle（全部 19+ 张表） | — |
| Redis + BullMQ 队列 | 进程内调度器（DB 轮询 + 原子认领，§6 幂等设计） | 接 BullMQ worker |
| 调度器独立进程 | `src/instrumentation.ts` 内启动（单例 + globalThis 守卫） | 拆独立进程 |
| 沙箱容器（Docker） | 本地工作区（`.data/repos/<id>/work`）+ 真实进程 | 实现 `ContainerProvider` 第二实现 |
| Anthropic 兼容 LLM（Claude/GLM 等） | `ExecutionEngine` 抽象：`MockEngine`（离线演示）+ `ClaudeEngine`（Messages 兼容协议，`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`/`ANTHROPIC_AUTH_TOKEN` 可指向官方或本地 router）。**已用 GLM（glm:glm-5.3）经本地 router 完成端到端验收（smoke 50/50 全绿）**；规划/验收由真实模型产出（JSON 容错重试 + 输出不合规自动降级模板），验收判定为机械护栏（校验类标准对照源码核验，触发 FR-D14 回溯） | 容器内换 Claude Code Agent SDK（permission 回调、session resume） |
| GitHub（真实集成） | `originKind=github`：真实 clone/push（extraheader 注入 token，HTTP/1.1 防挂起）+ REST 开 PR/合并/关闭/Issues 同步。**已用真实仓库 AlpherJang/broccoli-demo 完成 13/13 端到端验证（pnpm verify:github）**；OAuth 登录流程待用户注册 OAuth App，当前为 PAT 模式 | OAuth App 登录流程 |
| 邮件（Resend/SMTP） | OutboxMailer 落盘 `.data/outbox/*.eml` | 换 Resend 适配器 |
| GitHub Issues | 真实 REST 同步（github origin：拉取 open issues 镜像、PR 开出后真实关闭回写）；本地模式为模拟落库 | — |
| OAuth | 本地账号体系（scrypt + HMAC 会话） | GitHub OAuth 接入 |

## 关键实现位置

| 能力 | 文件 |
|---|---|
| 数据模型（design §3 全表） | `src/db/schema.ts` |
| 任务状态机 + 阶段状态机（§4/§4.1） | `src/lib/pipeline/orchestrator.ts` |
| 调度器（并发 2 / 项目串行 / 失败策略 / 快照过期） | `src/lib/pipeline/scheduler.ts` |
| 执行引擎抽象 + Mock/Claude | `src/lib/engine/*` |
| 本地 git 层（堆叠分支/PR diff） | `src/lib/git.ts` |
| 分阶段模型配置（FR-D17） | `src/lib/models.ts` |
| 记忆注入与依赖追溯（FR-G3/G6） | `orchestrator.ts` + `api/projects/[id]/memories` |
| 关键邮件通知（FR-E4） | `src/lib/notify.ts` |
| 凭证加密（FR-H1） | `src/lib/crypto.ts`（AES-256-GCM + scrypt） |
| 执行画布 UI（FR-D16） | `src/app/runs/[id]/page.tsx`（SSE 日志 + 节点检查器） |
| API（design §11） | `src/app/api/**` |

## 环境变量

见 `.env`（已带开发默认值）：`DATABASE_URL` / `SESSION_SECRET` / `BROCCOLI_MASTER_KEY`（凭证加密主密钥）/ `BROCCOLI_MAX_CONCURRENCY=2` / `BROCCOLI_SNAPSHOT_TTL_HOURS=24` / `BROCCOLI_MAX_REPAIR_ROUNDS=1` / `BROCCOLI_ENGINE=mock|claude`。

## 已知边界

- 快照为元数据级（会话引用 + 分支/状态），恢复基于阶段状态机的重入而非字节级 workspace patch（生产由 SDK session resume + 对象存储 patch 承担）。
- 并行支线共享容器：测试线限定写 `tests/` 目录；写冲突降级串行的检测在 Mock 引擎中通过提交隔离（`git add src/` / `git add tests/`）规避。
- `等待确认` 超时挂起（24h）已实现（`suspendExpired`），演示可调小 `BROCCOLI_SNAPSHOT_TTL_HOURS` 验证。
