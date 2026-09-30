# FlyReWheel 评测与证据基础设施选型

调研日期：2026 年 9 月 30 日。范围包括评测执行、实验比较、反馈、规则与证据版本、检索、隔离环境。本文是方案研究，未创建第三方账号、部署服务或运行性能实验；产品能力来自官方文档，推荐结论基于项目约束。

## 结论

按最新要求，基础设施全部自部署，优先集中在一个 k3s 集群。默认采用 **TypeScript 领域评测代码 + Vitest + promptfoo CLI + pg-boss worker + Postgres + 自托管 S3 兼容对象存储 + Git manifests**。初期不部署独立评测服务器，不依赖 Supabase Cloud、Trigger.dev Cloud、Langfuse Cloud 或 Braintrust 控制面。

“一个 k3s”指一个集群，不自动等同于一台物理机或高可用部署。下面的最小形态可以在单节点试运行；正式可靠性目标、机器数、磁盘布局与备份目的地需要明确。本项目允许外部模型，采用 OpenAI/Codex 路线，不使用 Claude Agent SDK。应用与数据基础设施自部署，模型通过已授权的外部服务调用；Codex 登录、可用模型及预算需按实际账户核验。

这一选择直接回应旧方案的失败条件：反馈稀疏、收益未证明、上下文不足导致误报、规则数量增长、429、隔离与存储运维负担。自部署方案应减少服务数量，并设置真实的磁盘容量与回收策略。初期只保留 Postgres 与一个对象存储两类有状态服务。MLflow、Phoenix、自托管 Langfuse 仅在明确需要时重新评估。

需要保留的自研范围是 FlyReWheel 的领域语义：Bug-Fix Pair / Problem Case、耦合的 Skill 与静态 detector、时间切分、证据完备性、TP/FP/Unknown/Disputed、反事实比较和新版本晋升。测试框架、评测矩阵、trace、通用标注界面、数据库和隔离运行时应复用成熟组件。

## 一 最小组件与职责

| 层 | 默认复用 | FlyReWheel 负责 | 暂不增加 |
| --- | --- | --- | --- |
| 确定性测试 | Vitest、扫描器原生测试命令 | 数据契约、版本绑定、状态流转、回放断言 | 自制测试运行器 |
| 语义回归 | promptfoo CLI | 领域评分函数、证据检查、真实应用适配器 | 自建 prompt 比较服务 |
| 长任务 | pg-boss 与 Postgres，worker 自部署 | 作业边界、幂等标识、预算与错误分类 | Redis 队列、外部调度 SaaS |
| 事实与版本索引 | 自部署 Postgres | Case、RulePack、Evidence、Decision、Run 的关系与约束 | 独立文档库、图数据库 |
| 大文件 | 自部署 SeaweedFS 或 Garage，统一 S3 接口 | 内容哈希、manifest、容量与备份策略 | 默认使用已停止维护的 MinIO CE |
| 规则审查 | Git | Skill、detector、fixtures 与适用条件的绑定 | 自建包注册中心 |
| 检索 | SQL、全文检索，按需 pgvector | 适用性过滤、召回测量、版本可见性 | 默认独立向量数据库 |
| 可观察性与人工标注 | 初期结构化运行记录和本地报告；需要时选一个自托管平台 | 最终裁决、争议处理与审计 | 外部控制面、并行部署多个平台 |
| 不可信执行 | k3s Job 与成熟隔离 runtime | 输入、出口、资源与凭证限制 | 自研 microVM 控制面 |

