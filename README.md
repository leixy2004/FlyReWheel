# FlyReWheel

一个可运行的、自托管优先的质量规则闭环核心。使用 TypeScript、官方 OpenAI Codex SDK、PostgreSQL/pg-boss 与 S3 接口，面向单个 k3s 集群部署。

本目录是唯一持续维护的 FlyReWheel 版本：基于恢复的公开提交 `7bc18b4ac4cd932d8cde12d085b1d947c7816c4e`，现已合入固定版本 Sandcastle 的工作区生命周期。重启前报告的 425 项测试对应的后续源码未找回，不能将旧结果用于当前版本；恢复范围与本次实测见[验证记录](docs/verification.md)。旁边的 `workspace-proof/` 仅保留作历史实验归档，不是第二个产品版本。

当前收敛状态、已整合分支与可运行入口见[统一应用检查点](docs/converged-application-2026-10-04.md)。其中本地 authored 治理闭环可运行，真实模型、完整 runtime 与实际部署的边界仍单独保留。

当前是 **0.1 验证版本**：领域证据、真实 AST 检测、规则版本、回放、反馈、晋升门禁、队列和 Codex 适配已经实现。它尚未覆盖完整的持续治理工作流。没有完成真实模型调用或部署 k3s；开发验证不等于真实效果或生产就绪。

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
8. [Sandcastle 工作区：准备、检查与清理](docs/workspaces.md)
9. [语义规则 v2：独立保存、精确版本与本地导入](docs/semantic-rules.md)
10. [冻结 Git 变更快照](docs/change-snapshots.md)
11. [本地 v2 审查、精确反馈与待处理修订请求](docs/semantic-reviews.md)
12. [本地修订对照与显式决策](docs/local-revision-comparisons.md)
13. [单命令本地闭环：历史挖掘到生成修订与决策](docs/local-closed-loop.md)
14. [本地语义规则治理：显式选择、停用与替换](docs/semantic-rule-governance.md)
15. [精确审查 head 上的选定仓库上下文与引用](docs/repository-context.md)
16. [领域命令与队列共用显式数据库](docs/database-selection.md)

## 无账号快速运行

先按[离线复现指南](docs/offline-reproducibility.md)选择路径：默认 source CLI 的
`evaluation native init-authored/run` 可完成模拟 SDK 研究并跨进程重开；
`evaluation native init-w0/run` 只保存六份真实 W0 上下文的 blocked 状态。
指南提供完整输入准备和可复制命令，并分别列出模型与实际部署的前提。
以下保留原有产品本地闭环演示；它与研究路径使用各自的 authored 输入。

完整本地闭环需要 Linux、Git、Node.js 22 或更新版本，以及 npm。

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
node dist/cli.js closed-loop demo --out-dir .flyrewheel/closed-loop
```

这条命令在同一个本地数据库中完成：真实合成 Git 历史 → PR 证据与挖掘候选 → 后续目标审查 → 精确 fixture 反馈 → 生成修订 → 同快照对照 → 本地 accept/reject。报告和 33 份带摘要的 JSON 保存在输出目录；关闭再打开数据库验证 28 个记录后才报告成功。重复命令会复用并校验既有记录。

所有提案、语义判断和反馈均为 authored fixture；`modelExecution: not_run`、人工 verdict 为 `Unknown`，没有规则激活。compatible 场景保留正例并修正负例，regressed 场景验证接受被阻止。这些场景只验证功能链路，不能作为真实效果。完整命令、产物和故障恢复见[本地闭环快速上手](docs/local-closed-loop.md)。

要继续验证显式治理和后续审查，使用独立输出目录：

```bash
node dist/cli.js closed-loop governance-demo --out-dir .flyrewheel/governance-loop
```

此[持久化治理示例](docs/local-governance-loop.md)复用上述闭环，显式选择获接受的修订版本进入 `local-shadow`，验证旧计划失效，并执行 authored governed review。PGlite 与模拟判断只验证功能接线；`local-shadow` 不代表生产激活，fixture 反馈不改变人工 `Unknown`。

### 旧版检测器演示

```bash
npm run demo -- --out demo-report.json
```

演示使用真正的 ast-grep 和嵌入式 PostgreSQL（PGlite），不需要容器或云账号。语义裁决使用显式 fixture，绝不调用模型。PGlite 仅用于单进程开发和测试；k3s 使用普通 PostgreSQL。

`npm test` 默认限制为两个文件 worker，减少本地 Git/PGlite 集成测试的资源争用；断言和超时不放宽。实测与首次无限制并行超时记录见[验证记录](docs/verification.md)。

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

## 同一仓库、不同提交的工作区

使用完整历史的专用可信 Linux Git 仓库。`--base` 指定实际 checkout 的完整 SHA；可选 `--head` 记录比较提交，连同 merge-base 一起保留。每次尝试必须使用新的身份。

```bash
npm run cli -- workspace prepare --repo /path/to/repo \
  --run pilot-001 --attempt try-001 --base FULL_BASE_SHA --head FULL_HEAD_SHA
