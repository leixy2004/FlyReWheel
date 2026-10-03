# 单命令本地闭环

`closed-loop demo` 把已有 PR 证据、候选规则、语义审查、精确反馈、修订生成、同快照对照和本地决策串成一次可重复运行。它使用真实 Git、ast-grep、PGlite，以及已安装的 Codex SDK 的受监督 worker 路径；所有模型输出、语义判断和 TP/FP 反馈均为明确编写的 fixture。

**这是一条本地功能验收入口。没有真实模型推理、GitHub 网络请求、开发者反馈、账号授权、生产后端配置或规则激活。两个场景不计入实证效果。**

## 运行

环境要求：Linux、Git、Node.js 22+。本次实际验证使用 Node.js 24.19.0；工作区进程监督目前只支持 Linux。已有依赖时无需重复安装。

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
node dist/cli.js closed-loop demo --out-dir .flyrewheel/closed-loop
```

源码入口等价：

```bash
npm run cli -- closed-loop demo --out-dir .flyrewheel/closed-loop
```

输出 JSON 同时写入 `.flyrewheel/closed-loop/report.json`。数据库默认保存在输出目录的 `db/`，也可以指定独立、非重叠的本地数据库目录：

```bash
node dist/cli.js closed-loop demo \
  --out-dir .flyrewheel/closed-loop-external-db \
  --db .flyrewheel/closed-loop-db
