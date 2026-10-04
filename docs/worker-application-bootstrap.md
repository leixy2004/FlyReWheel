# Explicit application worker bootstrap

The normal `node dist/worker.js` starts the PostgreSQL/pg-boss worker with application
execution blocked. Environment switches alone do not enable mining, revision or
semantic inference. A reviewed deployment can explicitly wire the existing
OpenSandbox adapters into the same worker service:

```sh
node dist/worker.js \
  --enable-application-execution \
  --application-bootstrap /absolute/reviewed/deployment.mjs \
  --application-bootstrap-sha256 <reviewed-top-level-sha256>
```

Supply all three options together. The path must be canonical, absolute, end in
`.mjs`, and identify a regular file of at most 1 MiB; symlink aliases are refused.
The lowercase SHA-256 must match the top-level module bytes. Duplicate, unknown
or incomplete options fail before database or queue startup. The default is
unchanged, and no queue payload can choose executable code or model settings.

## Deployment module contract

The module has exactly two named exports, `config` and `dependencies`. `config`
is the strict `WorkerBootstrapConfigSchema` from `src/worker-bootstrap.ts`:
explicit enabled/model/generation limits plus a bounded OpenSandbox runtime,
credential-free HTTPS endpoint, digest-pinned image and explicitly named API-key
environment variable. No secret value belongs in this configuration.

`dependencies` contains the existing trusted lifecycle `authority` and exact
`resolveWorkspace` function. Optional code-only `createSandbox` and `transfer`
seams retain the existing adapter contract. Unknown dependency keys, including an
exported environment override, are rejected. The launcher supplies its own process
environment; only the config's named credential is consulted by composition.

Reuse the [prepared workspace resolver](prepared-evaluation-workspace-resolver.md)
and the existing lifecycle interfaces. Do not mint authority from JSON, use an
unbounded path selected by a job, or replace failed production execution with
an authored backend. This repository does not supply a verified live lifecycle
authority for a particular deployment. That remains a separate deployment
prerequisite, alongside explicitly authorized model access and spending.

The module is trusted executable deployment code, not a plugin sandbox. It must
only declare configuration and construct side-effect-free dependency functions;
do not allocate services, sandboxes or resources at module top level. Protect the
entire reviewed module/import tree from writes and restart the worker to change
it. The entry hash detects configuration mistakes; it neither pins transitive
imports nor prevents concurrent alteration of a writable module between checking
and import. Normal ESM caching applies. Loader rejection cannot undo arbitrary
side effects from trusted module code. Do not treat the hash as isolation or
execution attestation.

## Checks and lifecycle

`node dist/worker.js --check` remains a pure import/configuration smoke. It accepts
syntactically complete opt-in flags but never reads or imports the deployment
module, opens a database/queue/listener, or invokes a model/runtime. Its result
therefore remains `applicationRuntime: blocked` and says trusted dependencies
were not loaded or verified. It does not certify that a supplied module works.

A real launch validates and composes the module before opening PostgreSQL and
pg-boss. Queue-open failure closes the store. Once the existing worker service
starts, it owns queue/store/health shutdown and failed-start cleanup. The same
application dispatcher routes persisted mining, review and revision selections
through the existing adapters and atomic domain/outcome persistence; no new queue
or governance implementation is introduced.

Completed redelivery returns the durable outcome without another execution.
Cleanup-safe failures remain retryable; expired claims with unknown cleanup remain
blocked pending the existing recovery authority. This is not exactly-once model
execution across a crash before the domain/outcome commit.

## Evidence boundary

Authored tests exercise the actual option parser, module loader, composition,
worker callback, adapters, persisted requests and reopen behavior. Their backend
is explicitly authored and not isolated, and their database is PGlite. They do
not prove a live OpenSandbox deployment, real PostgreSQL/broker operation, real
model effectiveness, credentials or billing. Existing PR35 partial runtime and
cleanup failures stay historical evidence, not a successful retry of this path.