npm run cli -- workspace inspect --repo /path/to/repo --run pilot-001 --attempt try-001
npm run cli -- workspace cleanup --repo /path/to/repo --run pilot-001 --attempt try-001
```

通过真实 `@ai-hero/sandcastle@0.12.0` API 创建和清理工作区。不同提交可以独立编辑；同一身份不会默默复用。清理只移除已确认干净的工作区，保留分支、提交、身份记录和证据；未提交及 ignored 文件保留原地，命令返回 2，等待明确处理。详细限制、返回值和故障恢复见[工作区文档](docs/workspaces.md)。

完整历史中可见后续提交，所以这不是防止未来信息泄漏的历史评测隔离。OpenSandbox 适配和离线保护已实现，单次真实试验在 SDK readiness 阶段超时；[该记录](deploy/opensandbox/README.md)不证明完整生命周期或生产就绪。本命令不执行仓库代码，也未连接 Codex 工作区运行。暂不引入 Temporal。

## 使用自己的样本

### 不依赖静态检测器的语义规则

新增 `schemaVersion: 2`：保存问题机制、不变量、适用范围、例外、必需上下文、可检验预期、来源案例与父版本。检测资产可不提供，也可提供多份；来源绑定已有案例的完整 commit、路径与内容摘要。

```bash
npm run cli -- rules import --rule examples/semantic-rule-v2.json \
  --cases examples/semantic-rule-cases.json --db .flyrewheel/semantic-db
npm run cli -- rules list --db .flyrewheel/semantic-db
npm run cli -- rules show --digest SHA256_FROM_IMPORT --db .flyrewheel/semantic-db
```

这条路径仅导入和检查不可变版本，不会运行模型、检测器或激活规则。示例明确为 synthetic，标签为 unknown。案例与规则在一个事务中导入，失败时一并回滚。旧 RuleBundle v1 保持原结构和摘要；以下 replay/scan 仍只接受 v1。详细契约与边界见[语义规则文档](docs/semantic-rules.md)。

### 快照 → 本地审查 → 反馈 → 修订请求

```bash
npm run cli -- reviews demo --db .flyrewheel/review-db --out review-demo.json
npm run cli -- reviews run --rule-digest RULE_SHA256 \
  --snapshot-digest SNAPSHOT_SHA256 --db .flyrewheel/review-db
