# Broccoli 技术设计文档

> 对应需求见 [requirements.md](requirements.md)（FR/NFR 编号在文中引用）。选型为**建议默认**，标注备选；均可替换而不影响领域模型。

## 1. 架构总览

```
                         ┌──────────────────────────────────────────────┐
                         │                   云端（单区域 MVP）           │
  ┌──────────┐  HTTPS    │  ┌─────────────┐      ┌──────────────────┐   │
  │ 浏览器    │ ─────────▶│  │  Web/API    │      │  Scheduler       │   │
  │ (Next.js) │◀─SSE 日志─│  │  (Next.js)  │◀────▶│  (独立进程)        │   │
  └──────────┘           │  └──────┬──────┘ Redis └───────┬──────────┘   │
                         │         │ 队列/事件             │ 容器租约/调度  │
                         │  ┌──────▼──────┐      ┌─────────▼──────────┐ │
                         │  │ PostgreSQL  │      │  Executor Runner    │ │
                         │  │ (状态事实源) │      │  (SDK 驱动/容器管理)  │ │
                         │  └─────────────┘      └───────┬────────────┘ │
                         │  ┌─────────────┐      ┌───────▼────────────┐ │
                         │  │   Redis     │      │  沙箱容器池          │ │
                         │  │ (BullMQ/缓存)│      │  [容器A][容器B]...   │ │
                         │  └─────────────┘      └───────┬────────────┘ │
                         │  ┌─────────────┐              │ 唯一出口       │
                         │  │ Mailer      │      ┌───────▼────────────┐ │
                         │  └─────────────┘      │  Egress Proxy       │ │
                         └──────────────────────│  (白名单: Anthropic/  │ │ ──▶ api.anthropic.com
                                                │  GitHub/registry*)   │ │ ──▶ api.github.com / github.com
                                                └────────────────────┘ │ ──▶ 依赖 registry（仅准备期*）
                                                 对象存储(快照 patch)    │
```

组件职责：

| 组件 | 职责 | 对应需求 |
|---|---|---|
| Web/API | 认证、项目/队列/任务/记忆的 CRUD 与页面、SSE 日志推送 | FR-A/B/C/E/G |
| Scheduler | 并发槽位控制、项目内串行互斥、base 计算、失败/挂起策略执行、状态机流转触发 | FR-D |
| Executor Runner | 容器生命周期、环境准备、驱动 Agent SDK、快照保存/恢复、push 分支开 PR、日志转发 | FR-D/F |
| 沙箱容器 | 运行 Agent SDK 与用户代码；每项目队列一个容器，复用 | FR-D/H3 |
| Egress Proxy | 容器唯一网络出口，分阶段白名单 | FR-H2/NFR-1 |
| Mailer | 关键邮件（等待确认/失败），一次性直达链接 | FR-E4 |

**关键设计原则**：PostgreSQL 是唯一事实源（服务重启可重建一切）；Redis 只做队列/缓存/日志缓冲；容器无状态可随时销毁（可恢复状态 = DB + 对象存储快照）。

## 2. 技术选型

