# 技术栈决策：应用自托管到 k3s，使用官方 OpenAI Codex

调研日期：2026-09-30。本文区分架构建议、本地实现和已验证能力；不代表已部署集群、启动模型服务或验证跨主机恢复。具体实现边界见 [implementation-contract.md](./implementation-contract.md)。

## 结论与约束

最新要求是：**应用、队列、数据库、对象存储和执行环境可以自行部署到一个 k3s 集群；模型推理允许外部服务，优先使用用户的 Codex，并且不基于 Claude Agent SDK**。默认基础设施路径不依赖 Trigger Cloud、Supabase Cloud 或托管沙箱，也不能把云端专有 checkpoint 当成自托管能力。Codex 接入和账号/计费边界见 [codex-integration.md](./codex-integration.md)。

推荐最小组合：

- TypeScript + Zod：领域核心、CLI/API 和适配接口
- PostgreSQL + pg-boss：领域事实与持久化阶段任务；不再加 Redis 或独立队列服务
- S3-compatible 产物接口：SeaweedFS 为自托管候选，小规模可采用单进程部署
- 官方 TypeScript Codex SDK：复用 Codex harness；账号认证与 API key 模式显式区分。OpenAI-compatible 本地端点仅保留为可替换接口，不要求先部署模型
- 不可信代码执行：后续采用 Kubernetes Job + 经验证的隔离 runtime，例如 gVisor；当前离线 demo 不执行任意仓库代码
- PGlite + 显式 fixture：本地离线验证，不要求先搭 k3s、模型或数据库服务

这是**阶段任务可重试**的最小方案。若业务确实需要任意长流程的持久化等待、细粒度执行恢复和复杂补偿，再升级到自托管 Temporal + TypeScript worker；不在第一版自行复制 workflow engine。

本项目优先控制基础设施数量、稳定性、权限和磁盘容量。采用自托管方案时，应复用成熟组件，并明确回收、失败恢复和权限责任。

## 默认组件与真实边界

| 层 | 选择 | 为什么选 | 不承诺什么 |
| --- | --- | --- | --- |
| 领域核心 | TypeScript + Zod | 一套语言描述案例、规则、裁决、证据和版本；schema 可复用 | 不把模型输出自动视作事实或人工标签 |
| 任务执行 | pg-boss 嵌入 Node worker | PostgreSQL 支撑事务入队、任务重试、延期、DLQ、并发控制；无需额外 broker | 不保存任意进程内存或自动恢复 agent 中间轮次 |
| 数据库 | 标准 PostgreSQL；生产推荐 CloudNativePG | 业务事实和队列共用 PostgreSQL，分 schema/role；复用运维组件 | 单实例不是 HA；operator 不能代替可用磁盘和可恢复备份 |
| 产物 | S3 API + SeaweedFS 候选 | 可自行部署，避免将大日志和 patch 存进数据库；支持小规模起步 | 单进程、单磁盘不是跨节点容灾；S3 兼容操作需要集成测试 |
| Codex 执行与裁决 | 官方 `@openai/codex-sdk` | 复用用户指定的 Codex、独立 thread、结构化结果和工具权限 | 应用自托管不等于模型本地运行；账号/额度和目标环境认证需要单独核验 |
| 可替换模型接口 | OpenAI-compatible endpoint | 后续可接 API 或本地 vLLM，不把本地 GPU 部署当作前置条件 | 不因默认 Codex 不可用就自动切换模型或计费方式 |
| 代码执行 | 隔离 Kubernetes Job；gVisor 为候选 | 复用 Kubernetes 生命周期与成熟隔离 runtime，避免搭自有沙箱控制平台 | 普通 Pod、worktree 或 namespace 不能独自构成足够的安全边界 |
| 本地开发 | PGlite、真实 AST scanner、Vitest、fixture 裁决 | 无账户运行，先验证领域流程和确定性检测 | 离线结果不证明集群恢复、真实 LLM 精度或生产权限配置 |