```

`reviews demo` 在同一数据库完成一个明确的合成示例：真实 ast-grep 产生两份资产命中，按同一源码位置聚合为一个 finding；显式 fixture 提供模拟语义结果，fixture note 不产生人工 TP 标签，最后保存 `pending` 修订请求。没有生成或激活新规则。

普通 `reviews run` 使用已保存的精确规则和快照。没有 fixture 时不进行语义推理；无检测器、零命中、缺失上下文及未覆盖资产保留各自状态。新 fixture `schemaVersion: 2` 用 `anchorJudgments` 分别保存每个位置的判断、证据与上下文缺口，同一文件可同时保留违规和合法例外；文件整体为 unknown 时，已有充分证据的局部判断仍可成立。旧 fixture 和历史记录保持原契约。快照只含变更文件证据，不能当成完整仓库上下文；head 上的发现不等于本次变更新引入。查看、反馈和请求命令见[完整本地流程](docs/semantic-reviews.md)。

### 冻结未变更的契约与测试

`contexts capture` 显式选择仓库路径，从完整 SHA 指定的审查 head 读取有界 Git blob；`show`、`import`、`verify`、`cite` 和 `list` 支持不可变保存、重新本地校验与精确引用。二进制、超限、符号链接、子模块和目录会显式排除，缺失路径单独记录；不会递归抓取、读取未来分支内容或执行目标代码。可用 `--snapshot-digest` 校验同仓库、同审查 head 绑定。

选定上下文已通过独立版本化契约接入语义审查：fixture v3、review runtime v3 和 workspace judgment v4 固定同仓库、同 head 的有界包集合，允许逐锚点引用未改动的契约或测试；finding 仍只定位改动目标。工作区执行前重新校验本地 Git，离线导入与重读仅保证包内部完整性。缺少所需引用仍为 Unknown，fixture 判断不会变成人工真值，历史可见性仍未证明。命令、API 与下游限制见[选定仓库上下文](docs/repository-context.md)。

### 候选修订 → 同快照对照 → 本地决策

```bash
npm run cli -- revisions demo --db .flyrewheel/revision-db --out revision-demo.json
npm run cli -- revisions compare --file comparison.json --db .flyrewheel/revision-db
npm run cli -- revisions decide --file decision.json --db .flyrewheel/revision-db
```

`revisions demo` 使用真实 ast-grep 和显式合成 fixture，分别展示保留正例、修正安全负例的 `compatible` 候选，以及丢失正例的 `regressed` 候选。两份请求绑定同一基线但各自指定候选版本，演示决策明确标为 fixture accept/reject，人工 verdict 仍是 Unknown。

对照冻结两版规则的完整回归案例并集、精确反馈位置和同快照 review。当前评分契约 `per-anchor-semantic-v3`（带上下文时为 `per-anchor-context-v4`） 保留文件级案例判断，并独立比较反馈锚点；目标整体 unknown 不会抹掉证据完整的局部判断。检测资产可选，但所有已声明扫描都必须完成；零命中、引用证据或缺失锚点不能冒充安全。只有当前评分契约的 compatible 对照允许新增 accept，旧评分记录和历史决策仍可读取。决策不激活规则、不修改 pending 请求，也不改变旧版晋升流程。输入格式、不可变性与信任边界见[本地修订对照文档](docs/local-revision-comparisons.md)。

### 显式本地规则选择、停用与替换

`local-semantic-review` 是独立于旧版 v1 active registry 的本地实验命名空间。先导入不可变 v2 版本，再通过显式 CAS 命令注册为 candidate；根版本可作为明确未验证的基线进入 `local-shadow`，修订版则需要精确绑定、非空已评分的当前 compatible 对照与 accept 决策。可显式 suspend、retire，或在同一事务中 supersede 旧版并选择已注册的直接后继。每个逻辑规则最多选择一版，历史保留 actor、source、reason、时间和精确摘要；fixture 与 local-human-declared 都不是身份认证。

```bash
npm run cli -- rules governance apply --file command.json --db .flyrewheel/semantic-db
npm run cli -- rules governance show --rule-id RULE_ID --db .flyrewheel/semantic-db
npm run cli -- rules governance history --rule-id RULE_ID --db .flyrewheel/semantic-db
npm run cli -- rules governance select --repository EXACT_REPOSITORY \
  --path src/worker.ts --path src/wait.ts --db .flyrewheel/semantic-db
