# FlyReWheel 成熟组件与完整产品选型

调研日期：2026 年 9 月 30 日。本文比较完整代码评审产品、静态检测引擎、代码上下文、Git 挖掘与评审集成。产品能力依据官方文档与项目仓库；架构取舍是结合重建要求给出的建议，尚未经过真实业务仓库的效果测试。许可证信息用于识别集成风险，不构成法律意见。

## 一 结论与默认方案

**优先复用成熟组件，只保留可验证的知识演化核心。当前硬约束是业务系统全部自行部署，优先放在一个 k3s 集群中；允许调用外部模型 API，Agent 采用用户选择的 Codex/OpenAI。** 如果目标只是提升团队日常 code review，可评估满足这些部署和模型约束的完整产品；采用产品并停止自建仍是合理结果。若明确需要可控的 Problem Case、耦合的 Skill 与 detector、冻结的历史回放、版本晋升与回滚，则保留薄的领域核心。

当前默认方案以最新要求为准，历史材料中的托管方向不再是约束：

- **应用与 Agent**：TypeScript + 官方 Codex SDK，不引入 Claude Agent SDK，不自制命令行输出解析器或通用 Agent Harness
- **持久任务**：pg-boss + 自部署 TypeScript worker，复用 PostgreSQL，不依赖托管任务服务
- **事实与产物**：自部署 PostgreSQL + S3 兼容对象存储，SeaweedFS 为候选；不依赖托管 Supabase
- **部署**：业务服务、队列、数据库和对象存储优先收敛在一个 k3s 集群，权限与持久卷仍分开；不可信执行有独立安全边界
- **本地演示**：PGlite + ast-grep + 显式离线裁决 fixture，无需账号和云凭证
- **生产检测候选**：保留 OpenGrep/Semgrep 规则格式的适配边界；待真实案例验证后决定引擎，不把 ast-grep 演示等同于语义检测方案
- **按需扩展**：Go 类型规则、SCIP 索引、CodeQL、外部评审产品均由案例需求触发，不因工具存在就全部接入

官方 Codex SDK 提供 TypeScript 接口，可启动、继续和恢复本地 Codex thread。Agent 进程在自有 worker 中运行，模型调用仍属于外部服务；这两种部署边界应分别记录。来源：[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)。

