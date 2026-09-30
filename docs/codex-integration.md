# Codex 接入：官方 SDK，账号认证与执行隔离分开

调研日期：2026-09-30。本文对照了官方文档以及本地安装的 `@openai/codex-sdk@0.159.2` 的公开 README、类型声明和实现。没有读取、复制或解析认证令牌，没有执行登录、授权或模型调用。

## 决策

FlyReWheel 使用 **官方 TypeScript Codex SDK `@openai/codex-sdk`**。应用、PostgreSQL/pg-boss、对象存储和执行环境自行部署；模型推理允许调用 OpenAI。当前方案不基于 Claude Agent SDK，也不要求先自托管大模型。

用户要求“用我的 Codex”时，优先考虑目标执行环境里由用户授权的 Codex 账号登录。ChatGPT/Codex 账号用量与 OpenAI Platform API key 计费是不同路径，不能从环境变量中发现一把 API key 就自动切换。套餐、可用模型与实际额度取决于用户账户，本文未验证该账户状态。[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[认证](https://learn.chatgpt.com/docs/auth)、[用量与计费](https://learn.chatgpt.com/docs/pricing)

## 四个接入口各自做什么

| 接口 | 适合的工作 | 本项目选择 |
| --- | --- | --- |
| `@openai/codex-sdk` | 在 Node 服务中启动、继续、恢复 Codex thread；复用现成 coding harness 和结构化事件 | 默认：阶段任务中的独立裁决与规则候选生成 |
| `codex exec` | 命令行和已有脚本中的非交互运行，JSONL 事件与 JSON Schema 输出 | SDK 的底层运行时；不再自行解析自由文本 CLI transcript |
| Codex app-server | 深度产品客户端、交互审批、会话管理和事件流 | 暂不直接接协议；以后需要完整交互式客户端再评估 |
| `@openai/agents` | 自定义 agent、tools、handoff、guardrail 与应用级编排 | 暂不增加。它的常规 quickstart 使用 API key，不应假设自动消费用户的 Codex 登录额度 |

官方明确建议自动化 jobs/CI 使用 Codex SDK；app-server 更适合深度客户端集成。官方 Agents SDK 有自己的应用运行模型，它与 Codex SDK 名称相似，但不是同一个产品入口。[App Server](https://learn.chatgpt.com/docs/app-server)、[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)、[Agents SDK quickstart](https://developers.openai.com/api/docs/guides/agents/quickstart)

## 已核对的 TypeScript API

当前安装版本通过官方 `@openai/codex` runtime 启动 CLI，并交换结构化 JSONL 事件。SDK 负责协议处理，领域代码只消费类型化结果。

| API | 行为 |
| --- | --- |
| `new Codex(options?)` | 可配置 `env`、`config`、`configOverrides`、`codexPathOverride`、`baseUrl`、`apiKey` |
| `codex.startThread(options?)` | 创建独立会话；支持 `workingDirectory`、`sandboxMode`、`approvalPolicy`、`model` 等 |
| `thread.run(prompt, { outputSchema, signal })` | 等待完成，返回 `finalResponse: string`、`items`、`usage` |
| `thread.runStreamed(prompt, options)` | 返回带有异步 `events` 的对象 |
| `thread.id` | 第一轮开始后才有值；不要在调用前假定已有 ID |
| `codex.resumeThread(id, options?)` | 在运行时仍可访问对应持久化会话的前提下恢复会话对象 |

`outputSchema` 接受 JSON Schema。返回的 `finalResponse` 仍是字符串，需要 `JSON.parse` 后再做 Zod/领域校验；schema 符合只代表结构有效，不代表引用、判定或证据真实。官方 SDK 文档给出 `startThread`、`run` 与 `resumeThread` 的使用方式，详细类型随所锁定的 SDK 版本核对。[官方 SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)

以下仅演示 API 形状，不会在离线测试里调用，也没有写入任何凭据：

```ts
import { Codex } from '@openai/codex-sdk';

// controlledEnv 必须由已授权配置生成，不要直接传入整个 process.env。
const codex = new Codex({ env: controlledEnv });
const thread = codex.startThread({
  model: configuredModel,
  workingDirectory: preparedEvidenceDirectory,
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  webSearchMode: 'disabled',
  networkAccessEnabled: false,
});
const turn = await thread.run(prompt, {
  outputSchema: decisionJsonSchema,
  signal: abortController.signal,
});
const decision = DecisionSchema.parse(JSON.parse(turn.finalResponse));
```

在实际实现中，结构化输出只是第一层检查，还应核对引用是否来自本次 evidence packet、文件/行号是否存在、缺失前提是否正确返回 Unknown，以及规则与 commit 的身份是否吻合。

### 独立会话与恢复

- 每次独立候选裁决创建新 thread，避免其他案例或规则的上下文污染
- 同一多轮任务才复用 thread；明确要恢复哪一个 ID，不能用“最近一次会话”作为业务身份
- 领域运行 ID、attempt ID、Codex thread ID、workspace/job ID 分别记录
- SDK 的会话持久化是 executor 本地状态。只保存 thread ID，不足以保证迁移到另一个 Pod 后仍能恢复
- pg-boss 重试不会自动恢复 Codex 进程、工作区和正在进行的工具；需核验已有结果或会话后，再决定恢复或新开 attempt
- 当前只读裁决可以选择每次干净会话重试，并清楚接受重复推理成本；不能宣称逐 token exactly-once

流式运行须处理 `thread.started`、`turn.completed`、`turn.failed`、`error` 和 `item.*`。看到 agent 文本不代表运行成功；缺少完成事件、超时、schema 错误或不允许的工具活动都要形成执行失败。[事件与结构化输出](https://learn.chatgpt.com/docs/non-interactive-mode)

## “用我的 Codex”的认证边界

### 本机或可信专属 executor

Codex 非交互运行可以复用已保存的 CLI 认证，SDK 使用同一运行时路径。用户可以在实际执行的环境自行完成官方登录，然后由应用使用该已授权状态。当前聊天界面、桌面应用或另一台机器已登录，不等于新的容器已经登录。[自动化认证](https://learn.chatgpt.com/docs/non-interactive-mode)

headless 环境有官方 device-code 登录路径。用户在目标环境运行 `codex login --device-auth`，在浏览器完成授权；可用性取决于账户/工作空间设置。此步骤由用户操作，仓库启动脚本不代替用户创建授权或修改安全设置。[headless 认证](https://learn.chatgpt.com/docs/auth)

### 账号认证用于 k3s 私有自动化

官方提供 ChatGPT-managed Codex auth 的高级私有 CI/CD 路径，同时说明一般自动化更适合 API key。选择账号路径需要遵守其运维条件：

- 专属可信 runner，持久化 Codex 自己刷新后的认证状态
- 同一份认证状态只供一个 runner 或串行任务流使用，不跨多机器/并发任务共享
- 不在每次 Pod 启动时用旧副本覆盖已经刷新的状态
- 不将认证状态放进仓库、镜像、日志、普通对象产物或公开 CI
- 官方高级指南不适用于 public/open-source 仓库的 CI 认证工作流；不要把这一凭据传播方案推广到不可信构建

据此，账号模式的最小部署建议是**一个专属 executor + 受保护的持久化状态 + 全局串行的 Codex 任务入口**。每个请求仍可创建独立 thread。增加普通 worker 副本不会增加账号额度，不能靠复制认证文件获得安全并发。[账号自动化高级指南](https://learn.chatgpt.com/docs/auth/ci-cd-auth)

这里描述的是官方支持边界和部署设计，没有执行凭据迁移。需要的登录、凭据挂载与持续访问授权必须由用户在目标环境单独完成。认证文件应视作密码；本文不提供将其复制进 Kubernetes Secret 的自动化脚本。

### API key 是另一条显式选项

API key 模式通过 OpenAI Platform 独立计费，不自动使用 ChatGPT 订阅额度。若以后改用该模式，应显式选择并接受其计费与配额，不因账号登录失效就静默 fallback。[认证与计费](https://learn.chatgpt.com/docs/auth)、[Pricing](https://learn.chatgpt.com/docs/pricing)

Codex SDK 支持 `apiKey` 选项，底层会将其传入 CLI 环境。应用不得记录其值。正式自动化也应避免把模型密钥暴露给仓库构建脚本、测试、依赖安装钩子或任意模型生成命令。[非交互安全说明](https://learn.chatgpt.com/docs/non-interactive-mode)

## 只读裁决的安全边界

`read-only` 约束文件写入，**不等于禁止 shell、读取其他文件或调用已配置工具**。`approvalPolicy: 'never'` 表示无交互审批，不会把拒绝的动作升级为允许。

本项目当前裁决适配器的方向是：

- 使用临时空工作目录，通过提示传入已筛选的 evidence packet
- 显式禁用 shell_tool、unified_exec、hooks、web search 等不需要的能力
- 不继承用户任意 MCP server、插件、项目指令或未审查的配置
- 传入允许列表环境，避免自动继承 API key、云存储密钥和发布凭据
- 收到 command、file change、MCP、web search 等不应出现的事件就取消并判定失败

最后一项是检测与止损，不能代替运行前的权限限制；事件出现时动作可能已经发生。真正执行仓库代码时仍需要独立隔离 worker/runtime。[Codex 非交互权限](https://learn.chatgpt.com/docs/non-interactive-mode)

当前 SDK 的 `networkAccessEnabled` 映射到 workspace-write sandbox 的网络配置；它不是关闭整个 Codex 进程的联网，也不会取代 Kubernetes 出站控制。模型推理本身需要访问所选服务。数据、模型网络和执行器网络应分别建模。

模型输入可以包含代码和内部问题，因此外部推理会把所选输入发送给模型服务。使用外部模型前，应确认这些仓库内容允许出站，并控制输入范围；“应用自行部署”不会自动带来“模型数据完全不出集群”。

## 额度、超时和证据

- Codex 账号额度、API RPM/TPM、任务并发和容器资源是不同限制
- 超时用 AbortSignal；取消不应被解释为推理从未发生或费用被撤销
- 当前 adapter 的 `maxReportedTokens` 是结果返回后的验收上限，不能当作供应商侧硬 spending cap
- 记录真实 `usage` 和会话 ID；无法核实的美元成本保留为空，不从订阅价格反推单次 API 成本
- 身份失效、额度耗尽和未知的重试状态应暂停对应队列或进入明确失败，不自动换供应商、模型或计费方式

## 本次验证范围

已核对：公开 SDK API、当前安装版本、CLI 帮助与 feature 名称、官方认证及计费说明。

尚未验证：用户实际登录状态、剩余额度、指定模型可用性、首次真实推理、Pod 内登录、会话跨 Pod 恢复、安全配置对所有工具的完整覆盖，以及私有账户自动化的长期刷新。

因此，SDK 接入代码和离线测试通过只代表适配边界可以继续验证；不能写成“已连接用户 Codex”或“已使用 Pro 额度跑通”。