```

PGlite 仅支持这里的单进程本地用法；每个输出目录使用独立数据库，不要同时从其他目录或 CLI 进程打开同一个数据库。

输出目录必须为空，或属于同一版本、同一数据库的本演示。程序不会覆盖无关文件、重置已有仓库、删除失败工作区或改用生产模型。没有 `--enable-model` 参数。

2026-10-02 的精确安全锚点更新改变了 fixture review 的身份；随后诊断算子更新也改变了修订 worker 的 prompt、schema 和候选记录。已有旧版输出应保留用于查看；运行当前版本时请使用新的输出和数据库目录，例如 `--out-dir .flyrewheel/closed-loop-operators-v2`。旧目录可能因不可变 artifact 不一致而拒绝续跑，不会被覆盖。

## 预期结果

成功退出码为 `0`，报告包含：

```json
{
  "status": "succeeded",
  "stage": "complete",
  "mode": "authored-fixture-only",
  "modelExecution": "not_run",
  "isolation": "not_verified"
}
```

两个独立修订候选的预期结果：

- `compatible`：`preserved: 1`、`corrected: 1`、`regressed: 0`，本地 fixture 决策为 `accept`
- `regressed`：`corrected: 1`、`regressed: 1`，尝试 `accept` 被现有门禁拒绝，随后保存 fixture `reject`
- 两者 `activation: not_performed`；人工 verdict 保持 `Unknown`
- `checks.reopenedIdentically: true`：关闭数据库后重新打开，逐条重读并校验 28 个持久化记录
- `artifacts` 列出 33 份 JSON 的相对路径、SHA-256、字节数和关联记录身份

这里的保留和修正计数来自两个**精确反馈位置**。历史挖掘来源案例保持 `expected: unknown`，不会凭 fixture 将它们改成正确性标签，也不会自动添加 regression cases。受控场景只验证数据流和门禁。

## 具体链路

1. 在 `repository/` 中建立固定内容、固定提交日期的三个真实 Git 提交：历史问题、历史修复、后续目标变更
2. 冻结历史 base → fix 的源码与 Git blob，构造显式合成的 GitHub PR 证据格式，保存两个 unknown 来源案例
3. 调用已有 authored-test mining adapter，验证结构化提案及引用，保存带精确历史来源的语义规则候选。挖掘 prompt 不含后续目标源码
4. 冻结 fix → target；真正执行 ast-grep，命中无保护正例和有保护负例各一次，再通过显式 offline fixture 作语义判断
5. 保存绑定准确 review、rule digest、finding 和源码位置的 fixture TP/FP 反馈
6. 分别创建 compatible / regressed 修订请求，通过 `generateRuleRevision`、可信运行时能力及 worker 的 `rule-revision-v2` 输出契约保存候选；新候选受 `diagnosis-operators-v1` 结构约束。生成仍使用固定 authored CLI，不调用模型
7. 使用相同目标快照审查两版规则，调用已有 comparison / decision API 推导结果，验证回退拒绝和零激活
8. 关闭再打开 PGlite，重读所有关联记录，校验内容和摘要后才写成功报告

挖掘候选的 `synthesis: not_run` 与 `source: fixture` 如实保留。修订候选包含实际本地 worker 执行收据，`modelExecution` 仍为 `not_run`。生成收据的执行时间、工作区 attempt 和本地路径因首次运行而异；Git 提交、规则、review、comparison 和决策身份由固定输入确定。

旧 `rule-revision-v1` 候选及收据仍按原 schema／prompt 重建和读取，不追授新策略保证。v2 的允许算子、无修改结果及其验证边界见[修订生成契约](rule-revision-generation.md)；既有闭环运行记录不自动覆盖这次策略扩展。

## 查看证据

```bash
node -e 'const r=require("./.flyrewheel/closed-loop/report.json"); console.log(JSON.stringify({status:r.status,evidence:r.evidence,outcomes:r.outcomes,checks:r.checks},null,2))'
```

报告的 `evidence` 和 `outcomes` 中有完整摘要与 ID，可继续用已有 CLI 查看，例如：

```bash
RULE_DIGEST=$(node -p 'require("./.flyrewheel/closed-loop/report.json").evidence.baseRuleDigest')
node dist/cli.js rules show --digest "$RULE_DIGEST" --db .flyrewheel/closed-loop/db
node dist/cli.js revisions comparisons --db .flyrewheel/closed-loop/db
node dist/cli.js revisions decisions --db .flyrewheel/closed-loop/db
```

重点文件：

- `historical-snapshot.json`、`historical-pr-evidence.json`、`mining-request.json`、`mining-source-before.json`、`mining-source-after.json`
- `authored-mining-response.json`、`mined-candidate.json`、`base-rule.json`
- `target-snapshot.json`、`base-structural-review.json`、`base-fixture-review.json`、`positive-feedback.json`、`negative-feedback.json`
- `compatible-*`、`regressed-*`：请求、authored response、生成候选及收据、规则、review、comparison、decision

以上文件均位于输出目录的 `artifacts/`。`repository/.sandcastle/` 保留已清理工作区的身份与清理证据；`runtime/` 保留明确的 authored executable 和 worker 请求。它们只包含本演示 fixture。

## 重跑、故障与恢复

直接重复同一条命令：

```bash
node dist/cli.js closed-loop demo --out-dir .flyrewheel/closed-loop
```

重跑重新检查 Git 与快照，复用并重新验证不可变记录和已有生成收据。成功时返回相同报告，不重复生成工作区，不改变旧反馈、请求或规则。最初的 Git acquisition 时间保留；重新核验不会伪造一份更早的收据。

出现错误时退出码为 `1`，标准输出不返回成功结果。已经进入执行阶段的运行会将 `report.json` 原子替换为 `status: failed`，记录失败阶段、错误和已完成产物。阶段操作复用现有事务，但整个闭环不是一个跨 Git、文件和数据库的大事务；之前成功的不可变记录会保留供检查，不能把部分数据当成完整成功。

- 普通中间步骤失败后，可在解决问题后重跑；已成功的生成候选会复用
- 产物内容被改动时会拒绝继续，不自动覆盖；恢复原文件后可重跑
- `history.json` 缺失但仓库已存在时，保留现场并要求检查或使用新的输出目录
- `.running` 表示另一进程正在执行，或上次进程被直接终止。先确认没有活跃进程并检查现场，再手动处理遗留锁；程序不自动抢锁
- 运行时停止、清理或工作区身份无法验证时，按收据和工作区检查命令恢复；不会自动清除 lease 或删除失败证据
- 若输出目录、数据库或并发锁校验在执行前就失败，已有报告保持原样；命令仍返回非零，不能把旧报告当成本次结果

原有 source-split / holdout 防护仍生效：预先登记为 holdout 的反馈来源会阻止修订生成；生成消费过的源码也不能换 ID 后重新登记成 holdout。

## 下一步边界

真实仓库输入继续使用 [PR 采集与证据](github-pr-evidence.md)、[挖掘提案接口](pr-mining-model-boundary.md)、[语义审查接口](semantic-review-model-boundary.md)和[反馈驱动修订接口](rule-revision-generation.md)。本命令只接受固定演示场景，没有把任意外部数据转换成“已验证”的捷径。

真实 PR 观察、实际模型推理、真实开发者反馈、受保护评测和生产晋升仍需分别授权与验证。报告的 `pendingProduction` 明确列出这些缺口。已有 vLLM 捕获数据与回放结果独立保留，不把本演示的固定反馈附会为真实开发者意见。