pg-boss 是基于 PostgreSQL 的 Node.js 作业队列，适合复用现有数据库处理后台任务；队列重试不等于恢复任意 Agent 内存状态，也不替代外部评论的幂等核验。SeaweedFS 提供 S3 兼容存储，开源仓库使用 Apache-2.0，另有企业能力。它仍需容量、备份、恢复和版本兼容性验证，当前仅是候选。来源：[pg-boss](https://pgboss.io/)、[SeaweedFS](https://github.com/seaweedfs/seaweedfs)。

这里描述选型方向，具体实现与验证状态以 [实现契约](./implementation-contract.md) 和测试记录为准。设计约束见 [设计经验](./design-lessons.md)，实验与证据治理见 [评测研究](./evaluation-research.md)。

**学习评审偏好、从历史生成规则、使用 Skill 参与评审，都已有成熟产品覆盖。** 重建的价值应通过可检查的证据链和回放效果证明，不能把这些单项能力描述为独有创新。

## 二 购买 集成与自建的分界

| 方案 | 直接复用的能力 | 适用条件 | 需要承担的主要成本 |
| --- | --- | --- | --- |
| 购买 Qodo 自托管版 | 历史学习、规则管理、Skill 评审、上下文与 Git 集成的产品能力 | 逐项确认所购自托管版、模型接入和 k3s 部署满足硬约束 | 采购、部署依赖、功能一致性、版本与结果可导出性验证 |
| 采用 Kodus | 自托管评审平台、Memories、规则、Webhook、界面 | 希望拥有运行环境和源码，接受平台运维与许可证条件 | 较大的服务栈、升级、AGPL 与企业版边界 |
| 扩展 PR-Agent | Git provider、命令、模型适配、PR 内容处理 | 需要快速复用评审入口，领域核心独立 | 适配与上游兼容；仍需建立案例与回放体系 |
| 薄领域核心加成熟组件 | 保留证据和评测控制，替换扫描器与评审器 | 可控的耦合资产与历史验证是硬要求 | 领域模型、适用性判断、回放和晋升规则 |

**可以停止自建的条件**：一个可自行部署的现成产品在冻结的代表案例与后续实际评审中，满足团队的有效发现、误报负担、覆盖率、成本、隐私和治理要求；其模型接入也符合 Codex/OpenAI 的选择，且团队不需要掌握 detector 与测试的完整生命周期。此时为复刻平台功能维护另一套系统，收益很可能不足。仅有 SaaS 版本的方案不满足当前硬约束，只能作为获授权后的效果对照。

**值得保留自建的条件**：需要精确控制某条风险知识来自哪些案例；能够独立替换模型或扫描器；每次规则变更都必须在特定历史快照、反例与留出集上复验；希望输出可携带的 Skill、detector、fixtures 与证据 manifest。当前公开资料不能确认下列产品完整暴露这一资产契约。应向供应商验证，不能直接推断其内部没有实现。

采购或试用时重点问五个问题：

1. 是否能导出规则、来源案例、模型判定、反馈与完整版本，而不只有最终评论？
2. 是否能在指定的旧 commit 上执行冻结版本，并重放自己的 bug/fix 与负例集合？
3. 是否能接入或导出确定性 detector，并把其测试与语义规则绑定到同一版本？
4. 是否能区分人工真值、模型裁决、开发者行为和执行失败，并禁止未经验证的自动晋升？
5. 哪些服务、索引、日志、授权校验与存储仍依赖供应商？自托管版是否具备本次需要的学习功能，是否能使用指定的 OpenAI 模型与所需 Codex 集成？

## 三 完整评审产品

### Qodo 自托管版是有条件的商业替代

官方 Rule Miner 文档已经描述从历史评审中提取规则：使用被开发者采纳并引发代码修改的评论，结合代码所有权和重复模式，形成带路径范围和来源 PR 的规则；活跃规则产生的拒绝反馈会削弱其信号。当前标注为 Beta，支持范围包含 GitHub、GitLab 和 Azure DevOps。初始历史窗口约为最近 1,000 个已合并 PR。轻量评审、缺少被应用的建议，会导致很少甚至没有规则。这与本项目的稀疏反馈风险直接相关。来源：[Rule Miner](https://docs.qodo.ai/governance/rule-enforcement/rule-miner)。

Qodo 的 PR history indexing 持续分析相似问题的讨论与结果，以辅助判断新发现是否相关；该页面当前标注 GitHub、GitLab Beta。不同功能的 provider 支持要分别核验，不能用旧发布博客或某个功能的支持范围代替整体兼容性结论。来源：[历史索引](https://docs.qodo.ai/core-concepts/pr-history)。

Qodo 也把 `SKILL.md` 作为一等输入：可以抽取规则进行合规评审，也可以用完整 Skill 指导 Agent 如何阅读和检查代码；支持范围管理与活动统计。因此，Skill 作为知识载体本身已不足以构成差异。来源：[Skill 管理](https://docs.qodo.ai/governance/manage-skills-across-repositories)。

Qodo 官方提供在自有 Kubernetes 基础设施部署的 on-premises 路径。因此不能把 Qodo 整体归类为只能用 SaaS；但公开产品能力也不能自动视为所购自托管版本的完整功能表。k3s 兼容性、资源需求、外部依赖、Rule Miner/Skill 功能与 OpenAI 模型接入都需要逐项确认。来源：[自托管部署](https://docs.qodo.ai/on-prem/)。

**判断**：只有自托管版满足当前部署与模型硬约束、采购范围和实际效果时，Qodo 才可能直接替代大部分开发。若耦合 detector、原生测试、任意历史回放与可迁移证据也是硬要求，应先做接口和资产导出验证。本次未确认这些能力已作为公开契约提供，也未验证其实际精确率；Qodo SaaS 不列为默认部署方案。

### PR-Agent 适合复用入口 不承担知识核心

原 `qodo-ai/pr-agent` 已迁移到 `The-PR-Agent/pr-agent`。项目明确区分社区维护的 PR-Agent 与商业 Qodo；当前主分支使用 MIT 许可证。它提供 GitLab 等 Git provider、CLI、Webhook、自托管部署、LiteLLM 模型接入、评审命令与 PR 内容压缩。来源：[项目](https://github.com/The-PR-Agent/pr-agent)、[许可证](https://github.com/The-PR-Agent/pr-agent/blob/main/LICENSE)。

可将其作为评审入口或对照基线，但其公开主要契约仍围绕 PR 评审。不能默认它包含 Qodo 2.x 的 Rule Miner 或 Context Engine。压缩后的 diff 不宜成为历史案例的唯一证据；完整 before/after 快照与来源应由 FlyReWheel 保存。

当前应用方向是 TypeScript。仅为了复用 PR-Agent 而新增长期运行的 Python 服务，并非默认选择。先比较独立 CLI/服务适配的维护成本与小型 GitLab 集成；只有节省明确工作量时才接入，避免深度 fork。

### Kodus 是需要实际评估的开源平台

Kodus 提供可自托管的完整评审平台，覆盖 GitLab 等平台，并包含规则、Memories、Webhook、任务处理和界面。仓库当前将 Kody Memory 列为 Community 能力，Community 的 Kody Rules 有数量限制。模型与基础设施可控，但整体平台明显大于本项目的本地演示。来源：[项目与版本功能表](https://github.com/kodustech/kodus-ai)。

Memories 可从显式请求与对话中保存约定，按目录、仓库、组织应用，并可开启审批。需要注意其反馈能力的最新边界：官方明确表示 reaction-based fine-tuning 当前未启用，单独点赞或点踩不会训练模型、建立偏好聚类或改变下一次评审过滤。来源：[Memories](https://docs.kodus.io/en/knowledge_base/how-to-teach-ai-your-team-conventions)、[反馈边界](https://docs.kodus.io/en/how_to_use/code_review/learning/kody_learning)。

自动规则生成仍有效，但文档要求至少三个月 Kody 自身的评审历史，建议经过人工导入才生效。因此，它不能直接被视为对任意旧仓库历史的即用型冷启动矿工。来源：[自动规则生成](https://docs.kodus.io/en/how_to_use/code_review/learning/kody_rules_generation)。

许可证分为 AGPL-3.0 核心和商业企业代码；带 `.ee.` 文件名或位于 `ee/` 的代码不在 AGPL 覆盖下。应逐组件检查，不能因为源码可见就复制企业功能用于内部生产。来源：[核心许可证](https://github.com/kodustech/kodus-ai/blob/main/license.md)、[企业许可证](https://github.com/kodustech/kodus-ai/blob/main/license_ee.md)。

**判断**：Kodus 自托管版更接近当前部署约束。若其 OpenAI 接入、部署依赖与许可证条件均可接受，采用它可以避免重新开发界面、规则管理、评审工作流和记忆层。支持某家模型 API 不等于已经集成官方 Codex SDK；若 Codex 的执行方式是硬要求，仍需验证适配成本。若目标只是验证耦合回放资产，默认保留薄核心，减少额外服务。

### CodeRabbit 与 Greptile 用来检验差异是否真实

CodeRabbit 的 Learnings 是持久化自然语言偏好，支持仓库和组织范围、管理界面、审批延迟、CSV/JSON 导出。SaaS 上来自未合并 PR 的学习先约束在来源 PR，合并后才进入更广的检索。它们作为上下文或指令参与评审，公开契约不等同于编译出的静态规则；官方也提示指令冲突可能影响应用。来源：[Learnings](https://docs.coderabbit.ai/knowledge-base/learnings)。

Greptile 提供持续反馈学习、显式规则和跨仓库上下文；当前更新记录还包含从评论、回复、反应与提交中学习，以及用 TREX 在 sandbox 中生成并执行针对性测试。因此，反馈学习与生成测试也不能作为本项目独有能力。来源：[学习系统](https://www.greptile.com/docs/code-review/training-the-learning-system)、[官方更新记录](https://www.greptile.com/changelog)。

这两者用于检验产品差异，不能作为可随意嵌入的开源学习引擎。其 SaaS 服务不满足当前全部自部署的要求；企业自托管方案需另行核验。例如 Greptile 官方列出 Docker/Kubernetes 自托管路径，但这还不能证明所需学习功能、k3s 部署和 Codex 集成均满足要求。来源：[Greptile 部署选项](https://www.greptile.com/docs/introduction)。本次未验证具体自托管版本、私有仓库处理条款、计划额度或本项目数据上的质量，不据宣传指标做选型结论。

## 四 检测引擎与语言边界

| 组件 | 适合承担 | 不应假设的能力 | 当前定位 |
| --- | --- | --- | --- |
| ast-grep | AST 结构召回、代码片段定位、语法变换 | 类型、作用域、控制流、数据流或 taint 分析 | 本地可执行演示与语法型 Skill |
| OpenGrep | 多语言结构规则与部分 taint 检测 | 任意语言、跨文件、全程序语义证明 | 生产候选引擎 |
| Semgrep CE | 多语言规则、原生规则测试与确定性扫描 | Pro 的跨函数跨文件能力 | 与 OpenGrep 比较的可替换引擎 |
| go-ruleguard | Go 类型过滤与声明式定制规则 | 多语言通用语义层 | Go 案例确有需要时接入 |
| go/analysis | Go package、类型与 Facts 分析 | 自动得到完整跨过程检测器 | 少数深语义 Skill 的扩展点 |
| CodeQL | 深度数据流与自定义查询 | 私有代码免费任意使用 | 授权与收益成立后的可选后端 |

### ast-grep 的演示价值与明确限制

ast-grep 提供组合 AST 匹配、`valid`/`invalid` 测试和诊断快照；MIT 许可便于复用。本地演示采用真实 AST 引擎，比用正则模仿静态分析更能检验规则、候选与回放契约。来源：[原生规则测试](https://ast-grep.github.io/guide/test-rule)、[许可证](https://github.com/ast-grep/ast-grep/blob/main/LICENSE)。

但官方 FAQ 明确列出其不支持作用域分析、类型信息、控制流、数据流、taint 和常量传播。AST 中出现保护条件，不证明该条件在执行路径上支配危险操作；节点名相同也不证明符号相同。演示中的外层保护和业务条件需要额外证据与裁决，缺失时返回 Unknown。来源：[能力限制](https://ast-grep.github.io/advanced/faq)。

### 保留 OpenGrep 与 Semgrep CE 作为候选

OpenGrep 使用 LGPL-2.1，兼容 Semgrep 规则，输出 JSON/SARIF，并覆盖三十余种语言。当前 README 描述了 `--taint-intrafile` 的文件内跨方法 taint 改进。该能力值得测试，但不能扩写成所有语言完整跨文件分析；不同规则、语言和版本仍需案例验证。来源：[OpenGrep](https://github.com/opengrep/opengrep)。

Semgrep 官方比较页将 CE 分析限定为单文件、单函数。CE 引擎可用于项目特定规则，不应把通用 GitLab analyzer 的低收益推广成“Semgrep 引擎无用”。原问题可能同时来自规则不适用、扫描范围过小、上下文不足和反馈缺失。来源：[CE 能力边界](https://semgrep.dev/products/semgrep-vs-ce/)。

Semgrep 已有正例、负例、预期修复与规则校验机制，可以直接承接 detector fixture；不需要另写一套通用规则测试运行器。来源：[原生测试](https://docs.semgrep.dev/writing-rules/testing-rules)。

选择建议：用同一批历史 bug/fix、hard negative 和超时预算比较 OpenGrep 与 Semgrep CE，再固定引擎版本与配置。保留可替换的 JSON/SARIF 适配边界，初期无需同时跑所有引擎。

### Go 插件是专用扩展 不是系统语言约束

go-ruleguard 基于 `go/analysis`，支持声明式模式、类型过滤、修复建议与动态规则加载，并已有 golangci-lint 集成，使用 BSD-3-Clause。适合 Go 类型信息能明显消除歧义的规则。来源：[go-ruleguard](https://github.com/quasilyte/go-ruleguard)。

`go/analysis` 提供 package 分析、依赖 Facts、诊断和 `analysistest`。Facts 能传播跨包分析信息，但具体语义仍需实现。对复杂锁约束、包装函数或自定义资源协议，应复用分析接口，只补领域规则。来源：[官方 API](https://pkg.go.dev/golang.org/x/tools/go/analysis)。

golangci-lint 推荐 Module Plugin System，支持把本地或 Go module 中的分析器构建进自定义二进制；传统 Go `.so` 插件要求更严格的构建环境一致性。使用时固定 Go、依赖和 golangci-lint 版本。来源：[Module Plugin](https://golangci-lint.run/docs/plugins/module-plugins/)、[Go Plugin 限制](https://golangci-lint.run/docs/plugins/go-plugins/)。

golangci-lint 使用 GPL-3.0，独立运行、修改后分发与链接私有插件的许可评估应分别进行；不要推断整个检测目标仓库因此必须开源，也不要默认任何发布方式都无义务。来源：[许可证](https://github.com/golangci/golangci-lint/blob/main/LICENSE)。

TypeScript 是重建应用的实现语言，不代表只检测 TypeScript；历史语料以 Go 为主时可以先验证 Go，但 Case 和 Skill 契约应保留语言维度。

### CodeQL 的能力和授权要分开

CodeQL 的查询与库仓库使用 MIT，CLI/引擎采用独立条款。官方明确说明闭源代码分析需要适用的商业许可，不能将查询库开源推导为私有 GitLab 仓库可免费使用引擎。来源：[项目授权说明](https://github.com/github/codeql)、[CLI 条款](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md)。

其支持多个语言生态，部分分析路径需要代码提取或构建。仅在确有深数据流案例、适用授权、可复现构建与资源预算时加入；不作为第一阶段必选组件。来源：[提取与构建](https://docs.github.com/en/code-security/tutorials/customize-code-scanning/prepare-code-for-analysis)。

## 五 Git 上下文与结果集成

### Git 事实优先于 diff 文本

历史回放保存完整 before/after commit、parent、路径和内容哈希，再用 diff 定位变化。GitLab 的 MR diff API 有分页和大小限制，可能返回 `collapsed` 或 `too_large`。拿不到 diff 文本是覆盖不完整，不能静默当作没有代码变化。来源：[MR API](https://docs.gitlab.com/api/merge_requests/)、[diff 限制](https://docs.gitlab.com/administration/diff_limits/)。

PyDriller 可以复用提交、修改文件、before/after 源码、解析 diff 与方法信息；使用 Apache-2.0。它的方法提取依赖语言支持，merge commit 的修改列表可能为空，也不能判断提交是否真实修复了 bug。来源：[项目](https://github.com/ishepard/pydriller)、[ModifiedFile 语义](https://pydriller.readthedocs.io/en/latest/modifiedfile.html)。

当前 TypeScript 默认栈无需为此增加 Python 服务。优先调用受控 Git plumbing，加薄的 GitLab API 适配；若离线大规模挖掘能明显受益，再把 PyDriller 作为独立数据准备工具。评审讨论、issue 关联与采纳证据仍需 provider API，Git 库不能替代。

### 上下文索引按需求增加

SCIP 是语言无关的代码导航协议，支持定义、引用和实现关系，有多语言 indexer 及 TypeScript 等绑定，协议与仓库采用 Apache-2.0。可复用它组织跨文件上下文，不必从零设计符号索引格式。来源：[SCIP](https://github.com/scip-code/scip)。

但导航关系不等于完备调用图、数据流或业务契约。小型试验可先使用文件读取、搜索与语言工具；索引成本确实成为瓶颈时再增加 SCIP，并分别审查所用 indexer 的语言覆盖和许可。所有上下文必须绑定待评审 commit，避免拿主分支现状解释旧案例。

### reviewdog 负责投递 不决定真值

reviewdog 可把不同检测器输出转换成 GitLab MR discussion 等结果。默认 `added` 仅保留新增或修改行，也支持 `diff_context`、`file`、`nofilter`；GitLab reporter 对 diff 文件以外的位置存在限制，部分结果只输出到控制台。应为有影响但不能行内定位的问题保留明确的摘要或产物入口。来源：[过滤与 reporter 限制](https://github.com/reviewdog/reviewdog#filter-mode)。

它使用 MIT，可作为输出层。跨运行幂等、来源版本校验、审批和发布权限仍属于领域集成责任，不能因为评论工具成熟就跳过。来源：[许可证](https://github.com/reviewdog/reviewdog/blob/master/LICENSE)。

Danger 适合缺失迁移说明、伴随文件等确定性 PR 流程检查，使用 MIT，并支持 GitLab。若只需发布扫描结果，无需同时引入 Danger；它不提供历史知识学习或语义 detector。来源：[项目](https://github.com/danger/danger-js)、[GitLab 接入](https://danger.systems/js/usage/gitlab)。

### SARIF 是输出契约

SARIF 标准化静态分析结果，可表达规则、位置、指纹、相关证据和代码流，适合作为扫描器与平台之间的交换格式。来源：[OASIS SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)。

Skill、Case、反馈修订、晋升依据与回放分母仍存于领域模型。输出 SARIF 不代表已经建立完整知识谱系；建议通过稳定标识关联内部记录，避免把所有领域状态挤进扩展字段。

## 六 分析范围与通知范围分离

只检查 changed lines 会漏掉一类直接相关的问题：删除校验使未修改的危险操作失去保护；修改公共 helper 破坏未修改 caller；修改配置改变旧代码的执行前提。反过来，把全仓所有历史问题都发布到当前 MR，也会制造噪声。

建议按以下阶段处理：

1. **变化发现**：固定 base/head/merge-base，获取变化文件、函数、配置与依赖
2. **分析范围**：检查完整函数或文件；按规则需要扩展到 package、定义、引用与依赖闭包
3. **静态召回**：保留所有候选及扫描覆盖、解析错误、超时和跳过原因
4. **变化归因**：比较 base/head 发现，结合依赖变化判断问题是否由本次修改引入或暴露
5. **语义裁决**：检查适用条件、外层保护、例外、caller/callee、测试与业务证据；不足时弃权
6. **通知范围**：仅发布已经确认、可行动、与本次修改相关的发现；行内定位失败时进入摘要

这是本项目的设计建议，不是各扫描器已经自动实现的统一能力。第一阶段的全文件扫描至少避免把文件裁成 diff 碎片，但尚未解决所有跨函数与跨文件问题。

### 保留探索路径以测量漏报

静态召回之后再裁决，无法发现没有进入候选集合的缺陷。除主路径外，保留有预算的 exploration lane：

- 对少量完整变化函数或高风险区域执行无静态候选前提的 Agent 评审
- 回放已知历史漏报，记录漏在适用性筛选、detector 还是裁决阶段
- 抽样审查零候选的 MR，测量静态门槛造成的盲区
- 将新发现经人工确认后加入 Case 与测试，不能由探索 Agent 自授真值

探索结果进入相同的证据与发布门禁，并单独记录成本和边际收益。初期可以只作为离线评测，不立即扩大在线评论数量。

## 七 需要保留的领域核心

| 领域对象 | 最少内容 | 不能混淆的边界 |
| --- | --- | --- |
| Problem Case | bug claim、前后快照、来源、影响、根因、标签与置信度 | bug-fix 提交不天然等于已验证案例 |
| Semantic Skill | 风险不变量、前提、例外、适用范围、检查步骤、修复方向 | 自然语言约定不天然可被确定性检测 |
| RuleBundle | Skill、detector、正负例、上下文要求与版本 manifest | 修改任一成员需要新版本 |
| Finding | 候选来源、代码版本、证据、裁决、上下文缺口 | 静态匹配不自动等于 TP |
| Replay Run | 输入与工具冻结版本、各阶段状态、分母、耗时和成本 | 超时或解析失败不等于阴性 |
| Feedback | 来源身份、原始行为、解释、关联代码变化与修订链 | resolved、merge、沉默不等于修复或认可 |

“Skill 是母对象”意味着语义契约与证据决定检测实现，detector 是可替换、可测量的操作化部分。初期可让执行型 RuleBundle 要求 detector 与 fixtures 齐备；表达能力不足的知识保留为候选 Skill，不能为了通过打包规则而生成一个无意义 matcher。

晋升至少需要：已知正例在修复前命中、修复后符合预期、hard negative 不被误报、留出集不泄漏训练案例、执行错误单列。对 bug/fix 对的通过只证明这对样本，不证明泛化。模型裁决、人工真值与采纳行为分开统计，详细口径见 [评测研究](./evaluation-research.md)。

## 八 执行安全与许可检查

仓库源码、历史脚本、生成测试和生成插件都可能执行不可信逻辑。把只读挖掘、静态扫描、构建测试和评论发布拆成不同权限边界：

- 默认不执行仓库脚本，不给裁决 Agent 广泛 shell 权限
- 必须构建或运行测试时，使用自行部署的成熟隔离运行时；Worktree 只隔离文件状态，普通 k3s Pod 也不能直接当作恶意代码安全沙箱
- 使用临时、非特权环境，限制网络、时间、内存和输出；不暴露生产凭证或宿主 Docker socket
- 发布凭证不进入测试或生成插件进程；pg-boss 能持久排队并不代表 worker 能安全执行任意仓库代码
- 固定工具与依赖版本，记录扫描失败和覆盖范围，不自动把失败结果用于晋升

GitLab 官方说明非临时共享 runner 与 shell executor 可能让一个仓库的作业读取其他项目代码或窃取凭证。这些风险同样适用于历史回放。来源：[Runner 安全](https://docs.gitlab.com/runner/security/)。

只读 Git 操作也需要受控配置。`git diff` 可调用外部 diff helper 或 textconv，挖掘时应显式禁止非必要外部程序，并处理路径、子模块与符号链接边界。来源：[Git diff](https://git-scm.com/docs/git-diff.html)。

引擎与规则包分别审查许可证。OpenGrep 和 Semgrep CE 引擎采用 LGPL-2.1；现成规则不自动继承同样的使用边界。例如已归档的 `opengrep-rules` 带 LGPL-2.1 与 Commons Clause 条件。自产规则可减少依赖该规则包，但不能代替对引擎修改、链接和分发方式的审查。来源：[Semgrep 引擎](https://github.com/semgrep/semgrep/blob/develop/LICENSE)、[规则包许可证](https://github.com/opengrep/opengrep-rules/blob/main/LICENSE)。

私有仓库使用、内部部署、向客户分发二进制、提供网络服务是不同情形。选型时记录具体版本、依赖、修改方式与交付方式；对 GPL/AGPL、Commons Clause 和商业条款的适用结论应由合格法律人员确认。

## 九 验证顺序

1. **先固定案例**：用授权、可公开或新编写的代表性问题建立正例、修复例、hard negative 和缺上下文样本
2. **验证薄链路**：本地 ast-grep + PGlite 证明版本、证据、状态与回放契约，不声称验证了真实模型效果
3. **比较 detector**：在相同案例和预算下评估 OpenGrep、Semgrep CE 与必要的语言专用规则
4. **比较完整产品**：优先评估可自行部署的 Qodo 或 Kodus；先核验部署与模型约束，再在授权的相同任务上比较有效发现、噪声、漏报和人工处理负担
5. **决定保留范围**：若自托管产品满足硬约束与效果目标，缩减或停止自建；若关键资产不可控，仅补相应领域层
6. **验证自部署链路**：验证 Codex SDK、pg-boss、PostgreSQL 与 S3 适配的权限、重试、失败恢复、容量和保留策略，再验证 k3s 部署；不以依赖安装或 manifest 存在代替端到端验证

不建议先扩充规则数量或上线更多 Agent。先证明一条经过完整验证的 Skill 能在留出案例中稳定产生增量价值，再扩大语言、扫描范围和部署规模。
