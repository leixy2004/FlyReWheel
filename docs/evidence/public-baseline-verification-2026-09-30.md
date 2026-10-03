# 验证记录

验证日期：2026-09-30。以下结果针对本次交付代码；不等于已部署生产系统。

## 已实际运行

- TypeScript 全量类型检查通过
- Vitest：12 个测试文件、76 项测试通过
- 核心数据与 pg-boss 使用真正的嵌入式 PostgreSQL 引擎 PGlite，不是内存 Map 替代数据库
- 数据落盘后关闭/重开、版本冲突、并发晋升 CAS、反馈变化使旧审批失效、训练/holdout 隔离、永久产物引用均有测试
- 真正的 JS/TS/Python AST 解析与匹配、Unicode 行列/offset、语法恢复失败、候选来源校验均有测试
- Codex 与 OpenAI-compatible 使用 mock 验证 SDK 合约、显式认证模式、无静默 API 计费 fallback、缺证据 Unknown、无规则输出；没有真实模型请求
- 队列去重、明确重试参数、不可变新 attempt、配置变化、取消后继续剩余案例均有测试
- 生产编译路径与编译后离线 demo 通过：6 个合成案例、0 执行错误
- 30 份 YAML 文档通过语法和本地安全约束检查
- vLLM：5 组历史修复、10 份文件真实静态扫描，无解析错误；3 组 1→0，2 组 1→1，详见 [实验结果](../../experiments/vllm/RESULTS.md)
- 生产依赖的 npm audit 在本次查询时报告 0 个已知漏洞；这不是供应链安全保证

## 尚未运行或建立

- 用户 Codex 的目标环境登录、账户额度和真实推理
- 镜像构建、Kustomize 渲染、Kubernetes API/admission 校验、集群启动与网络策略实际执行
- 远程 PostgreSQL、多主机 worker 故障恢复、S3 后端条件写入与读回集成
- 节点故障、PVC 满盘、备份与灾难恢复演练
- vLLM 原生测试和 GPU 工作负载
- 真实独立语义回归集、人工标注评测、跨仓库泛化和 ROI

当前环境没有 Docker、kubectl、Kustomize 或 Helm。因此没有把 YAML 静态检查写成集群部署成功，也没有把 SDK mock 写成已连接 Codex。

## 外部副作用

没有部署资源、创建模型授权、读取/搬运认证令牌，或向 vLLM 发布任何内容。GitHub 源码上传仅按用户随后指定的个人仓库进行，结果以实际远端提交验证为准。
