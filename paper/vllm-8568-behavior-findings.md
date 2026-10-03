# vLLM PR 8568：有界函数行为复现

**已执行的局部结果支持默认条件修复，也直接否定了两条过宽概括。** 在 35 个普通字典输入上，base 与 head 仅在“未指定 `tool_choice`，且 `tools` 为 null 或空列表”时产生不同结果。两个 `if/elif` 反事实变体与 head 的返回、异常和输入修改均相同，但确实改变了验证分支是否执行。

这是 [开发案例](developmental-case-vllm-8568.md) 的补充证据。范围限于 `ChatCompletionRequest.check_tool_usage` 的函数体；没有执行完整 Pydantic 请求模型、HTTP 接口或上游测试。它不提供模型审查效果、独立人类标签、规则历史修订或未来 PR 复用证据。

## 材料与复现

- 脚本：[reproduce-vllm-8568.py](reproduce-vllm-8568.py)
- 实际机器输出：[vllm-8568-behavior-results.json](vllm-8568-behavior-results.json)，包含全部 35 个输入、四个变体的返回或异常、调用后的输入及验证分支轨迹
- 本地唯一源码材料：`.flyrewheel/github-pr8568.json`，SHA-256 为 `4c153cd4bd2ef95db4be6d5f1185fc3559ffafaf7feb85df8e57ac549e1cc356`
- 运行时间：2026-10-02 UTC；CPython 3.12.14，isolated mode

从仓库根目录运行：

```sh
python -I paper/reproduce-vllm-8568.py > paper/vllm-8568-behavior-results.json
```

脚本只使用 Python 标准库。源捕获先验证原始包 SHA-256，再验证全部三份源码的字节长度、SHA-256 和 Git blob SHA-1。它对捕获模块只做 AST 解析，不导入或执行整个文件。实际执行的是人工转写并审阅的 48 行函数：运行前必须与捕获的第 380–427 行在去除四格类缩进后逐字一致，并通过 AST 比对。

适配仅去掉第 378–379 行的 `model_validator(mode="before")` 与 `classmethod` 装饰器和类缩进。函数名与 `(cls, data)` 签名保持不变，未使用的 `cls` 传入 `None`。执行环境只给该函数提供 `dict`、`isinstance`、`ValueError` 三个 builtin；函数仍对原字典进行修改。没有依赖安装、网络访问、外部仓库导入或未受信任 hook。

| 绑定对象 | base | head |
| --- | --- | --- |
| commit | `72fc97a0f100b92f1ff6c6a16e27d12f1c7569aa` | `eae161c33f47a0b760701769f56fc249563f8ed0` |
| `protocol.py` SHA-256 | `d3340fb8076b8e9f82a4d0546a845b615ffa79573f5ebf7f61f4cd85ca0671fb` | `54f985fd9d2dea5454e6dd1ea1ce48bda71e383e1fb15696aa4bb97160520369` |
| 捕获函数原始文本 SHA-256 | `ea498cddf4356aba7b18700387264d578f3614342c02c0f710a2006e0d886cec` | `4cf081c0ab5cb2c8ffacd7a77c92da5ad146dec558875b5915401a4da345e15b` |
| 去缩进、去装饰器后的文本 SHA-256 | `ad7c896fe0a28272d8de1785a5ed463ddf801150637e25a347b4a66c207d2414` | `5e7209d5e48ba628eb55c062074098129c2e0d17a6bc166c9571278ed04fc651` |

本次最终脚本 SHA-256 为 `7867c351b980805345e6ea17b037e4ba5be6f2a255624d07b18fdc682e04d415`；保存结果为 `244fa08967073de853e4b5e96c64a98f0d2ada92f6c680be45f7b021ee921aa9`。两次最终成功运行的 JSON 逐字一致。哈希只验证本地字节绑定，不认证 GitHub 历史事件；应用层 evidence digest 没有重算。

## 枚举输入与实际结果

输入为 5 × 7 的手工有限枚举：

- `tools`：缺失、`None`、`[]`、只含 `alpha`、包含 `alpha` 和 `beta`
- `tool_choice`：缺失、`None`、`"auto"`、`"none"`、指定 `alpha`、指定 `beta`、指定不存在的 `absent`

