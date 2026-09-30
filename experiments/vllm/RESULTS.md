# vLLM 第一轮静态回放结果

实验对象：[vllm-project/vllm](https://github.com/vllm-project/vllm)。本轮严格只读，没有发布 GitHub note、comment、Issue、PR 或 check status。

## 实际执行了什么

- 选择 5 组已经合并的历史修复，保存 merge parent 与 merged commit 的完整目标文件
- 保存相应上游许可证及来源证据；文件内容经过 Git blob ID 校验
- 使用 `@ast-grep/napi@0.45.3` 和官方 `@ast-grep/lang-python@0.0.6` 扫描完整文件
- 记录命中数量、代码位置、内容摘要和源 commit
- 对修复前文件添加无语义影响的注释，再确认结构匹配数量不变

```bash
npm ci
npm run experiment:vllm
```

完整机器可读结果：[static-replay-report.json](./static-replay-report.json)。输入和来源：[cases.json](./cases.json)、[SOURCE_NOTES.md](./SOURCE_NOTES.md)。

## 结果

| 历史修复 | 修复前命中 | 修复后命中 | 解释 |
|---|---:|---:|---|
| [#2570 max_tokens=None](https://github.com/vllm-project/vllm/pull/2570) | 1 | 0 | 为可选参数的数值比较加入 None 防护 |
| [#2664 Ray 调用分派](https://github.com/vllm-project/vllm/pull/2664) | 1 | 1 | 普通直接调用仍合法地留在 non-Ray 分支，必须检查支配条件 |
| [#8568 空 tools 的默认行为](https://github.com/vllm-project/vllm/pull/8568) | 1 | 0 | 区分 key 存在与实际有可用 tools |
| [#9034 零 token 的负切片](https://github.com/vllm-project/vllm/pull/9034) | 1 | 1 | 修复在切片前添加零值分支，切片本身仍然存在 |
| [#14352 top_logprobs=0](https://github.com/vllm-project/vllm/pull/14352) | 1 | 0 | 默认零值不应强制要求 logprobs 开启 |

共 10 份目标文件，无解析/执行错误；5 组检测数量与审查后的预期一致，全部通过注释扰动检查。PR #9034 这里只覆盖零 token 切片子问题，未覆盖它的全部修改。

## 这轮实验改变了一个验收条件

高召回静态检测器负责提名候选。修复可能改变外层分支、前置条件、生命周期或调用环境，而没有删除被匹配的语句。因此“修复后必须零静态命中”不能作为所有生成规则的硬性条件。

本实现据此修正了 synthesis 校验：

- 修复前完全无法召回候选时，生成的检测资产不通过当前静态验证
- 修复后仍有候选时，保留待审草稿，设置 `requiresSemanticValidation: true`
- 是否能正确排除这些修复后的候选，需要后续独立语义裁决验证
- 无论静态候选是否消失，都不能自动晋升生产规则

这保留了 Skill 的风险语义和例外条件，也避免为了追求静态 1→0 而过度收窄检测模式。

## 没有执行的部分

没有调用应用的 Codex 适配器，没有运行 vLLM 项目测试、GPU 推理、依赖安装脚本或原仓库代码。语义状态统一为 `not_verified`。

规则是根据这些公开修复材料编写的，已经看过修复结果。因此这是**种子样例回归**，不是时间隔离的 holdout，也不能报告成规则精确率、缺陷召回率、Codex 判断准确率或业务 ROI。公开历史数据还可能已进入模型训练语料；以后做模型评测时需要新的独立案例或前瞻 shadow 数据。

下一步：在你授权的目标 Codex executor 上，用每个独立快照单独构造证据包，不向裁决者提供 expectedBefore/expectedAfter 标签或另一侧快照；先验证 #2664、#9034 的修复后候选能否被正确排除。结果继续保留在私有报告，不发布到 vLLM。

已经提供对应的手动启动入口（本次未运行）：

```bash
# 先按 Codex 接入文档完成目标环境授权和 QE_* 配置
node --import tsx experiments/vllm/semantic-replay.ts --enable-model
```

该入口串行处理上述两组前后快照，把结果保存在被 Git 忽略的 `.flyrewheel/vllm-semantic/` 下。同一配置和 attempt 会复用已记录结果；修复失败原因后可用 `--attempt second` 建立新尝试。它不把 PR 标题、修复 diff、前后标签或另一侧源文件传给裁决者；规则本身仍来源于已知修复，因此不改变本轮回归性质。
