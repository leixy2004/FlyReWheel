# FlyReWheel

一个可运行的、自托管优先的质量规则闭环核心。使用 TypeScript、官方 OpenAI Codex SDK、PostgreSQL/pg-boss 与 S3 接口，面向单个 k3s 集群部署。

当前是 **0.1 验证版本**：领域证据、真实 AST 检测、规则版本、回放、反馈、晋升门禁、队列和 Codex 适配已经实现。它尚未覆盖完整的持续治理工作流。没有调用真实模型、连接你的 Codex 账号、部署 k3s，或向任何仓库发评论。

## 为什么这样选

- **Codex SDK**：复用现成 Agent 运行时、独立会话和结构化结果，不自行拼接 CLI 文本协议；账号登录与 API key 显式分开，不自动换计费方式
- **PostgreSQL + pg-boss**：业务数据和阶段任务共用 PostgreSQL，不增加 Redis、独立调度服务器或第二套状态机
- **S3 接口**：使用官方 AWS 客户端，兼容自托管对象存储；SeaweedFS 是部署候选，不要求托管 SaaS
- **ast-grep / OpenGrep / Go 工具生态**：复用解析和检测能力。当前可执行内置路径为 Python 与 JS/TS ast-grep，另有 Semgrep/OpenGrep JSON 导入器；Go 深语义扫描适配仍待接入
- **Vitest + 检测器原生测试 + promptfoo**：确定性契约与模型评测分开；暂不自建评测服务器和治理前端

详细取舍、竞品和许可证边界：

1. [技术栈决策](docs/stack-decision.md)
2. [现有产品及检测组件比较](docs/component-comparison.md)
3. [设计约束与验收要求](docs/design-lessons.md)
4. [评测、检索、证据与磁盘治理](docs/evaluation-research.md)
5. [Codex 账号、SDK 与计费](docs/codex-integration.md)
6. [k3s 部署](docs/deployment.md)
7. [vLLM 实验结果](experiments/vllm/RESULTS.md)与[验证范围](docs/verification.md)

## 无账号快速运行

需要 Node.js 22 或更新版本，以及 npm。提取真实 Git 历史时还需要 Git。

```bash
npm ci
npm run typecheck
npm test
npm run demo -- --out demo-report.json
```

演示使用真正的 ast-grep 和嵌入式 PostgreSQL（PGlite），不需要容器或云账号。语义裁决使用显式 fixture，绝不调用模型。PGlite 仅用于单进程开发和测试；k3s 使用普通 PostgreSQL。

演示覆盖：

| 案例 | 预期阶段 |
|---|---|
| 修复前缺少有效等待超时 | AST 命中；fixture 裁决通过 |
| 添加显式超时后 | AST 不命中 |
| 外层已提供有效截止时间 | AST 命中；带证据的 fixture 判定不适用 |
| 缺少调用者上下文 | Unknown，禁止凭局部代码直接下结论 |
| 只有 discussion resolve | ground-truth 仍为 Unknown |
| 用合成样例晋升生产规则 | 拒绝晋升 |

演示报告里的 precision/recall 只是这些合成输入与固定标签的计算结果，不能作为真实模型质量、业务收益或泛化能力。

要保留本地数据，可加 `--db .flyrewheel/dev-db`。相同版本和运行身份重放会复用已保存结果，不覆盖历史。

## 使用自己的样本

```bash
npm run cli -- replay \
  --bundle examples/deadline-bundle.json \
  --dataset examples/deadline-dataset.json \
  --db .flyrewheel/dev-db --out replay.json
```

每个 ProblemCase 应表示一个明确问题位置。当前回放器对单案例的多个检测命中会记录 execution_error，要求拆分案例，不会静默截取第一个。`not_recalled` 是覆盖记录，报告中的占位位置不代表发现了真实缺陷，也不会发布为诊断。

导入已有仓库的已知 Bug-Fix Pair：

```bash
npm run cli -- extract \
  --repo /absolute/path/to/your/repo \
  --base BASE_SHA --head FIX_SHA --path src/example.ts \
  --case-id case-001 --problem '明确的问题与预期行为' \
  --out training-pair.json
```

该命令用 Git 读取指定 commit 的文件，不 checkout、不执行项目代码、不自动把 commit message 当成 bug 事实。它当前读取一个已存在于前后两个提交中的 UTF-8 文件；跨文件案例可以按 [SynthesisInput](src/adapters/model-contract.ts) 手工组织证据。

单独执行真实静态检测：

```bash
npm run cli -- scan --bundle examples/deadline-bundle.json --file path/to/source.ts
```

