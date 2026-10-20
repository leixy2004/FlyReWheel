# Explicit worker bootstrap compatibility

The worker accepts the reviewed deployment-module launch flags introduced in
GitHub commit `76a7a14bcfcf1c8c11b42030ddd27d9a700d92de`. This integration retains
the current JSON preflight and local-development inspection paths; it does not
import that historical branch's research changes.

| Invocation | Behavior |
| --- | --- |
| `node dist/worker.js` | PostgreSQL queue service; application execution remains blocked |
| `--check` | Import smoke check; no database, queue, bootstrap module or model |
| `--check --config FILE` | Existing strict schema-version-1 JSON preflight; environment names only |
| `--check --local-development FILE` | Existing local receipt inspection; no application execution |
| All three application flags below | Verify top-level module bytes, compose trusted dependencies, then start the PostgreSQL service |
| `--check` plus all three flags | Validate argument syntax only; report `not_loaded_or_verified`, without opening the module |
| `--config FILE` or `--local-development FILE` without `--check` | Actionable error before service startup |
| Partial application flags, duplicate/unknown flags, positional arguments, mixed modes | Reject before reading files or opening services |

## Migration

Keep existing JSON checks unchanged. A JSON file cannot grant lifecycle authority
and cannot be used as the executable module. To migrate a previously reviewed
programmatic bootstrap, export exactly `config` and `dependencies` from a `.mjs`
module. `config` uses `WorkerBootstrapConfigSchema` (schema version defaults to 1).
`dependencies` accepts only `authority`, `resolveWorkspace`, `createSandbox` and
`transfer`. Use either the existing `config.preparedWorkspaces` resolver or an
injected `resolveWorkspace`, never both. No authority implementation is supplied
by this compatibility change. See [remaining production requirements](worker-real-mode-readiness.md).

After a deployment operator has reviewed and authorized the module, its
transitive dependencies, lifecycle implementation and model execution:

```sh
node dist/worker.js --check \
  --enable-application-execution \
  --application-bootstrap /opt/flyrewheel/deployment/bootstrap.mjs \
  --application-bootstrap-sha256 <reviewed-lowercase-sha256>
```

This check does not verify the file, digest, configuration, authentication or
runtime readiness. Only after the separate deployment gates pass, remove
`--check` to start. Source checkouts accept the same arguments after
`npm run worker --`. Use a canonical absolute `.mjs` path, not a symlink; the file
must be regular and at most 1 MiB. Supply the existing explicit `DATABASE_URL` and
the configuration's named API key through the authorized deployment mechanism.
No environment variable or queued job selects executable code. This document
neither provisions credentials nor grants authorization.

## Trust and lifecycle boundaries

This is privileged deployment code: module top-level code executes before its
exports can be validated. The SHA-256 covers only the top-level file, not its
imports. Native ESM import reopens the path after the byte check, so the hash is
**not an atomic verified-import guarantee**. The module, ancestor directories and
all dependencies must remain trusted and immutable for the process lifetime.
Do not point it at repository-controlled or writable workspace code. Relative
module imports retain native Node resolution, including native module caching.
Changing a transitive dependency requires a new process and a fresh deployment
review, even if the top-level digest is unchanged.

Bootstrap rejection happens before store/queue startup and does not echo paths,
module errors or config values. Queue-open failure closes the opened store. Once
started, the service owns store/queue/health cleanup; repeated stop calls share
one shutdown operation. A new launch starts a new service: ESM caching is not a
singleton lock. Durable job identities handle terminal delivery replay, while
unverified cleanup remains blocked under existing ledger rules.

Tests run the actual Node importer and worker CLI, including the compiled build,
with authored modules and sanitized environments. A local Node harness starts
and stops the real service with a loopback socket and authored queue/storage.
Durable integration uses file-backed PGlite and authored model responses. These
checks do not establish PostgreSQL/pg-boss deployment operation, real model
effectiveness, production isolation or lifecycle authority.
