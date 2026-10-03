# Runtime readiness: verified boundary

Checked 2026-10-02 against source revision `e93ebca` in the selected cloud
workspace. This is an operational inventory, not a deployment success report.
The application-wiring sections below also describe the subsequent working-tree
implementation; the environment inventory itself is unchanged.

## Current execution environment

- Node `v24.19.0`, npm `11.9.0`, Python `3.12.14`, and Git `2.52.0` are
  available. The container recipes target Node 22; this host does not validate
  that exact image/runtime combination.
- `docker`, `podman`, `k3s`, `kubectl`, `containerd`, `nerdctl`, `psql`,
  `postgres`, `pg_ctl`, `initdb`, and `pg_isready` are not on PATH. A bounded
  search of standard binary/PostgreSQL installation directories also found no
  Docker/Podman/k3s/kubectl/PostgreSQL executable.
- The visible process-name inventory contained no database or container
  daemon. A listener listing reported two unidentified loopback endpoints,
  neither on PostgreSQL 5432, Kubernetes 6443, nor S3 8333. The command also
  reported restricted netlink access, so this is a limited observation, not a
  complete host/service inventory. Unknown endpoints were not probed.
- Presence-only checks found no `DATABASE_URL`, `PGHOST`, `PGPORT`,
  `PGDATABASE`, `DOCKER_HOST`, `CONTAINER_HOST`, `KUBECONFIG`,
  `KUBERNETES_SERVICE_HOST`, `QE_S3_ENDPOINT`, or `OPENSANDBOX_ENDPOINT`.
  No credential/configuration values, kubeconfigs, authentication files, or
  session stores were read.
- No live PostgreSQL, S3, OpenSandbox service, or k3s cluster is established by
  these checks. No installation, service creation, login, deployment, container
  socket access, or privilege/security change was performed.

## Checks actually completed

1. `node deploy/validate.mjs`: passed all 30 YAML documents and its static
   local-reference/default/security checks. This does not perform Kustomize
   rendering, Kubernetes admission, or live network-policy verification.
2. `node --test deploy/workspace-worker/validate-recipe.mjs`: all 9 source-only
   checks passed. No container image was built or executed.
3. A one-shot, in-memory integration harness used the installed PGlite and
   official pg-boss PGlite adapter, initialized the actual domain migrations,
   and called the real `openQueue`, `workReplay`, `enqueueReplay`, and
   `replayDataset` functions. One fresh synthetic offline replay completed
   through pg-boss's asynchronous worker callback; duplicate submission was
   rejected; exactly one callback produced 6 observations and 0 execution
   errors. The job reached `completed`. The queue and store used the same new
   in-memory database; existing databases were not opened or modified.

The third check extends the checked-in queue test, which manually fetches and
completes a job. It still uses synthetic decisions and PGlite. It does **not**
exercise `src/worker.ts` as a process, PostgreSQL server connections,
cross-process concurrency, queue crash recovery, S3, containers, model
inference, or k3s. Repeating this check does not close those release gates.

## Subsequent application-wiring checks

The current working tree passed 827 tests in 58 files with `maxWorkers=2`,
TypeScript typecheck/build, compiled worker `--check`, compiled application-job
validate/status with a fresh local PGlite database, and the compiled offline demo.
The new application tests exercise actual asynchronous pg-boss callbacks with
authored SDK executables, durable domain outcomes, retry/reopen/acknowledgement
loss, cancellation/timeout, capability checks, and independent lease-expiry
reconciliation. Service lifecycle tests use mocked HTTP and do not open sockets.
The 30-document static deployment check and all 9 image-recipe checks also passed.
These are local application-wiring checks, not the live runtime release gates
listed below. See [verification detail](application-jobs.md#verified-working-tree-checks-2026-10-02).

## Two different worker paths

`deploy/base/worker.yaml` starts `node dist/worker.js`. That service requires
an explicit PostgreSQL connection, applies domain migrations and pg-boss
schema changes, exposes health endpoints, and handles `ReplayJobSchema`
jobs through `replayDataset`. The application service now also registers bounded
PR mining, semantic-review, and revision-generation jobs with atomic domain
outcome persistence. Its default trusted runtime/resolver configuration remains
explicitly blocked; see [application job lifecycle](application-jobs.md).
Its optional S3 upload and account/API model
configuration belong to this replay worker. There is no Compose deployment
checked in.

The newer credential-free workspace worker has a separate image recipe in
`deploy/workspace-worker/`. It supports PR mining, rule revision, and semantic
review protocols, and is now reachable through the application dispatcher when trusted runtime
and workspace-resolver dependencies are supplied to the service. The base
executable does not provide those dependencies. Its checked-in gateway
configuration is deliberately `blocked`.

The OpenSandbox adapter additionally requires a production
`OpenSandboxLifecycleAuthority`. The repository provides the interface and
authored test implementations, not an implementation for a real k3s runtime.
Required external responsibilities include admission fencing, trusted request
storage ingress/ownership, stop/frozen-evidence collection, verified physical
destruction, and an authenticated credential-isolated gateway. Installing a
container tool or passing fixture tests does not provide those components.

## Smallest next real integration test

No real PostgreSQL/container/k3s integration can be run with only the verified
tools and endpoints above. The in-memory callback test is the queue integration
layer actually checked here without adding runtime access; it is not a
substitute for the following steps.

For the existing replay service, use an explicitly authorized disposable
PostgreSQL database in a usable target environment. Do not point startup at an
existing application database: startup can apply pending persistent DDL. Pre-ledger domain databases require [reviewed adoption](database-migrations.md) first. Provisioning
the database/access and any required secrets is a separate authorized setup
step. Then:

1. Keep `QE_ENABLE_MODEL=false` and `QE_S3_ENABLED=false`. Build the checked-in
   code and run `node dist/worker.js` with that database and a dedicated health
   port. Supply connection credentials through the approved mechanism,
   never in committed files or a captured command line.
2. Verify `/healthz` and `/readyz`; submit the checked-in synthetic
   bundle/dataset with the documented `enqueue` command. Check actual queue
   completion and domain records, then resubmit and verify deduplication.
3. Send SIGTERM, verify readiness/exit behavior, restart against the same
   disposable database, and verify persisted records. Separately exercise an
   interrupted active job and its retry/lease behavior. Keep this isolated
   from production data; database deletion is not an automatic cleanup step.
4. Only after the server-backed path works, repeat with the built replay
   container and the selected k3s manifest. Verify actual Kustomize rendering,
   admission, probes, persistence and network enforcement. S3 can then be
   enabled against an authorized test bucket for real signed Put/Get,
   conditional-write, wrong-credential rejection, and restart-persistence
   checks.

For the workspace mining/revision/review service, the prior steps alone are
insufficient. First provide and independently validate the lifecycle
authority, protected storage/ingress, audited immutable image, credential-free
gateway boundary, and reviewed trusted service bootstrap. The application
queue/dispatcher layer is now present; this does not provide the missing runtime
controls. Preserve the existing
fail-closed behavior until those real deployment controls have evidence.

See [deployment instructions](deployment.md),
[workspace image contract](../deploy/workspace-worker/README.md), and
[OpenSandbox boundary](opensandbox-workspace-adapter.md).