| 领域 | 默认选型 | 理由 | 备选 |
|---|---|---|---|
| 语言/运行时 | TypeScript / Node.js 22 | 全栈统一；Claude Code Agent SDK 原生 TS | — |
| Web 框架 | Next.js（App Router） | 前后端一体，SSE 支持好 | Remix |
| UI | Tailwind + shadcn/ui | 快速搭建仪表盘类界面 | — |
| API | Next.js Route Handlers（REST） | 简单直接，SSE 同源 | tRPC |
| 数据库 | PostgreSQL 16 + Drizzle ORM | 状态机/队列查询能力强 | Prisma |
| 队列/锁/缓冲 | Redis 7 + BullMQ | 延迟任务（快照过期）、分布式锁、pub/sub 日志 | — |
| 沙箱 | Docker 容器（非特权：只读根/tmpfs/CPU/内存/PIDs/cap-drop ALL；队列复用；internal 网络 + 白名单 egress proxy）。`BROCCOLI_SANDBOX=docker` 启用，**已验证 13/13**（pnpm verify:sandbox）；默认 local 宿主模式（开发/CI） | v2: gVisor/Firecracker + Linux iptables 透明拦截 |
| Agent 引擎 | Claude Code Agent SDK（`@anthropic-ai/claude-agent-sdk`） | 官方 SDK：会话恢复、permission 回调、流式输出 | 抽象层 `EngineAdapter` 可替换 |
| 对象存储 | S3 / R2（快照 patch、日志归档） | 便宜、生命周期策略清理过期快照 | — |
| 邮件 | Resend | Transactional 邮件最简接入 | SES |
| 密钥加密 | AES-256-GCM + 主密钥（env，计划迁 KMS） | MVP 简单；KMS 化是渐进路径 | AWS KMS |
| 部署 | 单区域：Web/调度器/Runner 同 VPC，VM 池跑 Docker | MVP 成本最低 | k8s（规模化后） |

## 3. 领域模型

```
User 1─N Project 1─N RequirementBatch 1─N Requirement 1─N TaskRun
 │                                        │                 │
 │                                        │                 ├─1─N TaskStage（规划/开发∥测试用例/测试执行/验收/交付）─1─N─ StageArtifact
 │                                        │                 ├─1─N SubTask · AcceptanceCriterion
 │                                        │                 ├─1─1 SessionSnapshot（等待确认时）
 │                                        │                 └─N─ MemoryInjection
 │                                        │                        │ N
 └─1─1 Credential(anthropic/github)       └─ 队列位次 seq          ▼
                                                            MemoryProposal ──确认──▶ MemoryItem
Project ──1─N── ContainerLease（容器租约：随队列复用）
TaskRun ──N── UsageRecord / NotificationEvent / AuditLog
```

核心表（关键字段）：

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | email, password_hash | FR-A1 |
| `credentials` | user_id, provider(anthropic/github), ciphertext, nonce, last_verified_at | FR-A2/A3、FR-H1 |
| `projects` | user_id, repo_full_name, default_branch, **last_success_branch**, failure_policy(默认值), settings_json, status | last_success_branch 是堆叠 base 回退的依据 |
| `requirement_batches` | project_id, failure_policy(pause/skip_continue) | 提交批次快照策略（FR-C3） |
| `requirements` | project_id, batch_id, seq(队列位次), title, description, status(queued/active/done/failed/skipped/suspended/cancelled) | 用户视角的状态由最新 run 汇总 |
| `task_runs` | requirement_id, attempt_no, **state**, branch, base_branch, sdk_session_id, error, started_at, ended_at | state 即 §4 状态机 |
| `container_leases` | project_id, user_id, state(preparing/active/released), reason, started_at, released_at | 容器生命周期审计（FR-H3） |
| `session_snapshots` | task_run_id, sdk_session_id, patch_object_key, base_branch, created_at, expires_at, status(active/consumed/expired) | FR-D5 |
| `memory_proposals` | project_id, source_run_id, type(convention/decision/lesson/fact), content, status(pending/confirmed/rejected), decided_at | FR-G2/G3/G4 |
| `memory_items` | project_id, type, content, status(confirmed/disabled), source_proposal_id, version | FR-G1/G5 |
| `memory_injections` | proposal_id **或** item_id, target_run_id, injected_at | 依赖追溯（FR-G6） |
| `notification_events` | user_id, type(wait_confirm/failed/…), task_run_id, dedupe_key, status | FR-E4 去重 |
| `usage_records` | user_id, run_id, input_tokens, output_tokens, container_seconds | FR-H4 |
| `audit_logs` | actor, action, target, detail_json, created_at | NFR-1 |
| `task_stages` | task_run_id, type(planning/dev/test_design/test_run/acceptance/delivery), seq, state, model_key, model_source(recommended/custom), summary, started_at, ended_at | 阶段流水线（FR-D10/D17） |
| `subtasks` | task_run_id, seq, title, state, owner_stage_id | 规划拆解的具体执行单元（FR-D12） |
| `acceptance_criteria` | task_run_id, seq, content, verify_stage, status(defined/achieved/unverified/failed), evidence_json, achieved_by_stage_id | 验收标准与证据（FR-D13/D14） |
| `stage_artifacts` | stage_id, name, kind(plan/diff/testcase/report/pr), storage_key, meta | 阶段产物登记（画布展示） |
| `stage_model_configs` | project_id, stage_type, model_key, source(default/custom), updated_at | 分阶段模型配置（FR-D17/D18） |

