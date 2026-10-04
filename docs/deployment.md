# 将 FlyReWheel 部署到一个 k3s 集群

静态复核日期：2026-10-04；源码基线为 PR #24 `b3cb77a70ddc406eba2d521eda68a43016ab5100`。当前交付是可审查的容器构建与 Kustomize 清单，**本轮未构建或推送队列服务镜像，也未连接真实集群**。独立 workspace 镜像试验不等于这些清单已部署。应用、pg-boss、PostgreSQL 和 S3 存储可以放在自己的同一个 k3s 集群；Codex 模型推理可以在外部运行。没有 Redis、Claude SDK、托管任务平台或必须购买的云端基础设施。

## 1. 先选部署路径

- `deploy/base`：单 worker、内部健康服务、独立 Codex 状态 PVC 与默认拒绝网络策略。连接运营者已经部署的 PostgreSQL；默认关闭模型与 S3 上传
- `deploy/overlays/single-node-dev`：在 base 上增加单实例 PostgreSQL、SeaweedFS `mini` 和输入/结果 S3 上传。仅供私有开发验证，模型仍关闭
- `deploy/components/model-egress`：单独选择的外部 HTTPS 出站权限，不会登录账户，也不会启用推理
- `deploy/examples/secrets.example.yaml`：只有 Secret 名称与所需字段说明，没有任何值或令牌，也不被其他清单自动应用

**单节点、单磁盘不是高可用。** Dev overlay 没有数据库 TLS、对象存储 TLS、自动故障转移或备份控制器。长期使用应以 CloudNativePG 和 SeaweedFS 官方 chart 管理有状态服务，再复用 base 应用清单。不要把开发模板改名后当成生产方案。

## 2. 镜像与本地检查

Dockerfile 用官方 `node:22.23.3-bookworm-slim` 两阶段构建：锁文件安装依赖、编译 TypeScript、复制 SQL migration，然后移除开发依赖。运行层额外安装 Debian 官方 `ca-certificates` 与 `git`，分别支持 HTTPS 信任和只读 Git 证据提取。运行入口为 `node dist/worker.js`；源码环境仍使用 `npm run worker`。镜像运行用户为 UID/GID 10001，应用代码和依赖归 root 所有，运行用户不可改写。`.dockerignore` 使用白名单，仅允许构建需要的源码与清单，排除 `.env`、认证、研究材料和宿主机依赖。