## 接入你的 Codex

先读 [认证与安全边界](docs/codex-integration.md)。目标环境必须由你完成授权；仓库不包含登录状态，也不会寻找或搬运桌面认证文件。

账号模式示例，环境变量由运行者设置：

```bash
export QE_ENABLE_MODEL=true
export QE_CODEX_AUTH_MODE=account
export QE_CODEX_HOME=/absolute/path/to/dedicated-login-home
export QE_CODEX_MODEL=your-account-supported-model

npm run cli -- synthesize --input training-pair.json --enable-model --out draft.json
npm run cli -- replay --bundle examples/deadline-bundle.json \
  --dataset examples/deadline-dataset.json --enable-model --out live-replay.json
```

`synthesize` 可以合法返回 `status: no_rule`。生成候选后会验证 AST 规则对训练 pair 的 pre-fix 命中并记录 post-fix 命中；修复后仍有静态候选时，必须进一步验证语义裁决能否排除它，不能把高召回检测器直接判成无效。输出仍是待审草稿。候选到 RuleBundle 的审查/版本化由调用者显式完成，不自动上线。

API 模式需要显式设置 `QE_CODEX_AUTH_MODE=api` 和 `QE_CODEX_API_KEY`，使用独立 API 计费。账号模式不会自动读取环境里的 OpenAI API key。不要把真实密钥写入版本库、镜像、测试、普通对象产物或聊天。

裁决默认无 shell、无 MCP、无网页搜索，使用干净工作目录，仅接收本次证据。新 thread 防止跨案例污染。这不是通用“执行任何仓库测试”的沙箱；任意代码执行仍禁用。

## 队列与 k3s

```bash
# DATABASE_URL 指向你自行部署的 PostgreSQL，凭据由你配置
npm run worker

# 在另一个终端提交离线回放任务
npm run cli -- enqueue --bundle examples/deadline-bundle.json \
  --dataset examples/deadline-dataset.json
```

模型任务必须额外显式启用。账号执行器保持单副本、串行队列组和专属可写认证状态卷；不能把同一认证副本散发给并发 Pod。pg-boss 队列并发不等于供应商 token 限流。

阶段任务可以重试，但模型调用不保证 exactly-once。已完成的领域记录会复用；执行错误保留审计记录。修复失败原因后用新的 `--attempt` 标识重新评估，不能覆盖先前结果。模型配置/裁决策略变化必须产生新的运行身份。进程在推理完成与结果落库之间崩溃，仍可能造成重复推理费用。

启用 S3 产物归档时，worker 使用 `QE_S3_ENABLED=true` 及明确的 endpoint、bucket、access-key 配置。它上传输入与结果，并把内容摘要与对象引用永久绑定到数据库中的评测记录；这些引用不依赖短期队列日志。不自动创建 bucket。条件写入与读回校验仍需在所选 S3 后端上做集成验证，不能据此宣称 WORM。

## 已实现与未实现

| 能力 | 当前状态 |
|---|---|
| ProblemCase、RuleBundle、执行记录、反馈、评测、晋升 CAS | 已实现并有真实 PostgreSQL 引擎测试 |
| 独立裁决、缺证据 Unknown、错误与标签分离 | 已实现，模型行为用契约测试验证 |
| AST 检测、正反例回放、Git 文件证据提取 | 已本地运行 |
| Codex SDK / OpenAI-compatible 适配 | 已实现；没有真实模型调用 |
| pg-boss 任务、去重、过期/重试配置 | 已用官方 PGlite 适配器本地测试；未验证多主机恢复 |
| 自托管 PostgreSQL、S3 客户端、k3s 清单 | 接口/清单已提供；没有镜像构建或集群实测 |
| 发布门禁、SARIF 导出 | 仅生成计划/导出，不自动发评论 |
| GitHub/GitLab webhook、评论收发、身份核验 | 未接入 |
| Go 类型/跨函数分析、全库召回、自动上下文检索 | 未集成，组件比较已给出路线 |
| 自动规则聚类合并、在线演化与灰度策略 | 未完整实现 |
| 任意仓库代码测试、沙箱 Job、gVisor | 尚未实现/验证 |
| 治理 Web UI、真实历史集评测及 ROI | 尚未完成 |

下一步应使用一个你有权处理的真实仓库，在目标 executor 完成 Codex 授权，运行少量人工标注 Bug-Fix Pair。先核实收益和错误边界，再接评论发布和持续演化。上游 vLLM 样例的许可证保留在对应目录。项目本身的公开分发许可证尚待维护者选择。