## 4. 任务状态机（TaskRun.state）

| 当前态 | 事件 | 下一态 | 副作用 |
|---|---|---|---|
| — | 调度器选中（并发槽位 + 项目锁可用） | `环境准备` | 创建/复用容器租约；clone（如新建）+ 依赖安装 |
| `环境准备` | 环境就绪 | `执行中` | 组装上下文（记忆注入，记录 injections）；启动 SDK 会话 |
| `执行中` | agent 抛出确认问题 | `等待确认` | **立即**：保存会话快照 → 释放容器 → 发关键邮件 → 释放并发槽位 |
| `等待确认` | 用户作答（快照有效） | `执行中` | 重新拉起容器 → 恢复环境 + resume 会话 → 注入答案 |
| `等待确认` | 快照过期（默认 24h，可配置） | `已挂起`（终态） | 邮件通知；需求标记 suspended；**队列继续**（base 回退）；清理快照对象 |
| `执行中` | agent 正常完成 | `完成`（终态） | push 分支 + 开 PR；更新 `projects.last_success_branch`；触发记忆提案生成；释放容器（队列空闲时） |
| `执行中`/`环境准备` | 执行失败 / 超时 | `失败`（终态） | 记录 error；**按策略**：默认暂停队列 + 邮件；skip_continue 则 base 回退后继续；触发教训类提案生成 |
| 任意非终态 | 用户取消 | `已取消`（终态） | 终止容器内进程；释放容器 |

**base 计算规则**：新 run 的 `base_branch` = 项目 `last_success_branch`（若无则 `default_branch`）。跳过/挂起不更新该指针 → 天然实现回退。

**项目级互斥**：`projects` 行级锁 / Redis 锁保证同项目同时至多一个 active run；**用户级并发**：统计 `state IN (环境准备,执行中)` 的容器租约数 < 2（串行等待的容器已释放、不占槽；并行等待期间容器保留、槽位照计——见阶段状态机）。

### 4.1 阶段状态机（TaskStage.state，FR-D10）

顶层 TaskRun 状态保持上表不变，「执行中」语义细化为「存在执行中阶段」；`current_stage` 指针随流水线推进。阶段状态全集：`排队中 → 执行中 → 等待确认 → 完成 / 失败 / 已跳过`。

| 流水线规则 | 说明 |
|---|---|
| 默认编排 | 规划 → (开发 ∥ 测试用例) → 测试执行 → 验收对照 → 交付；项目可关闭并行（串行：开发 → 测试用例） |
| 规划产物 | 子任务清单、实现计划文档、验收标准清单；不修改代码文件；未决选型抛结构化确认 |
| 汇合 | 并行支线全部进入终态（完成 / 已跳过）后，测试执行启动 |
| 阶段失败 | 任一阶段失败 → TaskRun 失败，走 FR-D6 失败策略；已完成阶段的产物保留 |
| 阶段确认 | 规划（选型）/ 开发（决策点）/ 验收（修复轮次用尽）抛结构化提问 → 阶段「等待确认」 |
| 等待与容器 | 串行等待：立即快照释放容器；**并行等待**：另一支线仍执行中 → 容器保留（槽位照计），全部支线终态且无后续可启动阶段时才快照释放 |
| 验收回路 | 验收对照发现未达成项 → 自动携带差距上下文回到开发修复一轮 → 重跑受影响的测试执行 / 验收对照（默认 1 轮，可配置）；用尽后转「等待确认」 |
| 交付门禁 | 全部验收标准「已达成」（或用户降级确认）才进入交付阶段 |
| 模型选择 | 阶段启动时按 `stage_model_configs` 解析：自定义 > 推荐（静态映射 + 记忆偏好）；结果落 `task_stages.model_key / model_source` |