版本 tag 不是不可变 digest；在自己的镜像仓库中核验目标架构、扫描镜像并记录 digest 后再用于生产。当前依赖含原生 ast-grep 与 Codex runtime，推荐先验证 Linux amd64 或 arm64；不要把某个平台的 `node_modules` 直接复制到另一个平台。[Node 官方镜像清单](https://github.com/docker-library/official-images/blob/master/library/node)

本仓库内可离线执行：

```sh
npm ci
npm run typecheck
npm test
npm run demo
node deploy/validate.mjs
npx --no-install tsc -p deploy/tsconfig.build.json
mkdir -p dist/storage/migrations
cp src/storage/migrations/*.sql dist/storage/migrations/
node dist/cli.js demo
```

有容器工具后，由运营者进行镜像阶段验证：

```sh
docker build -t flyrewheel:dev .
docker run --rm --network none --read-only --user 10001:10001 \
  --tmpfs /tmp:rw,nosuid,mode=1777,size=1g \
  --tmpfs /home/flyrewheel:rw,nosuid,uid=10001,gid=10001,size=64m \
  flyrewheel:dev node dist/cli.js demo
```

第二条是无数据库服务、无模型、无网络的编译产物烟测，不启动 worker。单节点 k3s 可以由运营者把此镜像导入该节点的 containerd；多节点要在每个可调度节点提供相同镜像，或使用自己的可信 registry。镜像发布和实际部署是独立步骤，本次没有执行。

## 3. 部署前准备与渲染

确认目标集群与 namespace、StorageClass、可用磁盘、架构和实际镜像引用。k3s 常见的 `local-path` 是节点本地存储，本清单显式引用它；若集群没有该 StorageClass，需改为已验证的类。PVC 进入 `Pending` 时先检查 provisioner、节点与存储事件，不能靠提升 Pod 权限解决。

清单设置受限 Pod Security、`RuntimeDefault` seccomp、非 root、禁止权限提升、丢弃全部 Linux capabilities，并禁用 service-account token。没有 HostPath、Docker socket、集群角色或控制面凭据。Namespace 的安全标签会影响该 namespace 中所有 Pod，应为此应用使用专用 namespace。

在有 kubectl 的受信任工作站上先渲染，不执行应用：

```sh
kubectl kustomize deploy/base > /tmp/flyrewheel-base.yaml
kubectl kustomize deploy/overlays/single-node-dev > /tmp/flyrewheel-dev.yaml
```

检查展开后的镜像、namespace、网络策略、PVC、资源与 Secret 引用。需要支持 Kustomize `Component` 的 kubectl/Kustomize；若版本过旧，升级到集群支持的客户端，不应手工忽略组件。

Dev 路径需运营者用已批准的秘密管理流程准备以下资源；不要把密码放进 Git、命令行历史或聊天：

- `flyrewheel-runtime`：`DATABASE_URL`，连接 host `flyrewheel-postgres`、port `5432`、database/user `qual_evo`，密码与数据库 Secret 一致。URL 中密码须正确编码。该开发端点没有 TLS
- `flyrewheel-postgres`：非空 `POSTGRES_PASSWORD`
- `flyrewheel-s3`：非空 `AWS_ACCESS_KEY_ID` 与 `AWS_SECRET_ACCESS_KEY`

示例 Secret 的 `data: {}` 只是字段契约；直接应用它们不会得到可用凭据，缺键将阻止相应容器启动。不要使用空密码，否则 SeaweedFS 可能进入允许所有访问的开发模式。Kubernetes Secret 的 base64 编码不是加密；集群静态加密、RBAC、审计与备份访问由运营者管理。本次未修改这些安全设置。

准备好后，由运营者按所选路径执行；以下是步骤说明，不表示已部署：

```sh
kubectl apply -f deploy/base/namespace.yaml
# 通过已批准的流程在 flyrewheel namespace 中创建上述 Secret
kubectl apply --dry-run=server -k deploy/overlays/single-node-dev
kubectl diff -k deploy/overlays/single-node-dev
kubectl apply -k deploy/overlays/single-node-dev
kubectl -n flyrewheel rollout status deployment/flyrewheel-postgres --timeout=300s
kubectl -n flyrewheel rollout status deployment/flyrewheel-s3 --timeout=300s
kubectl -n flyrewheel rollout status deployment/flyrewheel-worker --timeout=300s
```

如使用 registry，在自己的 overlay 中以 `images` 设置 worker 的 `newName` 和 `digest`，不要依赖 `flyrewheel:dev` 作为生产版本。私有 registry 的拉取凭据由运营者按授权流程提供，仓库不保存。

## 4. 数据库和 S3 的真实行为

Dev PostgreSQL 使用官方 `postgres:17.11-bookworm`，沿用官方 entrypoint，数据目录为 `/var/lib/postgresql/data/pgdata`，Unix socket 与临时文件有独立可写 `emptyDir`。`POSTGRES_USER=qual_evo` 创建的是**开发超级用户**，不能沿用作生产最小权限账号。密码/初始化变量只在空数据目录第一次初始化时起作用；改 Secret 不等于轮换数据库中已存在的密码。[官方镜像说明](https://github.com/docker-library/docs/tree/master/postgres)、[已核对的镜像版本](https://github.com/docker-library/official-images/blob/master/library/postgres)

当前 worker 启动会校验领域迁移历史，只执行尚未应用的 SQL；pg-boss 独立管理队列表。因此首次启动或升级时所提供角色仍需相应 DDL 权限。旧版本无迁移账本的数据库须先按[迁移与旧库接管流程](database-migrations.md)备份、审查并显式接管，不能直接重放全部 SQL。生产应规划独立迁移步骤、数据库角色和授权；当前实现只有一个显式 `DATABASE_URL`，不能宣称运行时与迁移账号已经拆分。pg-boss 与领域事实共用 PostgreSQL，不需要 Redis。

Dev SeaweedFS 使用固定 `chrislusf/seaweedfs:4.48` 与已核对的官方命令 `weed mini -dir=/data`。清单直接调用 `/usr/bin/weed`、以镜像的非 root UID 1000 运行，关闭不需要的 WebDAV、Admin UI、Iceberg/Lance 端口。单进程内部以 loopback 通信，仅为 S3 的 8333 端口建立 ClusterIP 服务和访问策略。Master/Filer 内部监听不向其他 Pod 放行。必填的环境凭据启用 S3 身份验证，`S3_BUCKET` 在首次启动准备 `flyrewheel-artifacts` 桶。[官方 mini 文档](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini)、[4.48 命令源代码](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/command/mini.go)、[4.48 镜像定义](https://github.com/seaweedfs/seaweedfs/blob/4.48/docker/Dockerfile.local)

Dev overlay 显式设置：

- `QE_S3_ENABLED=true`
- `QE_S3_ENDPOINT=http://flyrewheel-s3:8333`
- `QE_S3_BUCKET=flyrewheel-artifacts`
- `QE_S3_REGION=us-east-1`
- `QE_S3_ALLOW_INSECURE=true`，仅此隔离开发路径允许 HTTP
- worker 的 `QE_S3_ACCESS_KEY_ID`、`QE_S3_SECRET_ACCESS_KEY` 分别引用 S3 Secret 中对应键

启用后，**legacy replay handler** 上传有大小上限的任务输入和最终结果，按内容 hash 寻址，使用条件写入，并在重复冲突时读回验证。当前 application handler 不调用这条 S3 上传路径；不能据此声称 workspace application 的输入、输出或冻结证据已经归档。领域记录仍保存于 PostgreSQL；这不是数据库备份。S3 adapter 不创建 bucket，接已有自托管 S3 时必须预先准备桶。生产要启用经过证书验证的 HTTPS，并按实际目标 namespace、Pod 标签和 TLS 端口调整出站/入站策略；不要照搬开发 HTTP 例外。限制 worker 凭据到所需 bucket/prefix 的读写，不授予对象存储管理权限。

SeaweedFS 的 TCP 探针只确认端口，不证明签名、条件写入和持久化正确。首次上线必须用真实 S3 集成测试核验 Put/Get、重复 If-None-Match、错误凭据被拒绝、重启后校验和一致。当前没有在容器或集群完成这些测试。

## 5. Codex 账号只在目标环境授权

默认 `QE_ENABLE_MODEL=false`；部署、启动和离线 fixture 任务不应自动触发推理。账户状态 PVC 是**可写、专属、持久化**的 `/codex-home`，为了保留 Codex 自己刷新后的状态。它不是凭据分发机制：不要把别的机器的 `auth.json` 复制进镜像、Secret、对象存储、CI 或多个 Pod。[官方账号自动化边界](https://learn.chatgpt.com/docs/auth/ci-cd-auth)

以下配置只适用于 legacy replay 的 `configuredCodex(environment, job.modelConfig)`。它不会调用 `startConfiguredWorkerService`，也不会为 workspace application 注入 resolver、运行后端或 lifecycle authority；后者继续 `blocked`。

启用账号路径时：

1. 确认是可信私有 runner，允许所选代码和证据发送给外部模型服务
2. 在自己的 overlay 中显式加入 `../../components/model-egress`，或换成已验证的更严格 egress proxy/CNI 策略；保持 `QE_ENABLE_MODEL=false`
3. 由用户在目标 worker 环境自行完成官方 device login。下列命令需要用户亲自运行、在官方页面批准；本项目不会代为创建授权或修改账号设置

```sh
kubectl -n flyrewheel exec -it deployment/flyrewheel-worker -- \
  env CODEX_HOME=/codex-home /app/node_modules/.bin/codex \
  -c 'cli_auth_credentials_store="file"' login --device-auth

kubectl -n flyrewheel exec deployment/flyrewheel-worker -- \
  env CODEX_HOME=/codex-home /app/node_modules/.bin/codex login status
```

4. 在自己的 ConfigMap patch 中设置 `QE_CODEX_AUTH_MODE=account`、`QE_CODEX_HOME=/codex-home`、账户实际支持的 `QE_CODEX_MODEL`，最后显式设置 `QE_ENABLE_MODEL=true`
5. 审核后应用并重启 worker，使环境变量更新生效；用一条获准发送的合成样例测试，而不是直接送入整个私有仓库

Dedicated home 只用于登录和 SDK 自有状态，不应存放个人 `config.toml`、MCP server、插件、hooks 或项目指令。当前 adapter 会拒绝不在允许范围内的文件名；若 CLI 新版本新增状态文件，应先审查并更新兼容测试，不要绕过校验。PVC 应只有此可信 runner 能挂载。底层存储需支持 `fsGroup` 权限处理；不支持时由运营者选择兼容存储或安全地预置目录，不要添加 root/privileged init container 来掩盖问题。

保持 `replicas: 1` 和 `strategy: Recreate`。replay 与 application 使用两个独立 queue/group（`codex-personal-serialized` 和 `workspace-application-serialized`），各自设置 `localConcurrency: 1`、`groupConcurrency: 1`；这不保证两类任务合计并发为 1。当前 application 被阻断，也不能作为未来显式启用后的跨队列串行保证。`ReadWriteOnce` 只表示单节点挂载模式，**不保证同一节点只能有一个 Pod 使用它**；不能靠 PVC 访问模式代替串行与 runner 生命周期约束。不要配置 HPA，不要另开一个持有同一认证状态的 model CLI/worker，不要在强制删 Pod 后未确认旧进程停止就启动第二份。每次请求仍可建立独立 Codex thread。[SDK/认证说明](./codex-integration.md)

API key 是另一条显式选择，有独立 API 计费。base 没有挂载 `QE_CODEX_API_KEY`；如另行授权采用 API 模式，运营者才添加所需 Secret 引用、选择 `QE_CODEX_AUTH_MODE=api`。登录失效、额度耗尽或服务故障都不应自动切换计费方式。

`QE_MODEL_TIMEOUT_MS=120000` 限制单次调用等待；`QE_MODEL_TOKEN_ACCEPTANCE_LIMIT=30000` 是完成后的 token 验收门槛，不是供应商侧支出上限。队列并发也不是 token 速率或账号额度保证。

## 6. 网络和执行边界

Base 在专用 namespace 默认拒绝 ingress/egress，显式允许匹配 CoreDNS Pod 的 TCP/UDP 53 和 worker 到同 namespace、带 `flyrewheel.io/role=postgres` 标签 Pod 的 5432。健康端口仅对标记 `flyrewheel.io/health-client=true` 的同 namespace Pod 放行；没有 Ingress、NodePort 或 LoadBalancer。健康服务不是提交任务的公共 API。

- 标准 Kubernetes NetworkPolicy 是 L3/L4 控制，不能按 OpenAI 域名或 TLS 证书过滤
- 可选 model-egress 允许公网 IPv4 的 TCP 443，并排除常见私网、loopback 和链路本地地址；它是**较宽的公网 HTTPS 端口许可**，不是 OpenAI-only allowlist，也不提供应用层审计
- 如实际 Pod/Service CIDR 不在已排除范围内、使用 IPv6、NodeLocal DNS、跨 namespace 数据库或 HTTPS 代理，需按实际网络修改并测试，不能简单删除默认拒绝策略
- k3s 的 NetworkPolicy controller 必须启用；使用自选 CNI 时确认有且只有匹配的策略实现。节点/宿主流量和集群管理员访问不属于完整 Pod 隔离边界
- 健康检查、网络可达性、证书信任、数据可出站授权分别核验。Codex 的 `read-only` sandbox 和 `networkAccessEnabled=false` 不替代集群网络策略

依据：[k3s networking](https://docs.k3s.io/networking/networking-services)、[Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)。

此 worker 只使用可信安装的 detector/SDK，不是运行任意代码的沙箱。不要在持有数据库、S3 或 Codex 状态的 Pod 里执行仓库安装脚本、测试、生成命令或 Docker 构建。后续需要此能力时，应采用单独 Kubernetes Job、经过验证的隔离 runtime、独立身份与无敏感挂载的工作区；普通 namespace 或 Git worktree 不构成这类隔离。

## 7. 容量、生命周期和恢复

初始资源是保守起点，需负载测试调整：worker request 250m CPU/512Mi，limit 2 CPU/2Gi；Postgres request 250m/256Mi，limit 1 CPU/1Gi；SeaweedFS request 250m/512Mi，limit 2 CPU/2Gi。临时磁盘各有 request/limit，worker `/tmp` 最大声明 1Gi，临时 home 64Mi。合计限制可以超出小节点实际空闲资源，不等于节点一定承受得住；k3s、内核、镜像缓存和其他工作负载仍需额外余量。

PVC 分别声明 Codex 1Gi、Postgres 10Gi、SeaweedFS 20Gi。**local-path 的 PVC 容量请求不等于文件系统硬配额**；`emptyDir.sizeLimit` 和 ephemeral-storage 也依赖 kubelet 计量/驱逐行为，不等于同步阻止所有超额写入。SeaweedFS 单 volume 大小参数不是总容量上限。监控真实剩余磁盘、inode、WAL、对象增长、session 缓存、容器日志和镜像缓存，预留恢复/升级空间。[local-path 限制](https://github.com/rancher/local-path-provisioner)

当前 worker 优雅停止最多等待 150 秒，Pod 提供 180 秒退出宽限。排空前停止投递新任务，观察活跃任务与 SIGTERM 行为；强制终止时可能重跑当前阶段，不能声称 agent 进程逐步 checkpoint 或模型计费 exactly-once。pg-boss 的 retry/heartbeat 负责任务生命周期，永久领域身份和内容摘要负责业务去重。不要把队列短期保留当成审计归档。

健康探针的边界：`/healthz` 检查进程响应；`/readyz` 基于 worker 初始化、停止状态和观测到的队列错误。它不是完整的持续数据库/S3/模型依赖探测；服务 Ready 也不证明某个模型或 S3 签名可用。监控还应覆盖队列 backlog/最老任务年龄、失败与重试、磁盘、数据库连接、对象错误、Pod 重启、备份年龄和恢复结果。

### 备份必须分开覆盖

- PostgreSQL：生产使用 CloudNativePG 的官方支持版本及 Barman Cloud Plugin 路线，配置 base backup、WAL archive、保留期和定期恢复；备份目标可以是自己维护的独立 S3/设备
- 对象：另行备份或复制 `flyrewheel-artifacts` 及必要元数据，核对 hash；数据库备份不会包含对象内容
- 配置/秘密：保存可重建的部署版本，并使用单独受控的秘密恢复流程；Codex 认证到新环境时优先由用户重新授权，不把认证当作普通产物备份

**放在同一节点、同一块磁盘或同一故障域里的备份不算灾备。** 至少有一个离集群、独立设备上的可恢复副本；不要求使用商业公有云。备份计划应声明 RPO/RTO、责任人、保留窗口、密钥保护和恢复演练记录。[CloudNativePG 安装](https://cloudnative-pg.io/docs/1.28/installation_upgrade/)、[备份与恢复入口](https://cloudnative-pg.io/docs/1.28/backup/)、[SeaweedFS 官方项目与 Helm 入口](https://github.com/seaweedfs/seaweedfs)

先在隔离 namespace/新存储恢复数据库与对象，校验关联记录和内容 hash，再用模型关闭的任务做回放。模拟 worker 中断并检查重复/重试，最后验证迁移或节点丢失后的恢复。未完成这些步骤前，不承诺跨节点故障恢复或高可用。

不要以删除 namespace/PVC 作为默认清理步骤：provisioner 的 reclaim policy 可能删除数据目录。先确认备份与恢复，再由运营者决定删除对象。Secret 更新也不会自动刷新已运行容器的环境变量，需安排重启，并保证更新后的数据库/对象存储密码本身已经生效。

## 8. 验收状态

最初模板验证记录（保留历史边界；本轮结果见后面的静态审计）：

- 使用项目的 YAML parser 解析全部 30 个 YAML 文档，验证本地引用、空 Secret 模板、模型关闭默认值、安全上下文和单 runner 约束
- TypeScript deployment 构建配置编译通过，SQL migration 已随编译产物验证
- 本地 `node dist/cli.js demo` 通过，6 个合成案例、0 个执行错误；resolve 示例仍为 Unknown。它验证编译后的离线链路，不代表真实模型精度
- 核对官方 Node/Postgres 镜像 tag、SeaweedFS 4.48 的 mini 命令及参数

该模板验证当时未执行：

- Docker/Podman 镜像构建、拉取、漏洞扫描、推送与多架构运行
- Kustomize 真正渲染、kubectl schema/准入验证、helm 操作或集群部署；当前环境没有这些可执行文件
- PostgreSQL/SeaweedFS 容器启动、真实队列崩溃恢复、S3 条件写入或跨 Pod 持久化测试
- NetworkPolicy 实际阻断、节点存储配额、CSI/fsGroup 兼容性及备份恢复
- Codex 目标环境登录、账号额度、外部推理、长期令牌刷新或付费操作

`node deploy/validate.mjs` 明确只做静态检查；它不会伪装成 Kubernetes 校验器。将未执行项作为目标环境上线门槛逐项验证。


## Workspace application jobs

The base worker now registers both the legacy replay queue and a bounded workspace
application queue. The checked-in executable reports application runtime `blocked`
until a reviewed bootstrap injects a trusted backend, enabled model configuration,
and logical workspace resolver. No manifest environment variable enables a fixture
fallback. `/readyz` covers the queue service and includes `applicationRuntime`; it
is not a workspace-execution readiness attestation. See [application jobs](application-jobs.md)
for enqueue/status commands, atomic outcome persistence, retry/cleanup fencing, and
the production lifecycle/gateway components still required.


## 2026-10-04 静态部署契约审计

本轮从 GitHub 获取 PR #24 的固定源码；未修改 `src/worker.ts`、composition、
恢复 authority 或网络策略。两名独立审查者未发现当前入口、环境变量名、
Service selector 或探针端口的确定性错配。修正了上面的 S3 范围及并发描述，
并使 Secret 模板校验同时拒绝非空 `data` 和 `stringData`。

| 契约 | 当前实际行为 | 上线前仍缺少的证据 |
| --- | --- | --- |
| 队列服务镜像 | 根目录 Dockerfile 的 `/app`、`node dist/worker.js` 与 base command 一致；UID/GID 10001 | 该集成版本镜像构建、目标架构与容器启动 |
| 隔离 workspace 镜像 | `deploy/workspace-worker` 的工作目录为 `/workspace/repo`，入口为 `/opt/flyrewheel/bin/workspace-worker`；默认 CMD 仅 sleep，recipe gateway 为 blocked | 不能替换成 base 的 `flyrewheel:dev` 后继续使用相对 `dist/worker.js`；需独立固定镜像和实际 authority/gateway |
| 显式 application composition | `worker-bootstrap.ts` 提供组合函数，但 checked-in `worker.ts` 未调用；配置环境变量不能替代可信代码注入 | 已授权的精确 workspace resolver、实际 lifecycle authority、固定 OpenSandbox/模型配置与凭据门禁 |
| 环境变量 | `DATABASE_URL` 明确选择 PostgreSQL；`PORT=8080`；`QE_S3_*` 对应 replay artifacts；`QE_ENABLE_MODEL`、`QE_CODEX_*`、`QE_MODEL_*` 对应 legacy replay | 不存在一个已接线的 ambient bootstrap JSON/module 环境变量；不要发明该入口 |
| 迁移顺序 | `openSelectedStore` 完成领域迁移后才调用 `openQueue`，再注册两类 handler 并监听健康端口；SQL 随 build 复制到 dist/storage/migrations | 旧库备份/显式接管、实际数据库 DDL 权限、真实恢复核验 |
| readiness | `/readyz` 可在 `applicationRuntime=blocked` 时返回 200；后续 maintenance 每 30 秒核对过期 job reconciliation 和 application queue | 不证明模型、S3 签名、runtime/frozen-read 或请求入口可用；HTTP 探针不检查 JSON 字段 |
| 资源与可写目录 | base 2 CPU/2Gi/2Gi ephemeral 上限，tmp 1Gi、home 64Mi、Codex PVC 1Gi；与 UID/只读代码契约无静态冲突 | 数值是起点，尚未做负载/驱逐测试；workspace 分配资源由独立 runtime 配置，不能从 base Pod 上限推导 |

`kubectl apply -k` 不保证数据库先 Ready 再启动 worker。上面的 rollout 等待顺序
只是观察顺序；worker 可能先因数据库不可用而退出并由 kubelet 重启。健康端口在
领域迁移、队列启动和 handler 注册之后才监听；当前 startup probe 约给 150 秒。
大型升级应先在独立维护窗口完成既有迁移/接管流程，不能把 Pod 反复重启当作迁移
成功证据，也不应添加绕过检查的 init 脚本。

本轮静态验证：

- `node deploy/validate.mjs` 解析 30 个 YAML 文档，并检查 base 的项目结构契约。
- `tests/deployment-contract.test.ts`：12 项通过；2 项真实 Kustomize 渲染测试因当前
  环境没有 kubectl/Kustomize **明确跳过**。这些工具未被下载或安装；没有自制渲染器。
- `npm run build` 通过；`node dist/worker.js --check` 返回两条 queue 和
  `applicationRuntime: blocked`，未打开数据库、端口或模型。

验证器还可检查真实渲染结果；在具备现有工具的工作站执行：

```sh
kubectl kustomize deploy/base > /tmp/flyrewheel-base.yaml
node deploy/validate.mjs --rendered base /tmp/flyrewheel-base.yaml
kubectl kustomize deploy/overlays/single-node-dev > /tmp/flyrewheel-dev.yaml
node deploy/validate.mjs --rendered single-node-dev /tmp/flyrewheel-dev.yaml
```

这是 Zod/断言实现的**项目字段契约**，不是完整 Kubernetes API schema、服务端准入
或 NetworkPolicy 验证。测试会在存在 kubectl 或 Kustomize 时调用真实 renderer，
使用不存在的 KUBECONFIG；它只渲染本地资源，不连接集群。完整 schema/准入、
真实渲染和 live prerequisites 仍按本节列出的边界验收，不能标为部署成功。