命名选择和工具使用普通 JSON 风格字典。每个调用获得独立深拷贝。以下表格归并了全部 35 个实际观察；“返回缺失”表示字典中仍没有 `tool_choice` key，**不表示已经执行字段默认值注入得到 `"none"`**。

| 选择输入 | tools 输入 | base 局部结果 | head 局部结果 |
| --- | --- | --- | --- |
| 缺失 | 缺失 | 返回缺失 | 返回缺失 |
| 缺失 | `None` | 先补 `auto`，再抛缺少 tools 的 `ValueError` | 返回缺失 |
| 缺失 | `[]` | 返回补出 `auto` 的字典 | 返回缺失 |
| 缺失 | 两种非空列表 | 返回补出 `auto` 的字典 | 相同 |
| `"auto"` | 缺失或 `None` | 缺少 tools 的 `ValueError` | 相同 |
| `"auto"` | `[]` 或两种非空列表 | 原样返回 | 相同 |
| `None` 或 `"none"` | 缺失或 `None` | 缺少 tools 的 `ValueError` | 相同 |
| `None` 或 `"none"` | `[]` 或两种非空列表 | 不支持选择值的 `ValueError` | 相同 |
| 三种命名选择 | 缺失或 `None` | 缺少 tools 的 `ValueError` | 相同 |
| 三种命名选择 | `[]` | 工具名不匹配的 `ValueError` | 相同 |
| 三种命名选择 | 两种非空列表 | 名字存在时原样返回，否则工具名不匹配的 `ValueError` | 相同 |

四个变体共执行 140 次调用，全部符合预先写入脚本的作者侧结果表。该数字是有限行为检查的调用数，不能作为 140 个独立真实案例、140 次上游测试通过或任何模型准确率。

## `if/elif`：观察到了控制流差异，未观察到结果差异

除 base/head 外，脚本执行了两个明确标注的反事实版本：

1. **head 的平铺 `elif` 变体**：只将第二个独立 `if` 改成 `elif`
2. **早期 hunk 的嵌套 `elif` 重建**：将默认分支改成嵌套 `if`，第二分支用 `elif`；前缀逐字绑定 [review 评论 1766097849](https://github.com/vllm-project/vllm/pull/8568#discussion_r1766097849) 的新增侧，验证后缀借用最终 head

第二个版本不是历史 commit `7aa40bf05fa7cc502c4648d89eeff26b8c97918e` 的完整恢复。其原始完整文件仍然缺失，借用最终后缀是显式假设。

两个变体各自与 head 比较，35 个输入中的返回值、异常类型及消息、输入修改和返回对象身份均无差异。用 `sys.settrace` 单独观察到：对“选择缺失 + 两种非空 tools”，head 进入验证体，两种 `elif` 版本跳过；这两个输入仍都返回补出 `auto` 的同一输入字典。

这组实验支持“reviewer 指出的控制流变化真实存在”，没有显示它在所枚举输入上构成可观察输出缺陷。它也不证明任意 JSON 输入、对象类型、历史早期函数或未来验证后缀的等价性。

## 被反例否定的过宽规则

1. **“只要局部接受 `auto`，tools 就必须非空。”** head 在 `tools=[]`、显式 `tool_choice="auto"` 时原样返回。非空限制属于本例的**默认推导条件**，不能推广到所有显式选择验证。
2. **“空 tools 下，省略选择和显式传 `none` 可以互换。”** head 对省略选择返回缺失 key，对显式 `"none"` 抛 `ValueError`。字段默认声明与显式输入的验证路径不能合并。

这些是对函数局部行为概括的实际反例，不裁定完整 API 应当采用哪种契约。脚本确认源字段默认声明是 `"none"`，但未模拟其注入，也未运行 `ChatCompletionRequest.model_validate`。

## 仍然未覆盖

枚举没有覆盖任意长度列表、所有名称、格式错误的工具或命名选择、自定义 mapping/对象、带副作用的真值判断、并发修改，以及 Pydantic 类型校验和其他 validator 的顺序交互。完整请求接受结果仍未验证。原 PR 新增测试文件只做字节校验，没有执行；这里的预期表由作者编写，不是独立人类标签。

可以将本次结果用作“源绑定的局部机制复现及规则边界反例”，不能升级为正式 benchmark、历史 correctness 标签、规则更新成功或 H1/H2 收益证据。