## 5. 核心流程时序

### 5.1 需求提交与调度

```
浏览器           API            Scheduler         Runner            沙箱
  │ POST /requirements(批次+策略) │                 │                 │
  │──────────────▶│ 入库(requirements/batch)        │                 │
  │               │ ── 触发调度事件 ─▶│              │                 │
  │               │                 │ 检查:用户槽位<2? 项目锁空闲?     │
  │               │                 │── acquire ────▶ │ 创建/复用容器    │
  │               │                 │                │ ──clone+install▶│(准备期白名单)
  │               │                 │                │ 状态:执行中      │
```

### 5.2 执行 → 等待确认 → 恢复

```
Runner                沙箱(SDK)                对象存储        Mailer      浏览器
  │ ──stream 日志──▶ │                          │              │            │◀─SSE
  │ ◀─ canUseTool/ask_user 回调(结构化问题) ─────│              │            │
  │ ①保存快照: session_id + workspace patch ────▶│              │            │
  │ ②销毁容器(释放槽位)                          │              │            │
  │ ③notification(wait_confirm) ───────────────────────────────▶│──邮件(链接)─▶│
  │                                              │              │            │
  │ ◀──── 用户经一次性链接作答(POST /runs/:id/confirm) ────────────────────────│
  │ ④重新拉起容器→clone base→apply patch→resume(session_id)      │            │
  │ ⑤注入答案→继续执行                            │              │            │
```

### 5.3 完成与堆叠 PR

```
Runner                     沙箱                    GitHub
  │ ◀─ agent 声明完成(分支上有提交) ─│                │
  │ 校验: git status 干净 / (P1: 跑测试)            │
  │ 持细粒度 token push 分支 broccoli/N-slug ─────────▶│
  │ base = last_success_branch(N-1 的分支) 开 PR ─────▶│
  │ 更新 projects.last_success_branch; run=完成       │
  │ 触发记忆提案生成(§9); 队列空闲→释放容器           │
```

**注意**：git push 与开 PR 由 **Runner 侧执行**，agent 容器内不持有 GitHub token（见 §12）。

### 5.4 失败与策略

```
Runner → run.state=失败, 记录 error, 触发提案生成(教训类)
   ├─ 项目策略=pause(默认): 队列暂停 + 邮件
   │     └─ 用户选择: [重试](新 run, 同 base) / [跳过](需求标记 skipped,
   │        后续 run 的 base 仍为 last_success_branch → 回退) / [终止](余下转已取消)
   └─ 项目策略=skip_continue: 自动跳过 + 邮件说明, 队列继续
```

### 5.5 记忆链路

```
任务 N 终态 ─▶ 提案生成(LLM 小调用, 用户 key)
   ├─ proposals(status=pending) ──立即──▶ 注入任务 N+1 上下文 + injections 落库
   └─ 待用户确认(批量 UI) ──confirmed──▶ memory_items(永久注入未来所有任务)
用户否决提案 P ─▶ 查 injections(P) + 同队列位于其后任务 ─▶ 展示受影响任务 + [重新入队] 入口
```

### 5.6 阶段流水线（并行测试线 + 验收回路，FR-D10–D16）