这张表表达职责边界，不代表已完成部署验证。先验证 k3s/containerd 对所选隔离 runtime 的支持、所需系统依赖和磁盘故障行为。pg-boss 可在 Node.js 中复用 Postgres 队列，不需要额外队列数据库；其交付或重试语义不能保证外部模型调用、文件上传等副作用全局恰好一次，应用仍需幂等键与持久结果身份。来源：[pg-boss 官方仓库](https://github.com/timgit/pg-boss)。

### 单个 k3s 的最小拓扑

建议从四类常驻工作负载开始：

1. TypeScript app：HTTP/API 和必要的审阅界面
2. TypeScript worker：运行 pg-boss、评测与产物编排，可与 app 使用同一镜像、不同启动入口
3. Postgres：应用表与队列表分 schema/权限管理，向量检索按需启用 pgvector
4. S3 backend：初步倾向固定版本的 SeaweedFS `weed mini` 单进程形态；Garage 为更窄 S3 能力的替代

回放时创建临时 sandbox Job。备份/维护使用有限数量的 CronJob，不常驻额外业务服务。初期不增加 Redis、ClickHouse、独立向量数据库或评测平台服务器。镜像、Git 仓库与认证优先复用现有自部署设施；“使用 Git manifests”不代表必须再部署一套 Git 托管平台。

单实例 Postgres 和单实例 S3 的故障会阻塞系统，worker 必须退避并保留任务身份；这只是最小可恢复形态，不是 HA。一个集群可以有多个节点：真正需要节点容错时，再根据 RPO/RTO 加跨故障域副本和成熟 operator。备份至少有一份位于不同物理故障域的自有设备；同一宿主机上的另一个 PVC 无法覆盖整机或整盘损坏。

## 二 Vitest 与 promptfoo 的组合

### Vitest 覆盖确定性领域逻辑

Vitest 支持 TypeScript、异步测试、mock、快照、并发、超时及 CI 分片。适合验证：

- RulePack 中 Skill、detector、测试与适用范围能否绑定到同一版本
- 缺少 caller、配置或外层 deadline 时能否保留 Unknown
- 同一回放输入、版本与配置能否生成一致身份标识
- 429、构建失败、超时是否被保留为执行错误，而非业务阴性
- 标签修订是否产生新记录，旧实验能否继续引用原标签快照
- 同一候选的重复上报能否幂等处理，是否正确关联独立评审

Vitest 的进程/测试环境隔离用于减少测试相互影响；不应将它当作运行恶意代码的安全沙箱。完整仓库回放应由领域任务调用 sandbox，Vitest 测试该任务的契约和代表性集成路径。来源：[Vitest 功能](https://vitest.dev/guide/features.html)。

### promptfoo 覆盖语义与模型配置比较

promptfoo 提供配置化测试矩阵、确定性与模型评分、重复运行、缓存、并发限制、超时和结果导出，核心使用 MIT 许可。可直接用于比较 adjudicator 的 prompt、模型和证据组织方式。来源：[配置参考](https://www.promptfoo.dev/docs/configuration/reference/)、[断言](https://www.promptfoo.dev/docs/configuration/expected-outputs/)、[许可](https://github.com/promptfoo/promptfoo/blob/main/LICENSE)。

推荐让 promptfoo 调用实际 TypeScript 应用接口，确保评测使用与产品一致的上下文构造、SDK 配置和返回结构。官方已有 OpenAI Codex SDK provider；也支持 TypeScript custom provider。内置 provider 是否覆盖所需的 hooks、权限、工具集合和 session 行为，仍需做小型兼容性验证。若不足，只写薄适配器调用已有应用，避免复制另一套 agent 实现。来源：[OpenAI Codex SDK provider](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/)、[TypeScript provider](https://www.promptfoo.dev/docs/providers/custom-api/)。

对独立 holdout，默认每案新建 Codex thread 和干净工作区。promptfoo 的 `persist_threads` 按 prompt 模板和配置复用线程，不按每个渲染后的变量值隔离；开启后可能让不同案例共享历史，污染评测。JSON schema 返回值仍需显式解析和校验。必须固定实际模型请求、sandbox/network 配置和 SDK/provider 版本。来源：[Codex provider 的线程与输出边界](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/)。

建议分成三个执行层次：

1. **每次变更**：Vitest 与扫描器 fixtures，主要为确定性测试
2. **语义配置变更**：promptfoo 跑固定校准集，比较标签、证据引用、拒判率、成本和稳定性
3. **规则版本晋升**：自部署 worker 执行冻结的完整 temporal replay，产生规范结果与指标；promptfoo 报告可作为其中一个产物

promptfoo 的内部数据库、缓存或本地报告都不应成为唯一证据库。将规范结果、输入 manifest、配置哈希与失败日志保存到领域存储中。不要只保留一个平均分或一张截图。

## 三 评测平台能力与自部署适配

引入条件应是已经存在明确的协作需求：多人需要持续查看 trace、对同一案例评分、比较实验、查阅修订历史，现有产物审阅方式成为瓶颈。当前只考虑满足自部署要求的形态；以下保留各产品的比较与排除理由。

### Langfuse

**可复用能力**：OTel tracing、SDK experiments、自定义 item/run evaluator、prompt 管理、人工 annotation queue、dataset item 版本。它已经具备评测执行能力，不能简单归类为只有日志的工具。SDK evaluator 在实验进程中执行，不是生成代码的隔离运行环境。来源：[实验 SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk)、[人工队列](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues)。

Dataset item 的新增、更新、删除和归档会形成时间版本；dataset schema 变更不在该版本机制内。仍需单独冻结 schema、判定 rubric 和证据 manifest。来源：[dataset 版本](https://langfuse.com/docs/evaluation/experiments/datasets)。

核心产品能力使用 MIT 许可，部分企业管理功能另有商业许可。自托管涉及 Postgres、ClickHouse、Redis/Valkey 和对象存储；虽然能部署进同一个 k3s，却明显增加状态服务和运维。初期不采用；以后确需其 UI，再评估自托管形态，并保留独立领域事实库。Cloud 不满足当前部署约束。来源：[许可边界](https://langfuse.com/handbook/chapters/open-source)、[架构](https://langfuse.com/handbook/product-engineering/architecture)。

### Braintrust

**产品能力**：版本化 dataset、experiments、tracing、人工审阅与数据整理。本轮保留能力比较，但其默认托管形态不符合当前要求。来源：[datasets](https://www.braintrust.dev/docs/guides/datasets)、[标注](https://www.braintrust.dev/docs/annotate)。

自托管属于 Enterprise 选项，主要托管自己的 data plane；UI、认证和控制面仍由 Braintrust 提供。Data plane 包括 Postgres、Redis、对象存储和 Brainstore。因此它的 self-hosting 不等于一套可独立运行的全开源平台。该托管控制面使它无法满足当前“全部自部署”的硬约束，本轮排除。来源：[自托管范围](https://www.braintrust.dev/docs/admin/self-hosting)。

### MLflow

MLflow 的强项是实验、产物、代码/模型/人工评分以及 Python 工作流，核心为 Apache-2.0。现有 Python/ML 平台已使用它时值得复用；当前 TypeScript、最小 k3s 拓扑无需因此新增 Python 服务。来源：[架构](https://mlflow.org/docs/latest/self-hosting/architecture/overview/)、[反馈模型](https://mlflow.org/docs/latest/genai/concepts/feedback/)、[许可](https://github.com/mlflow/mlflow/blob/master/LICENSE.txt)。

两项边界尤其重要：

- 文档中的 `get_dataset(version=...)` 不可变 dataset 版本读取仅适用于 Databricks；OSS 的 `merge_records` 会对相同输入合并或更新 expectations 和 tags
- 当前 OSS review queues 标为 experimental，共享队列中首个完成的评审可将任务对整个团队标记完成，不自动满足独立多评审和争议裁决要求

来源：[API 范围](https://www.mlflow.org/docs/latest/api_reference/python_api/mlflow.genai.html)、[OSS dataset 更新](https://mlflow.org/docs/latest/genai/datasets/sdk-guide/)、[review queues](https://www.mlflow.org/docs/latest/genai/assessments/review-queues/)。

### Phoenix

Phoenix 支持 OTel/OpenInference、code/LLM evaluator、datasets、experiments 和 annotations；dataset 记录变更有版本，单应用配合 SQL 数据库的部署较紧凑。但新增服务仍有运维成本，不列入当前默认栈。来源：[dataset 版本](https://arize.com/docs/phoenix/learn/datasets-and-experiments/datasets-concepts)、[evaluator](https://arize.com/docs/phoenix/evaluation/concepts-evals/evaluators)、[部署](https://arize.com/docs/phoenix/self-hosting/deploying-phoenix)。

当前 Phoenix server 使用 Elastic License 2.0。内部自托管可用，对向第三方提供托管服务有限制。不能笼统将其描述为与 Apache/MIT 等价的无限制开源依赖；需要按拟使用方式核对许可。来源：[实际 LICENSE](https://github.com/Arize-ai/phoenix/blob/main/LICENSE)。

## 四 不可变证据与规则版本

### 领域对象

建议保留以下独立对象。它们是设计建议，不是某一平台自动提供的模型。

- **Case**：问题、来源、修复前后提交、时间与 bug lineage；问题描述与事后结论分开
- **RulePackVersion**：Skill、detector、fixtures、适用条件、所需上下文、生成来源及工具版本
- **EvidenceBundle**：实际读取的文件/符号/调用关系/配置、缺失项、运行输出与内容哈希
- **RunManifest**：冻结的输入、RulePack、模型、检索配置、rubric、环境与预算
- **Judgment**：某个人或模型的原始判断、理由、证据引用与来源
- **Adjudication**：按指定 rubric 对已有判断作出的裁决，保留 supersedes 和争议关系
- **PromotionProposal**：新版本及对应的实验差异、已知退化、审批状态

原始 judgment 和最终 adjudication 不能合并成一个可覆盖字段。纠错产生新版本；旧实验继续指向当时使用的标签快照。模型重复同意自己不能替代独立证据。

### Git 与对象存储的分工

Git 保存可审查的文本与 manifest；自部署对象存储保存仓库快照、日志、大型证据包及报告。内容使用哈希身份，执行引用具体 commit/digest。`latest`、`production`、版本名等可以移动，不能作为唯一复现标识。Git 的内容对象与 OCI descriptor 可提供基础引用机制，但业务审批、可见时间和保留策略仍需领域约束。来源：[Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)、[OCI descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md)。

Postgres 与 S3 兼容对象存储各自保存元数据和字节，跨系统没有自动原子事务。建议先上传内容寻址对象、校验成功，再提交引用 manifest；未被引用的临时对象进入带宽限期的 GC，不能因上传重试而产生多个语义不同的“相同版本”。应用写入凭证与删除/维护凭证分离，避免普通 worker 修改既有证据。

内容哈希、追加式记录和受控覆盖属于应用层不可变约束，不自动构成 WORM。确需 Object Lock 时，必须核验所选服务与版本的具体支持、权限旁路和删除行为；默认不作合规级不可变存储承诺。

Postgres 备份不包含独立 S3 中的证据文件。对象存储的 metadata snapshot 也不包含全部对象数据。至少分别保存数据库、对象字节、对象存储元数据与配置，并演练从空环境恢复。副本、防 bitrot 的 scrub、同步镜像和备份解决不同故障；会同步误删除的镜像不等于带历史保留的备份。

初期无需同时引入 DVC、OCI RulePack registry 和数据库内的第四套版本系统。大型数据需要频繁跨机器 checkout 时再评估 DVC；独立 worker 需要标准化分发 RulePack 时再评估 ORAS。来源：[DVC 元数据](https://doc.dvc.org/user-guide/project-structure/dvc-files)、[ORAS](https://oras.land/docs/)。

### 自托管 S3 候选核验

以下状态核验于 2026 年 9 月 30 日，部署时仍要固定 release/image digest 并跑兼容性与恢复测试。

| 候选 | 发布与许可 | k3s 形态 | 本项目判断 |
| --- | --- | --- | --- |
| SeaweedFS | Apache-2.0；官方仍发布二进制/镜像；调研时最新 release 为 4.48 | `weed mini` 可单进程运行；官方 Helm 是另一条多组件部署路径 | 单节点原型优先验证，需控制暴露端口、维护任务和容量 |
| Garage | AGPLv3；官方提供 release binaries/镜像；2.4.1 发布于 2026-09-08 | 官方仓库有 Helm chart，无外部数据库依赖 | 简洁，但缺 S3 versioning/Object Lock；生产应有冗余 |
| MinIO CE | AGPLv3；官方仓库于 2026-04-25 归档并标记停止维护 | 历史 chart/image 不能视为持续更新的发行渠道 | 新方案不默认采用；AIStor 是另外的产品与许可选择 |

来源：[SeaweedFS 仓库与许可](https://github.com/seaweedfs/seaweedfs)、[releases](https://github.com/seaweedfs/seaweedfs/releases)、[Garage 官方 releases](https://garagehq.deuxfleurs.fr/_releases.html)、[Garage LICENSE 镜像](https://github.com/deuxfleurs-org/garage/blob/main-v2/LICENSE)、[MinIO 官方归档状态](https://github.com/minio/minio)。

**SeaweedFS**：官方将 `weed mini` 定位为单进程、小型部署方式，包含 master、volume、filer、S3 及维护组件；单 master 不具备 HA。其默认值可能随 release 变化，因此固定版本和关键参数。官方 Helm 提供分开的 master/volume/filer/S3 部署，不应把 `helm install` 宣称为只有一个 S3 Pod；若选择 mini，在项目部署清单中直接包装已有官方镜像即可，无需编写存储引擎。必须设置认证，只暴露所需 S3 接口，管理、filer 和内部 RPC 端口留在受限网络。来源：[mini 运行边界](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini)、[官方 Helm recipes](https://github.com/seaweedfs/seaweedfs/wiki/Helm-Chart-Recipes)。

SeaweedFS 有 bucket quota，但官方流程要求定期执行 quota enforcement，不能当作零延迟硬磁盘限额。生命周期支持对象过期、旧版本清理和未完成 multipart 清理；逻辑删除后通常仍需 vacuum 才释放磁盘。新容量预算要为并发上传、执行周期和 compaction 留余量。来源：[quota](https://github.com/seaweedfs/seaweedfs/wiki/S3-Bucket-Quota)、[lifecycle 与磁盘回收](https://github.com/seaweedfs/seaweedfs/wiki/S3-Lifecycle)。

备份方面，`filer.backup` 可持续镜像或按日期增量保留变更；增量模式不传播源端删除。filer metadata 需另行保护。要验证数据、元数据和凭证配置能一致恢复，不能只截取正在写入的若干目录。来源：[数据备份](https://github.com/seaweedfs/seaweedfs/wiki/Async-Backup)、[元数据备份](https://github.com/seaweedfs/seaweedfs/wiki/Async-Filer-Metadata-Backup)。

**Garage**：官方提供单二进制、自包含设计和仓库内 Helm chart。官方单节点 quick start 明确没有冗余，不建议直接作为生产方案；若只有一台宿主机，多个 Garage Pod 也不能提供整机故障保护。来源：[自包含设计](https://garagehq.deuxfleurs.fr/documentation/reference-manual/features/)、[官方 Kubernetes guide](https://garagehq.deuxfleurs.fr/documentation/cookbook/kubernetes/)、[单节点警告](https://garagehq.deuxfleurs.fr/documentation/quick-start/)。

Garage 支持 bucket 大小与对象数量配额，生命周期仅覆盖部分 S3 操作，如 Expiration、AbortIncompleteMultipartUpload；没有 S3 bucket versioning 和 Object Lock。应用层内容寻址可以满足基本证据引用，但不能因此宣称具备存储级 WORM。来源：[官方 CLI 源码](https://github.com/deuxfleurs-org/garage/blob/main-v2/src/garage/cli/structs.rs)、[S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)。

Garage 的自动 scrub 校验数据块；metadata snapshot 是完整元数据副本，不包含对象数据，并且会额外消耗磁盘。快照和多副本仍需配合独立、带保留策略的备份。来源：[durability 与 snapshot](https://garagehq.deuxfleurs.fr/documentation/operations/durability-repairs/)。

**MinIO**：本次没有验证旧镜像是否还能拉取，不能据此断言某个 tag 必然可用。可以确认官方社区仓库已停止维护，历史发行说明已改为 source-only，并说明 legacy binaries 不再更新。因此不将旧 Docker Hub tag、第三方重打包或旧 Helm chart 当成默认维护方案。来源：[归档 README](https://github.com/minio/minio)、[最后的社区发行说明](https://github.com/minio/minio/releases)。

### 防止再次填满磁盘

1. **不要把 PVC 声明容量当硬配额。** K3s 默认使用 Local Path Provisioner，数据位于节点本地；Rancher 官方 README 明确其容量限制不受支持、会被忽略。要隔离故障，应使用独立数据盘/分区或真正执行容量限制的 CSI/filesystem。来源：[K3s storage](https://docs.k3s.io/add-ons/storage)、[Local Path Provisioner 限制](https://github.com/rancher/local-path-provisioner)。
2. **分别量测物理容量。** 监控系统盘、Postgres/WAL、对象数据、元数据、容器镜像缓存、Pod 日志、临时仓库与 inode，不能只看 S3 逻辑对象字节。
3. **作业开始前做容量 admission。** 以已占用量、运行中任务的保留预算、预计产物和维护余量计算是否启动；到高水位停止接收新回放，保留读取、裁决与清理能力。阈值由实际磁盘和最大并发测量确定，不在尚无机器参数时虚构固定 GB 数。
4. **限制单次工作量。** 设仓库检出大小、最大日志/输出、单个 artifact、multipart、运行时长和并发上限。为临时目录设置适用的资源限制，完成后核验清理；Pod ephemeral-storage 限制不替代持久卷的配额。来源：[Kubernetes 资源管理](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)。
5. **区分保留类别。** 已晋升 RulePack、封存 holdout、最终 adjudication 和关键证据长期保留；可重建缓存、失败临时目录和冗余 trace 设短期 TTL。不能让统一 bucket expiration 删除仍被有效 manifest 引用的证据。
6. **观察实际回收。** lifecycle 成功、对象删除和物理空间释放分别量测；SeaweedFS 保证 vacuum 有余量，Garage metadata snapshots 也应有保留上限。删除操作只能按明确的 artifact 分类和保留策略执行。
7. **备份自身也要有容量约束。** 备份不只写回同一磁盘。若启用 Postgres WAL archiving，归档故障会持续堆积 WAL，最终可能导致数据库停机；需要归档延迟与可用空间报警。来源：[Postgres continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html)。

最小上线门槛应包括：容量超限时拒绝新作业、单对象超限、上传中断、节点重启、S3 暂时失联、对象缺失、备份损坏及空环境恢复。优先验收这些行为，再考虑添加存储副本、完整观测栈或多租户复杂策略。

## 五 检索先使用 Postgres

几千条规则不足以单独证明需要专用向量数据库。优先复用已有 SQL 和全文检索；语义检索有价值时再使用 pgvector。

检索顺序建议：

1. 语言、框架、API、tenant/repository、规则适用条件等硬过滤
2. 只允许使用评测截止时间前可见的规则和证据
3. 精确符号/路径/关键词召回，与语义相似召回合并
4. 记录候选及排序，单独测量检索召回率

先建立过滤后精确相似搜索基线，再决定是否建立 HNSW/IVFFlat。pgvector 近似索引的过滤发生在索引扫描后，可能返回不足数量的候选；iterative scans 能缓解，但存在扫描上限。应在真实的过滤分布下测 recall 和延迟。来源：[pgvector filtering](https://github.com/pgvector/pgvector#filtering)。

Qdrant 具备 payload index 和多阶段 dense/sparse 查询。当量测证明向量吞吐、过滤检索或独立扩容成为瓶颈时，可以进入比较。它不应仅因“规则很多”而成为首期必选。来源：[payload indexing](https://qdrant.tech/documentation/manage-data/indexing/)、[hybrid query](https://qdrant.tech/documentation/search/hybrid-queries/)。

必须拆开三个指标：**规则检索召回、静态 detector 召回、最终确认问题的召回**。少检索一些规则可能减少告警，却同时漏掉问题，不能据此宣称整体精度提升。

## 六 静态规则测试与回放复用

### 扫描器自己的测试先用起来

Semgrep 已提供正例、反例、已知失败标注和 autofix 的 expected-output 测试。`todoruleid`、`todook` 不会使测试失败，因此报告“全部通过”时仍要单列这些已知缺陷。CodeQL 则提供 query test database 和 `.expected` 结果测试。来源：[Semgrep testing](https://docs.semgrep.dev/writing-rules/testing-rules)、[CodeQL testing](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/scan-from-the-command-line/test-custom-queries)。

扫描引擎的能力必须按实际 edition 核验。Semgrep CE 的分析范围有限；跨文件/调用方条件不能由一条局部匹配自动证明。应选择合适引擎或显式收集额外证据，并将无法判断的情况保留。来源：[Semgrep edition 边界](https://docs.semgrep.dev/semgrep-pro-vs-oss)。

### SWE bench 可借鉴运行机制

SWE-bench 的执行方式包括固定仓库状态、应用 patch、运行测试和保存逐实例产物，可作为 replay 设计参考。但其评测对象是修复 patch，FlyReWheel 还要评估 detector 和 Skill，因此需要领域适配。来源：[SWE-bench harness](https://www.swebench.com/SWE-bench/guides/evaluation/)。

文档中一个值得直接防范的陷阱：SWE-bench 按 run_id 与 instance_id 缓存结果，prediction diff 改变也可能沿用旧结果。FlyReWheel 的缓存键必须包含所有影响结果的内容和配置；不同实验版本不能意外共用旧缓存。来源：[result caching](https://www.swebench.com/SWE-bench/guides/evaluation/#result-caching)。

## 七 如何证明闭环收益

### 时间切分与泄漏防护

以下属于实验设计建议，不能靠购买评测平台自动获得。

- 以时间与 bug lineage 切分，同一问题的回退、backport、重复补丁和近似版本放在同组
- 分开规则开发集、judge 校准集和封存的最终 holdout；反复根据 holdout 调参会使它退化为开发集
- 冻结检索语料可见时间，阻止后续修复、评论、事后总结和标签进入被评测系统
- 模型输入与 evaluator-only 的 gold patch、修复后测试分开管理；模型可访问哪些信息应写入 manifest
- 时间切分只能控制 FlyReWheel 自己的数据泄漏，不能抹除基础模型对公开代码历史的预训练记忆；需加入真正前瞻的私有/shadow 样本

公开基准也存在 ground truth 与污染风险。OpenAI 在 2026 年对 SWE-bench Verified 的审计指出测试与规格问题以及解答污染，并停止将其作为 frontier coding 进展指标。此结论支持重新审视评测质量，不能直接外推为所有仓库回放都无效。来源：[原始审计](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)。

### 反事实比较

建议在相同案例、模型、上下文预算、工具权限和裁决 rubric 下执行 2×2 ablation：

| 条件 | Skill | Detector | 要回答的问题 |
| --- | --- | --- | --- |
| 基线 | 关闭 | 关闭 | 原始模型/应用的能力 |
| Skill only | 开启 | 关闭 | 语义经验的增量 |
| Detector only | 关闭 | 开启 | 静态召回的增量 |
| 组合 | 开启 | 开启 | 两者结合的收益与交互 |

比较单位以案例/bug family 为主，避免将同一个问题的多个告警计为多个独立成功。重复生成需要使用独立运行标识并明确缓存策略。对随机性给出配对差异和不确定性，按仓库或问题族检查收益是否集中。

修复前命中、修复后不命中只是一项有用的变形测试。还要加入安全近似代码、替代正确修复、调用包装变化、配置差异和回归测试。局部消警可能由删除代码、改变格式或规则漏检引起，不能直接当作因果证明。

### 指标与样本

至少报告：

- 可评测案例数、无法执行比例、证据不足比例
- 检索召回、静态召回、最终 bug-level recall
- 独立确认告警中的 precision、Unknown 和 Disputed 比例
- 相对基线新增确认问题数，以及原本能发现但新版本漏掉的问题
- 人工审查分钟数、每个新增确认问题的模型与运行成本
- 延迟、429、重试、构建失败与 sandbox 不兼容比例

仅收集愿意反馈的用户会产生选择偏差。除优先审查低置信和争议案例，还需从正常结果、无告警样本中进行有记录的抽样。没有反馈应保留为未观测，不能记为 TP 或安全。没有独立标签的总体，也不能直接宣称全量 recall。

## 八 裁决与运行状态分开

**运行状态**记录 completed、rate-limited、build-failed、timed-out、unsupported、cancelled。**裁决状态**记录 TP、FP、Unknown、Disputed。两者不能混为一个 pass/fail 字段。

- **TP**：依据指定问题定义与足够上下文，确认候选问题成立
- **FP**：已有足够反证，确认该候选在当前上下文中不成立
- **Unknown**：证据不足、适用前提未建立或环境阻止核验
- **Disputed**：有效评审之间存在尚未解决的实质分歧

运行失败可以导致当前无法裁决，但必须保留根因，不计为阴性样本。争议保留各方判断、证据和 rubric 版本，由明确流程产生后续 adjudication。

对于“局部函数没有 timeout，但外层已经有保护”的旧误报，需要检查相关 caller、middleware、deadline/cancellation 传播与配置。读不到这些内容时，应输出 Unknown 并列出缺失证据；看见外层 timeout 后仍要确认其覆盖关系与语义，才能形成 FP。不能把局部未看见保护直接升级为全系统没有保护。

## 九 429 与可恢复运行

promptfoo 已提供并发、间隔、重试等执行控制，可用于减少单个评测进程的限流。其 provider 文档也说明了 transient rate limit 的处理方式。跨多个任务与 worker 的共同 provider quota，需要放在主方案的任务/配额层统一处理。来源：[配置](https://www.promptfoo.dev/docs/configuration/reference/)、[provider 重试](https://www.promptfoo.dev/docs/providers/openai/)。

建议明确一个主要重试责任层，避免 SDK、评测器和任务平台各自独立重试造成次数相乘。把 429 与余额不足、权限错误、模型不支持等错误分开；记录总尝试次数、实际花费和最后错误。只能对可恢复错误退避重试，并设置任务预算与最终停止条件。恢复时复用已完成的内容身份，避免重新支付整批推理费用。

## 十 隔离环境选择

Docker 提供可复现的依赖与文件系统环境。普通容器共享宿主内核，不适合被误认为任意生成程序或未知仓库构建脚本的最强隔离边界。gVisor 的 `runsc` 兼容 OCI，并通过应用内核增加隔离；Firecracker 使用 microVM，但需要管理 KVM、网络、镜像和 jailer。来源：[Docker security](https://docs.docker.com/engine/security/)、[gVisor](https://gvisor.dev/docs/architecture_guide/intro/)、[Firecracker host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)。

当前选择 k3s 中的临时 Job，搭配经过验证的 gVisor RuntimeClass 或同等级自部署隔离方案。仅有 namespace、Pod 或 Job 并不能增加到独立内核边界；若无法正确配置成熟 sandbox，应先限制为可信 fixtures，不执行未知构建脚本。gVisor 的系统调用兼容与性能需要用目标仓库验证。来源：[gVisor production tradeoffs](https://gvisor.dev/docs/user_guide/production/)。外部 managed sandbox 不属于当前方案。

无论采用哪种 runtime，都需要：临时工作区、只读输入、无宿主 Docker socket、无环境默认凭证、CPU/内存/PID/时间/输出上限、限制网络出口、按 digest 固定镜像。下载依赖与执行不可信测试尽量分阶段；确认所需依赖后，不继续开放无限制网络。

pg-boss 与 Kubernetes 负责排队和调度，不自动保证生成代码的安全隔离。Vitest、promptfoo 的测试执行功能也不自动提供这一边界。需要从具体 sandbox 文档与实际权限配置验证。

## 十一 开工前的最小验证清单

在正式实现前，先确定以下验收条件。这里只定义验证任务，不代表已经运行。

1. 选一个完整 bug-fix pair 和安全近似反例，能够固定仓库、依赖、工具与规则版本
2. 同一 TypeScript 应用既能由自部署 worker 调用，也能由 promptfoo adapter 调用，不复制 agent 逻辑；模型 endpoint 只使用已明确允许的部署方式
3. Vitest 能覆盖 Unknown、Disputed、429、超时、重复写入和标签修订的领域契约
4. evidence manifest 能定位全部产物，缺失对象能被发现；数据库与对象文件分别具备恢复方案
5. 有独立评审可以仅凭保存的证据理解裁决；需要补证时能够记录，不被强迫输出二元结论
6. 能产出同一冻结集上的配对基线差异、运行失败率和成本，而非只展示“生成了多少规则”
7. 完成磁盘水位暂停、清理、备份恢复、断电/重启和对象缺失演练；只有当实验比较或标注操作成为明确瓶颈时，才评估增加一个自托管平台

最终默认保持 **Vitest 管确定性契约，promptfoo 管语义配置比较，pg-boss worker 管执行，Postgres 与自部署 S3 管证据，Git 管审查与版本**。后续替换某个工具时，Case、RulePack、Evidence 和 RunManifest 的身份与历史应继续成立。