```

select 按精确仓库身份与字面路径范围返回本地可选版本及排除原因，不运行审查或发布。显式 digest-pinned 审查仍可用于历史与研究重放；只有主动采用 registry selection 的调用受此门禁约束。导入、生成候选和 accept 不会自动改动选择，`local-shadow` 不代表生产激活、认证或广泛正确性。完整输入、迁移条件与信任边界见[本地治理文档](docs/semantic-rule-governance.md)。

### 仓库历史 PR 的有界发现与本地批量采集

`github-pr history preview` 显式指定仓库、PR 创建时间窗口和状态，默认仅选 5 个 PR；先查看计划，再 `import` 到本地数据库，用 `capture` 串行采集。状态可跨进程恢复，逐 PR 保存精确证据/快照摘要和失败原因；已完成项不会重新抓取。`mining-request` 复用现有未知标签来源绑定，不自动推断缺陷、执行模型或激活规则。

这仍是 GitHub 当前 API 对所选历史 PR 的观察，不是历史审查检查点或完整仓库样本。合并 PR 的当前比较可能为空。vLLM 小批次命令、分页/采集预算、显式重试与信任边界见[有界 PR 历史采集](docs/github-pr-history.md)。

### 冻结输出的离线配对评测

```sh
node dist/cli.js evaluation demo --directory /tmp/flyrewheel-paired-demo
node dist/cli.js evaluation score --dataset /tmp/flyrewheel-paired-demo/dataset.json --annotations /tmp/flyrewheel-paired-demo/annotations.json --runs /tmp/flyrewheel-paired-demo/runs.json --out /tmp/flyrewheel-paired-report.json
```

输入是单独提供的标注清单和已冻结审查输出；命令不调用模型。报告绑定数据、规则版本、方法、模型、信息和总预算，按精确位置统计有效问题、误报负担、漏掉的正例、未知与未覆盖项，并给出同条件配对差值。示例标签和预测均为手写 synthetic oracle；移除一个误报的同时也丢失一个正例，不能把这些数写成真实效果。已有输出路径不会被覆盖。完整边界见[离线配对评测](docs/paired-review-evaluation.md)。

### 回放旧版单检测器规则

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
  --dataset examples/deadline-dataset.json --postgres
```

持久化领域命令必须显式选择 `--db <目录>` 或 `--postgres`。后者读取 `DATABASE_URL`，可把规则、快照、上下文、挖掘及修订依赖直接存入 worker 使用的同一个数据库；环境变量本身不会自动切换 CLI。`application-jobs enqueue/status` 和旧版 `enqueue` 访问 PostgreSQL 时也需 `--postgres`。详情与输入准备顺序见[数据库选择](docs/database-selection.md)。

模型任务必须额外显式启用。账号执行器保持单副本、串行队列组和专属可写认证状态卷；不能把同一认证副本散发给并发 Pod。pg-boss 队列并发不等于供应商 token 限流。

阶段任务可以重试，但模型调用不保证 exactly-once。已完成的领域记录会复用；执行错误保留审计记录。修复失败原因后用新的 `--attempt` 标识重新评估，不能覆盖先前结果。模型配置/裁决策略变化必须产生新的运行身份。进程在推理完成与结果落库之间崩溃，仍可能造成重复推理费用。

启用 S3 产物归档时，worker 使用 `QE_S3_ENABLED=true` 及明确的 endpoint、bucket、access-key 配置。它上传输入与结果，并把内容摘要与对象引用永久绑定到数据库中的评测记录；这些引用不依赖短期队列日志。不自动创建 bucket。条件写入与读回校验仍需在所选 S3 后端上做集成验证，不能据此宣称 WORM。

## 已实现与未实现