能力依据：[pg-boss](https://pgboss.io/)、[CloudNativePG 备份](https://cloudnative-pg.io/docs/1.28/backup/)、[SeaweedFS](https://github.com/seaweedfs/seaweedfs)、[vLLM 服务端](https://docs.vllm.ai/en/latest/serving/online_serving/)、[vLLM 结构化输出](https://docs.vllm.ai/en/latest/features/structured_outputs/)、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[gVisor/containerd](https://gvisor.dev/docs/user_guide/containerd/quick_start/)。

## 为什么当前优先 pg-boss

FlyReWheel 第一版的工作可拆成有限阶段：提取案例、生成候选、运行检测、语义裁决、保存回放结果、等待人工审核。阶段输入绑定 commit 与规则版本，阶段输出可独立保存；人工等待表现为业务记录，不需要让某个进程一直存活。

pg-boss 已有事务入队、退避重试、任务延期、优先级、DLQ 和依赖任务，适合在已有 PostgreSQL 上减少基础设施。业务状态与下一个任务可在同一短事务提交，避免“结果保存成功但任务没有入队”。不要在数据库事务里等待模型或运行测试。[事务适配](https://pgboss.io/api/adapters)、[任务与依赖](https://pgboss.io/api/jobs)

采用以下恢复契约：

1. 每个阶段有稳定领域身份与 payload digest；先检查是否已有有效结果
2. 模型或外部作业执行完成后，短事务保存结果、执行版本检查并投递后续阶段
3. worker 崩溃后，任务按队列配置重试；当前阶段可能重新执行
4. 阶段内的 agent session、远端作业或文件状态不会凭空恢复，必须保存引用并显式核验
5. 如果某阶段不可接受重跑成本，就缩小阶段边界、使用执行器的持久化会话，或改用真正的 durable workflow runtime

“自己维护领域状态”只包括原本就需要的案例、候选、裁决、审核和证据记录。任务领取、租约监控、retry scheduling、cron 和队列恢复交给库，不再自己写一套调度器。

### 必须显式配置的默认值

本次官方文档显示，pg-boss 默认 active 超时为 15 分钟，created/retry 保留 14 天，completed 保留 7 天；heartbeat 默认关闭。不能用这些默认值承诺无限期持久任务。[Jobs 配置](https://pgboss.io/api/jobs)

- 为每类任务设置 retryLimit、退避、active 超时、队列保留与终态清理策略
- 根据实际负载启用 heartbeat；`work()` 可自动续期，并提供 AbortSignal
- 丢失 claim 时应停止可取消工作；数据库网络失败本身不会自动 abort handler，外部副作用仍需独立幂等和核验
- 初期使用易理解的 standard queue 与明确并发配置，避免依赖 stately 的特殊重试行为
- pg-boss flow 的 DLQ redrive 不会自动续跑原依赖图；不能用它冒充完整 workflow replay

依据：[Workers](https://pgboss.io/api/workers)、[Queues](https://pgboss.io/api/queues)、[DLQ 与 flow](https://pgboss.io/api/jobs)。这些是当前版本的能力描述；实现须锁定版本，并用集成测试验证实际行为。

## 备选方案：按恢复语义和运维成本比较

| 方案 | 能否自托管 | 优点 | 当前未选原因 / 启用条件 |
| --- | --- | --- | --- |
| 自托管 Temporal + TS | 可以；服务端 MIT | 长生命周期、信号、持久化等待、Activity 重试与执行历史 | 多一个控制面及其运维；当长流程恢复成为实质需求时是首要升级候选，不必换领域语言 |
| DBOS TypeScript | 核心可以；MIT | 数据库支撑的 workflow/step 持久化，部署面小 | 单 executor 重启可恢复 pending；多副本故障转移无 Conductor 时需自行协调，不能直接称为自动 HA |
| Restate | 可以；服务端 BSL | Rust 单二进制、journal、按 key 单写者，部署紧凑 | 要接受 BSL 边界与新的执行模型；当前官方仍将 rate limits 列为后续能力，不能认为所有配额控制齐全 |
| Trigger.dev 自托管 | 核心可以；Apache 2.0 | TS 任务、队列、UI、重试 | 当前自托管版缺少 Cloud checkpoints/auto-scaling/warm starts，且需 Redis、Postgres、webapp、workers；与最小自托管目标不合 |
| Inngest 自托管 | 可以；当前服务端 SSPL，三年后 Apache 2.0 | 事件驱动、step 结果持久化、并发与 throttle | 引入独立服务及许可审查；可作为需要事件平台时的备选，当前阶段任务无需先增加它 |
| Graphile Worker | 可以；MIT | PostgreSQL + Node，原生 TS，at-least-once 和自动重试，基础设施很少 | 与 pg-boss 同类且合理；若偏数据库触发任务或团队已有经验可替换。只选一个队列，不叠加 |
| Python + PydanticAI | 可以；核心 MIT | 多模型、类型化输出、评测和 durable-runtime 集成 | 第二语言暂时没有必要；可先用于离线分析，或在模型/agent 评测收益明确时引入 |

### DBOS 的精确恢复边界

没有 Conductor 不等于不能用 DBOS。官方说明：单服务器进程重启时可恢复先前全部 pending workflows；在分布式设置下，应配置 executor ID，重启只恢复归属该 executor 的 pending。自动检测死 executor 并转移给健康 executor，需要 Conductor 或其他协调机制。仅把 Deployment replicas 从 1 改成 3，不能获得相同语义。[恢复文档](https://docs.dbos.dev/production/workflow-recovery)

可以选择单 executor、固定身份和明确重启恢复的紧凑方案，但它不是多副本透明故障转移。若为此另写恢复控制器，就需要重新比较直接使用 Temporal 的成本。Conductor 自托管生产用途需要商业许可证，不作为本方案必需项。[Conductor 自托管许可](https://docs.dbos.dev/production/hosting-conductor)

其他依据：[Temporal 自托管](https://docs.temporal.io/self-hosted-guide)、[Restate 核心概念](https://docs.restate.dev/foundations/key-concepts)、[Trigger 自托管功能对比](https://trigger.dev/docs/self-hosting/overview)、[Inngest 自托管](https://www.inngest.com/docs/self-hosting)、[Graphile Worker](https://worker.graphile.org/docs)、[PydanticAI](https://pydantic.dev/docs/ai/overview/)。

## 默认使用 Codex，保留清楚的模型边界

当前默认使用 `@openai/codex-sdk`，由官方 SDK 启动 Codex runtime，不重新实现 CLI transcript parser 或 agent loop。每个独立候选裁决创建新 thread，输出 JSON Schema 结果后再做 Zod 和证据校验。只读裁决禁用不需要的执行能力；生成并运行代码属于单独的隔离执行阶段。[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)

“用我的 Codex”优先指用户在目标 executor 自行授权的 Codex 登录。API key 是独立计费路径，不能自动替代账号认证。官方账号自动化指南要求可信私有 runner、持久化刷新后的状态，以及单 runner/串行任务流；因此账号模式初期使用专属 executor 和共享并发上限 1。不要把同一认证副本发到多个并行 Pod。[账号自动化](https://learn.chatgpt.com/docs/auth/ci-cd-auth)

`@openai/agents` 是另一套应用级 agent SDK，常规路径使用 API key；当前不需要为了语义裁决再加一层框架。App-server 适合深度交互式客户端，官方对 jobs/CI 建议优先 SDK。[Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)、[App Server](https://learn.chatgpt.com/docs/app-server)

用户允许模型外部调用，因此不强制先部署 vLLM。若以后需要本地模型，保留 OpenAI-compatible 适配边界，并单独验证模型权重许可、chat template、结构化输出、资源需求和实际精度。schema 合法不代表判定正确，所有后端都必须允许 Unknown/Disputed。[vLLM 接口](https://docs.vllm.ai/en/latest/serving/online_serving/)、[结构化输出](https://docs.vllm.ai/en/latest/features/structured_outputs/)

本地 Git 输入和产物导出也应独立于 GitHub 等托管平台；provider API 与对外发布是可选适配器。离线 demo 不要求外部代码托管账户。

## k3s 部署轮廓

### 最小验证环境

- 一个应用镜像，包含 API/CLI 与 worker 两个运行入口；可以先单 worker，生产按权限和负载拆 Deployment
- 一个 PostgreSQL 实例，业务与 pg-boss 分 schema/role
- 一个 SeaweedFS S3 实例及持久卷；小规模验证可用官方单进程模式，集群化用其 Helm 路线
- 可选的本地模型 Deployment；模型服务所需 GPU/内存不能计入普通 API Pod 的轻量预算
- 当前只读扫描不要求运行任意代码；执行阶段上线后再增加隔离 Job

这不要求 Redis、Kafka、自托管 Supabase 全家桶、完整 Trigger 平台或第二个工作流引擎。数据库和对象存储是两个有状态责任域，少组件仍需认真运维。[SeaweedFS 单进程与 Helm](https://github.com/seaweedfs/seaweedfs)

### 生产数据库与存储

生产推荐复用 CloudNativePG 管理 PostgreSQL 生命周期，并配置物理 base backup + WAL archive、保留策略与恢复演练。官方当前推荐 Barman Cloud Plugin；名字带 Cloud 不意味着只能使用公共云，实际目标与 endpoint 必须按所选对象存储验证。[CNPG 备份](https://cloudnative-pg.io/docs/1.28/backup/)

- 单节点 k3s、单 PostgreSQL、单磁盘 S3 都是单故障域，不能称为 HA
- 多副本必须结合节点和磁盘的真实故障隔离；给同一台机器增加 Pod 不等于容灾
- 数据库、对象存储、仓库缓存、模型权重和临时 workspace 分配明确容量
- PVC 的容量声明不一定等于底层文件系统的硬配额，要验证 StorageClass 的实际行为
- 配置数据库/WAL、对象容量、磁盘剩余量、队列积压与备份失败告警
- 对历史日志、过期 workspace 和模型缓存设置可审计的清理规则；规则版本和关键证据遵守单独保留策略
- 不把同一个集群、同一块磁盘里的备份当成灾备；离集群副本也可以存到自己管理的设备，无需强制购买云服务
- 数据库恢复、对象产物恢复、Kubernetes secrets/config 的恢复分别演练

### 执行隔离

Git worktree 只解决文件冲突。对不可信仓库安装脚本、测试和生成程序，建议使用每任务 Kubernetes Job，配置资源限额、非 root、只读根文件系统、禁用不必要的 service-account token、网络策略和明确清理时限；不挂宿主路径、Docker socket 或控制面凭据。

gVisor 可通过 containerd 和 RuntimeClass 接入，但需要节点安装、runtime 配置和兼容性验证。k3s 的 containerd 配置应按官方方式维护，不能仅创建一个 RuntimeClass 对象就宣称隔离已生效。[gVisor 配置](https://gvisor.dev/docs/user_guide/containerd/quick_start/)、[k3s containerd](https://docs.k3s.io/advanced#configuring-containerd)

Job 身份绑定领域运行和 attempt；超时或失联先查现有 Job，不直接创建第二份工作。`kubectl`/API 创建 Job 的权限留在受限执行控制入口，模型本身不获得集群管理员权限。

## 并发、429 与幂等

### 并发控制不等于 token 准入

任务数、sandbox 数、模型请求数、输入/输出 token 速率和预算分别计量。一个 agent session 内可能有多个请求，因此队列并发只能粗粒度保护。

第一版采用在线 review 与离线 mining 分队列、保守共享并发、单次 token/时间预算，以及有上限的退避。使用 pg-boss 提供的并发与调度能力，不自行发明分布式锁服务。真实 token admission 需求出现后，再评估成熟 gateway/limiter。

本地模型也有 GPU/队列容量限制；外部 API 可出现 429。供应商返回 retry-after 时应尊重，预算耗尽应进入 blocked，不能继续无限重试。SDK、agent 与任务三层只能有清楚的重试分工。[pg-boss Workers](https://pgboss.io/api/workers)、[Codex 账号与 API 计费](https://learn.chatgpt.com/docs/pricing)

### 队列去重不能替代永久领域唯一性

pg-boss 的 singletonKey 与队列 policy 约束特定状态下的并发/入队；任务保留和清理也有期限。永久领域去重仍使用 PostgreSQL unique key + payload digest；同身份不同内容必须报冲突。[队列策略](https://pgboss.io/api/queues)、[任务保留](https://pgboss.io/api/jobs)

备选平台同样有窗口：Trigger 幂等键默认 30 天且失败 run 会清除键；Inngest event/function 幂等窗口为 24 小时。迁移平台不能改变领域身份规则。[Trigger 幂等](https://trigger.dev/docs/idempotency)、[Inngest 幂等](https://www.inngest.com/docs/guides/handling-idempotency)

任何队列都不能独自保证远端模型收费、评论发布或作业启动恰好一次。结果成功但回执丢失时仍可能重试。保留外部 job/session ID、产物 hash 和发布回执，重试前核验；领域状态更新使用唯一约束与版本检查。

## 许可证边界

| 组件 | 本次核查结论 |
| --- | --- |
| pg-boss / Graphile Worker | MIT；分别提供完整自托管队列，二选一 |
| PostgreSQL / CloudNativePG | PostgreSQL License / Apache 2.0；备份插件及镜像依赖另行固定版本核查 |
| SeaweedFS | 核心 Apache 2.0；本方案只依赖已选定并验证的核心 S3 能力 |
| vLLM | 代码 Apache 2.0；模型权重许可证完全独立，不能用推理框架许可证替代 |
| Temporal | 服务端 MIT；本方案若升级，采用自托管服务而非 Cloud 必需项 |
| DBOS TS | 核心 MIT；Conductor 自托管生产许可单独管理，不作为免费核心的自动 HA 承诺 |
| Restate | 当前服务端 BSL 1.1，发布四年后转 Apache 2.0；不属于无条件 Apache 默认选项 |
| Trigger | 核心 Apache 2.0；Cloud 专有能力不能计入自托管方案 |
| Inngest | 当前服务端 SSPL，三年后授予 Apache 2.0；SDK 与服务端分别核查 |
| OpenHands / PydanticAI | 核心 MIT；模型、运行镜像和其他依赖许可独立 |
| Codex SDK / CLI | 当前安装的官方 SDK 标为 Apache 2.0；OpenAI 模型服务、账号权限和用量条款独立适用 |

来源：[pg-boss](https://github.com/timgit/pg-boss)、[Graphile](https://worker.graphile.org/docs)、[CNPG LICENSE](https://github.com/cloudnative-pg/cloudnative-pg/blob/main/LICENSE)、[SeaweedFS](https://github.com/seaweedfs/seaweedfs)、[vLLM LICENSE](https://github.com/vllm-project/vllm/blob/main/LICENSE)、[Temporal LICENSE](https://github.com/temporalio/temporal/blob/main/LICENSE)、[DBOS TS](https://github.com/dbos-inc/dbos-transact-ts)、[Conductor 许可](https://docs.dbos.dev/production/hosting-conductor)、[Restate LICENSE](https://github.com/restatedev/restate/blob/main/LICENSE)、[Trigger LICENSE](https://github.com/triggerdotdev/trigger.dev/blob/main/LICENSE)、[Inngest LICENSE](https://github.com/inngest/inngest/blob/main/LICENSE.md)、[OpenHands](https://github.com/OpenHands/software-agent-sdk)、[PydanticAI LICENSE](https://github.com/pydantic/pydantic-ai/blob/main/LICENSE)、[Codex 开源组件](https://learn.chatgpt.com/docs/open-source)。

## 本地实现与待验证能力

本地首个切片围绕 TypeScript/Zod 领域对象、PGlite、真实 AST scanner、fixture 裁决和显式模型适配器。最终可运行命令及通过的测试以 README 和测试输出为准。

下列能力没有实际运行证据时，必须标为待验证：

- PostgreSQL + pg-boss 在真实数据库上的事务、worker 崩溃、租约/超时与重试
- k3s manifests 的部署、节点故障、权限和 network policy
- SeaweedFS 对象上传、读取、清理、备份与恢复
- 本地模型的 schema/tool 兼容性、精度、成本和性能
- gVisor 的实际隔离、仓库测试兼容性和异常清理
- 真实外部仓库鉴权、评论发布与端到端去重

安装 SDK、生成 manifests、typecheck 或离线测试通过，都不能替代上述验证。默认测试和 demo 不读取环境中的凭据来自动启用云模型、远端存储或外部发布。必要应用基础设施保留可自部署路径；模型外部调用按用户选择启用。实际是否能在单集群同时运行，取决于节点、磁盘、网络和隔离条件，不能以架构图替代部署验证。