```
调度器/Runner            规划会话           开发会话          测试用例会话       测试执行/验收/交付
  │ run 启动 → 创建 6 个阶段实例(排队中) + 解析各阶段模型        │
  │ ▶ 规划：记忆+提案注入 → 子任务/实现计划/验收标准/选型提问      │
  │      └─ 选型提问 → 阶段等待确认（单会话：立即快照释放容器）     │
  │ ▶ 并行：开发(自定义模型) ∥ 测试用例(sonnet) 两条独立会话       │
  │      测试线只写测试目录；任一支线等待不阻塞另一支线            │
  │ ▶ 汇合(两支线终态) → 测试执行(haiku)：沙箱全量测试 + 报告      │
  │ ▶ 验收对照：逐条核对标准 + 证据 → 未达成 → 回开发修复(≤1轮)    │
  │      └─ 修复轮次用尽 → 等待确认（用户决策）                   │
  │ ▶ 全部达成 → 交付：push 分支 + 堆叠 PR + 记忆提案生成         │
```
```

## 6. 调度器设计

- **触发点**（事件驱动，全部落 Redis Stream，调度器消费）：需求入队 / run 终态 / 用户作答 / 快照过期（BullMQ delayed job）/ 容器回收。
- **调度算法**：公平轮转——按「项目最早待执行需求的时间」排序，逐个尝试满足 `(用户槽位 < 2) && (项目无 active run)`；不满足则保持排队。
- **幂等与恢复**：调度器无内存状态，重启后扫描 DB（`requirements.status=queued` + 租约表）重建；所有状态迁移以 DB 事务 + 乐观锁（`task_runs.state` 条件更新）保证不双跑。
- **快照过期**：BullMQ delayed job 在 `expires_at` 检查快照未被消费 → 状态机转「已挂起」（§4）。

## 7. 沙箱与执行环境

### 7.1 容器生命周期

```
创建(队列激活: 首个需求开始)
  → 环境准备: clone(细粒度 token 最短注入) + 依赖安装(缓存卷)   [网络: 准备期白名单]
  → 任务序列执行(串行复用同一容器; 不销毁)                      [网络: 执行期白名单(更紧)]
  → 释放: 队列空闲 | 进入等待确认 | 项目删除/用户取消              → 容器销毁