| 能力 | 当前状态 |
|---|---|
| ProblemCase、RuleBundle、执行记录、反馈、评测、晋升 CAS | 已实现并有真实 PostgreSQL 引擎测试 |
| 语义规则 v2、可选/多检测资产、明确 scope、来源绑定、不可变版本导入/读取 | 已实现本地持久化、有界快照审查与受信工作区 API；尚未验证真实模型审查或 PR 挖掘运行 |
| [v2 审查 → 精确本地反馈 → 修订请求](docs/semantic-reviews.md) | 已实现原生检测、覆盖记录、fixture/受信工作区裁决、不可变反馈与 pending 请求；不代表已完成通知或生产治理 |
| [候选修订对照与显式本地决策](docs/local-revision-comparisons.md) | 已实现同快照对照、完整回归案例并集、精确反馈位置与 accept/reject/defer；fixture 不是人工批准，accept 不激活规则 |
| [冻结审查输出与独立标注的离线配对评测](docs/paired-review-evaluation.md) | 精确身份、问题去重、误报/漏报/未知计数及声明同条件差值；synthetic 验证不证明模型效果 |
| [本地语义规则治理与精确范围选择](docs/semantic-rule-governance.md) | 显式候选/本地 shadow/停用/退役/原子替换、逐规则 CAS 历史；不代表生产激活、认证或自动演化 |
| [GitHub PR 只读证据采集](docs/github-pr-evidence.md) | 单个公开 PR 的有界当前 API 观察、精确 blob 和讨论来源；不等于历史审查时点、真实标签或全仓库访问 |
| [仓库 PR 历史采集](docs/github-pr-history.md) | 显式仓库/创建时间/状态筛选、有界预览、可恢复本地逐 PR 采集与精确挖掘请求关联；不自动广泛抓取或推断标签 |
| [本地 Git 变更快照](docs/change-snapshots.md)、精确提交字节、覆盖缺口、导入/查看/分页 | 已实现有界冻结与不可变持久化；导入仅校验内部完整性，不等于已核验 PR 历史 |
| 独立裁决、缺证据 Unknown、错误与标签分离 | 已实现，模型行为用契约测试验证 |
| AST 检测、正反例回放、Git 文件证据提取 | 已本地运行 |
| Sandcastle 多提交工作区、不可变 attempt、检查与保守清理 | 已合入主 CLI；真实本地 Git 与公共 API 测试 |
| Codex SDK / OpenAI-compatible 适配 | 已实现；没有真实模型调用 |
| pg-boss 任务、去重、过期/重试配置 | 已用官方 PGlite 适配器本地测试；未验证多主机恢复 |
| 自托管 PostgreSQL、S3 客户端、k3s 清单 | 接口/清单已提供；没有镜像构建或集群实测 |
| 发布门禁、SARIF 导出 | 仅生成计划/导出，不自动发评论 |
| GitHub/GitLab webhook、评论收发、身份核验 | 未接入 |
| Go 类型/跨函数分析、全库召回、自动上下文检索 | 未集成，组件比较已给出路线 |
| 自动规则聚类合并、在线演化与灰度策略 | 未完整实现 |
| 任意仓库代码测试、沙箱 Job、gVisor | 尚未实现/验证 |
| 治理 Web UI、真实历史集评测及 ROI | 尚未完成 |

下一步应使用一个你有权处理的真实仓库，在明确的执行隔离与授权下运行少量人工标注 Bug-Fix Pair。先核实收益和错误边界，再接评论发布和持续演化。项目采用 [Apache-2.0](LICENSE)，第三方说明见 [NOTICE](NOTICE)；上游 vLLM 样例的许可证保留在对应目录。

## PR evidence mining requests and supplied candidates

The local `mining request` / `mining supply` CLI now freezes exact GitHub PR source
bytes and statement identities, derives unknown-only training cases, and validates
a supplied or fixture semantic-v2 candidate into the existing immutable rule
registry. This is not live model mining and creates no correctness labels or
activation. Run the complete [synthetic example and inspect its trust boundaries](docs/pr-mining.md).

A [supervised workspace generation API](docs/pr-mining-model-boundary.md) now connects
strict mining output to immutable execution receipts and atomic candidate storage.
Its trusted runtime capability cannot be replaced with claimed JSON provenance.
The offline SDK/executor tests retain fixture/not-run labels; live model execution
still requires separately authorized, verified isolation and gateway infrastructure.

A [supervised semantic-v2 review API](docs/semantic-review-model-boundary.md) now
connects the same full-repository runner to exact snapshot-bound judgments and
the existing immutable review/finding store. It rechecks the frozen snapshot
against local Git before execution, preserves explicit Unknown/context limits,
and accepts persistence only through a trusted runtime capability. Authored SDK
tests remain fixture/not-run results; live infrastructure prerequisites still block
production use, and introduction/notification eligibility stay unverified. New
`semantic-review-v2` worker output and `per-anchor-v3` receipts bind independent
anchor judgments; legacy prompts, receipts and fixture identities rederive under
their original contracts. The [mixed-anchor verification record](docs/evidence/mixed-anchor-review-verification-2026-10-02.txt)
and [compiled SDK/worker/store/comparison smoke](docs/evidence/compiled-mixed-anchor-review-smoke-2026-10-02.json)
cover authored responses only, with no live model/backend or empirical benefit claim.

### Feedback-driven revision generation

The application API now generates bounded, reviewable candidates from frozen selected feedback, using the existing workspace runner and immutable rule/comparison flow. See [revision generation](docs/rule-revision-generation.md) for the API, source-use reservations, fixture boundaries, exact limits, and the compiled authored-SDK smoke. Selected exact-head repository context is supported by the explicit `rule-revision-v3` / `selected-context-evidence-v1` contract, carrying only selected finding citations through generation and context-aware comparison. Snapshot-only v2 and historical v1/v2 record hashes remain compatible. Full-repository revision synthesis and production backend/auth verification remain planned work.

Persisted generated records are inspectable without re-running generation:

```sh
npm run cli -- revisions candidates --db ./state --request-digest <request-sha256> --limit 20
npm run cli -- revisions candidate --db ./state --digest <candidate-sha256>
npm run cli -- revisions outcomes --db ./state --request-digest <request-sha256> --limit 20
npm run cli -- revisions outcome --db ./state --digest <outcome-sha256>
```

Lists have exclusive digest cursors and exact ID/request filters; candidate lists also filter by rule digest. Show preserves the immutable record and adds evidence links, execution/source distinctions, proposed diagnoses, and next steps. Fixture labels remain separate from caller-declared human verdicts; inspection does not certify quality. See the [inspection contract and comparison links](docs/rule-revision-generation.md#inspect-persisted-generation-results-from-the-cli). Both explicit database selectors are supported; opening storage may apply pending migrations.

### Workspace application queue

`application-jobs validate|enqueue|status` and the testable worker service now wire
PR mining, semantic review, and revision generation through pg-boss and existing
trusted adapters. The default executable remains explicitly blocked for workspace
execution until a reviewed trusted runtime/resolver bootstrap is supplied. See
[application job lifecycle](docs/application-jobs.md) for bounded payloads, atomic
outcome persistence, retries, and the remaining production gateway/lifecycle gates.

### Governance-selected local reviews

`reviews governed plan|show|enqueue|status` freezes a snapshot-bound selection of
local-shadow rules and explicit exclusion reasons, then uses the existing trusted
application jobs. Every execution attempt rechecks the complete registry at a
short transactional admission point; suspended, retired or replaced versions
cannot start under stale plans. Already admitted work retains its historical
selection. Explicit digest replay remains available and is labeled non-governed.
See [governed semantic reviews](docs/governed-semantic-reviews.md) for the CLI,
20-job bound, race semantics, trusted runner and fixture-only verification limits.

### Versioned storage upgrades

Domain migrations now reuse pinned node-pg-migrate with ordered history, SHA-256 checksums and atomic upgrades. Existing pre-ledger databases must be backed up, reviewed with `database inspect`, then explicitly adopted without replaying historical SQL. See [database migrations and recovery](docs/database-migrations.md) before upgrading an existing store.