```

- **镜像分层**：公共 base（node/python 常用栈）→ 项目层（clone + 依赖缓存卷，按 project 复用，队列再激活时可跳过安装）。
- **并行支线（FR-D15）**：开发 ∥ 测试用例共享同一容器、各自独立 agent 会话；规划约束测试线仅写测试目录以规避写冲突，检测到越界 / 冲突写入即降级两支线串行。并行等待期间容器保留（见 §4.1）。
- **资源限额**：CPU/内存上限、任务最长执行时长（可配置，默认 4h）、磁盘配额。

### 7.2 分阶段网络白名单（Egress Proxy）

| 阶段 | 允许端点 | 说明 |
|---|---|---|
| 环境准备 | + npm/pypi 等依赖 registry | 仅此阶段放行 registry；残余风险（registry 可被用作 exfil 通道）记录于 §12，v2 以私有镜像/proxy 缓存收敛 |
| 执行 | api.anthropic.com:443、api.github.com:443（只读 API） | 默认 DENY 其他一切出口；违规访问记录 audit_logs |

### 7.3 快照与恢复（FR-D5）

快照三元组：`{ sdk_session_id, workspace patch(base..工作区, 含未提交与本地提交), base_branch }`，patch 存对象存储。

恢复流程：新建容器 → clone base → 应用 patch → SDK resume(session_id) → 注入用户答案。依赖缓存卷使恢复目标 ≤ 1 分钟（AC-D4/AC-D5）。恢复失败（resume 报错/patch 冲突）→ 降级：任务标记失败走失败策略 + 邮件说明，不阻塞队列。

### 7.4 日志与实时输出

SDK 流式消息 → Runner → Redis pub/sub（按 run_id 频道）→ API SSE → 浏览器；同时异步落对象存储（回看全量日志，保留 30 天，NFR-4）。日志中对凭证模式做脱敏。

## 8. Agent 编排与介入协议（FR-D4）

- **上下文组装顺序**（单次 run 启动时）：
  1. 平台系统指令（角色、边界、完成定义、禁止事项）
  2. 项目已确认记忆（`memory_items`，全量注入，MVP）
  3. 前序任务的 pending 提案（同队列，提案即注入——FR-G3）
  4. 本需求描述 + 队列位置说明（前序变更已在本工作区）
  5. 仓库约定文件（CLAUDE.md 等）由 agent 自行读取；P1 平台协同去重
  每次注入写入 `memory_injections`（依赖追溯）。
- **阶段化执行（FR-D10–D18）**：每个阶段以独立 SDK 会话运行，上下文按阶段裁剪——规划：记忆 + 提案 + 需求原文；开发 / 测试用例：实现计划 + 子任务 + 验收标准 + 前序阶段产物摘要；验收对照：标准清单 + 证据索引。阶段模型按 `stage_model_configs` 解析（自定义 > 推荐）；§8 的结构化提问协议复用于阶段级「等待确认」。
- **结构化提问**：SDK 的 permission/提问回调映射为 `{question, options[], allow_free_text}`；M1 最小版为自由文本提问 + 挂起/恢复（无预设选项）。
- **完成判定**：agent 声明完成 → Runner 校验（工作区干净、分支有变更）→ push + PR；校验不过回传 agent 继续或转失败。

## 9. 记忆系统（FR-G）

- **提案生成**：run 终态后，用**用户自己的 key** 发起一次小上下文 LLM 调用（输入：需求 + 执行摘要 + diff 统计 + 确认问答），输出 0–N 条 `{type, content}`；prompt 约束「只提取对未来任务有用的：规范 / 决策及理由 / 教训」。
- **注入预算**：MVP 全量注入；条目数或 token 超阈值时告警（为 P2 检索优化预留信号）。
- **追溯查询**：否决提案 P 时，受影响任务 = `injections(P)` ∪ 同队列中 P 注入点之后的任务（简化闭包，按 seq 展开）；仅展示 + 提供重新入队，不自动级联（AC-G6）。

## 10. 通知（FR-E4/E5）

| 事件 | 渠道 | 优先级 | 模板要点 | 去重键 |
|---|---|---|---|---|
| 进入等待确认 | 邮件 | **P0** | 项目/需求名、问题摘要、预设选项、一次性链接直达作答页 | run_id+state |
| 任务失败 | 邮件 | **P0** | 项目/需求名、错误摘要、策略说明、行动链接（重试/跳过/终止） | run_id+state |
| 快照挂起 | 邮件 | P0（随 D5） | 说明可重新入队 | run_id+state |
| 任务完成 | 邮件+站内 | P1 | PR 链接、变更摘要 | run_id+state |

一次性链接：随机 token（15 分钟有效）→ 免登录直达任务作答/操作页，作废于首次使用。

## 11. API 设计（REST + SSE）

| 方法与路径 | 说明 | 对应 |
|---|---|---|
| POST /api/auth/register · login · logout · forgot-password | 账号 | FR-A1 |
| GET /api/auth/github/start · callback | GitHub OAuth | FR-A3 |
| GET/PUT/DELETE /api/credentials/anthropic · POST …/test | key 管理+连通性 | FR-A2 |
| GET/POST /api/projects · GET/PATCH/DELETE /api/projects/:id | 项目 CRUD | FR-B* |
| POST /api/projects/:id/requirements（批次+策略）· PATCH/DELETE /api/requirements/:id · POST /api/projects/:id/requirements/reorder | 队列 | FR-C* |
| GET /api/dashboard | 全局仪表盘聚合 | FR-E1/E2 |
| GET /api/runs/:id · /diff · **GET /api/runs/:id/stream (SSE)** | 任务详情/日志 | FR-D7/D8、E3 |
| POST /api/runs/:id/confirm · cancel · retry · skip · terminate | 确认作答/失败处置/取消 | FR-D4/D6 |
| GET /api/projects/:id/memories · POST /api/proposals/:id/confirm · reject · POST /api/memories/batch-confirm · PATCH/DELETE /api/memories/:id | 记忆 | FR-G* |
| GET /api/deep-link/:token | 邮件一次性链接解析 | FR-E4 |
| GET /api/runs/:id/canvas | 执行画布聚合（阶段 / 子任务 / 验收标准 / 产物） | FR-D16 |
| GET /api/stages/:id · POST /api/stages/:id/retry · /skip | 阶段详情与处置 | FR-D10/D14 |
| GET/PUT /api/projects/:id/stage-configs · POST …/reset | 阶段模型配置与恢复推荐 | FR-D17 |
| GET /api/runs/:id/criteria · PATCH /api/criteria/:id | 验收标准查询与人工复核 | FR-D13/D14 |
| GET /api/usage | 用量 | FR-H4 |

统一约定：错误码 `{code, message}`；列表分页；写操作幂等键（`Idempotency-Key`）。

## 12. 安全设计（NFR-1 / requirements §5）

**凭证分布原则：能不进容器的凭证不进容器。**

| 凭证 | 位置 | 说明 |
|---|---|---|
| Anthropic key | 容器 env（仅此不可避免，SDK 在容器内） | 不落盘；日志脱敏；熔断限额度 |
| GitHub token | **仅 Runner 侧**（clone/push 窗口内以最短生命周期注入容器，用后即撤） | agent 进程不持有；细粒度 token 限定单 repo |
| 项目 secrets | 仅环境准备期注入 env；不进入 agent 可读文件/上下文 | — |
| 平台凭证 | DB 加密（AES-256-GCM），KEK 独立于 DB | — |

**沙箱加固**：非特权容器、只读根文件系统（可写层仅工作区与缓存卷）、seccomp 默认 profile、容器间网络隔离（internal bridge，唯一出口为 Egress Proxy）、按 run 的 audit_logs。

**残余风险（明确接受并跟踪）**：① 准备期 registry 通道可被滥用为 exfil 途径 → v2 收敛为私有镜像/缓存代理；② Docker 隔离强度弱于 microVM → v2 gVisor/Firecracker；③ prompt injection 诱导 agent 破坏仓库 → 堆叠 PR + review 门槛兜底，破坏面限于沙箱与分支。

## 13. 可观测性与成本控制

- **指标**：并发槽位使用率、容器分钟数（按项目/用户）、任务失败率（环境类 vs agent 类）、快照恢复成功率、邮件送达率、日志 SSE 延迟（对应 §NFR-2/3）。
- **告警**：空闲容器 > 0（P0 违约）、快照存储总量、失败率突增、邮件发送失败。
- **成本看板**：容器小时、快照 GB、LLM token（用户视角展示 = FR-H4；平台视角核算单位经济）。

## 14. 里程碑与技术交付映射

| 里程碑 | 技术交付（本文章节） |
|---|---|
| M1 单任务闭环 | §1 骨架（Web/API + Runner + 单容器）、§2、§7.1/7.2/7.4、§8（最小确认问答）、§11 认证/项目/运行端点、§12 基础加固 |
| M2 队列与调度 | §4 状态机全量 + §4.1 阶段状态机、§5.1/5.2/5.4/5.6 流水线、§3 新表（task_stages/subtasks/acceptance_criteria/stage_artifacts/stage_model_configs）、§6 调度器、§7.3 快照、§10 P0 邮件、§11 仪表盘/确认/失败处置/canvas/stage-config 端点 |
| M3 记忆 | §3 记忆三表 + injections、§5.5、§8 上下文组装、§9、§11 记忆端点 |
| M4 体验补全 | §10 P1 通知、Issues 同步、§7 测试执行、PR 界面合并、堆叠链修复（base 重算 + 批量重跑）、§9 CLAUDE.md 协同 |
