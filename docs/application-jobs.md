# Workspace application queue and service boundary

The existing pg-boss service now registers two queues: `flyrewheel-replay`
(retained replay behavior) and `flyrewheel-application` (PR mining, semantic
review, and revision generation). This is application orchestration, not another
workflow engine or a live deployment claim.

## What a job can select

`ApplicationJobSchema` is a strict union, limited to 4 KB at enqueue:

- PR mining: frozen `requestDigest`, logical `workspaceId`, immutable
  `candidateCreatedAt`, and logical `attempt`
- Semantic review: frozen `ruleDigest`, `snapshotDigest`, logical
  `workspaceId`, and logical `attempt`
- Revision generation: frozen `requestDigest`, one selected feedback
  `snapshotDigest`, logical `workspaceId`, immutable `candidateCreatedAt`,
  and logical `attempt`

All jobs also carry `schemaVersion: 1` and their `kind`. Unknown fields are
rejected. Logical IDs use bounded alphanumeric/underscore/hyphen syntax. Jobs
cannot contain repository paths, executable paths, backend choices, model
configuration, credentials, output schemas, fixture results, or persistence
capabilities. A workspace ID is a lookup key, never a filesystem path.

Example mining input (replace the digest with a previously stored request):

```json
{
  "schemaVersion": 1,
  "kind": "pr-mining",
  "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "workspaceId": "approved-repository",
  "candidateCreatedAt": "2026-10-02T00:00:00Z",
  "attempt": "initial"
}
```

```sh
node dist/cli.js application-jobs validate --file job.json
# Requires an explicitly authorized disposable PostgreSQL database and credentials
# supplied through the approved mechanism. Queue startup performs DDL.
node dist/cli.js application-jobs enqueue --file job.json --postgres
node dist/cli.js application-jobs status --file job.json --postgres
# Local ledger inspection, without a PostgreSQL queue connection:
node dist/cli.js application-jobs status --file job.json --db local-db
```

Import domain inputs into the same PostgreSQL store before enqueueing: domain
commands accept `--postgres` using that same `DATABASE_URL`, or retain local
`--db` behavior. A digest held only in a local store is unavailable to the
PostgreSQL worker. See [explicit database selection and setup](database-selection.md).

Validation never connects or runs a model. Enqueue success means a queued job,
not completed execution. A pg-boss `completed` job may have an application
`blocked` result; inspect both fields. The status command returns bounded domain
references and cleanup state, not raw backend errors or workspace paths. Status lookup may mark an expired interrupted claim blocked; local
status initializes migrations when opening the explicitly chosen local database.

## Trusted bootstrap and workspace resolution

`startWorkerService({store, boss, application})` accepts a testable trusted
application dependency set. `createApplicationJobDispatcher` is independently
usable with the same store and dependencies. Trusted application code must supply:

1. An explicit enabled model configuration
2. A supervised workspace backend, runtime identity, and bounded execution /
   artifact / cleanup limits, using the existing workspace adapter interfaces
3. A read-only workspace resolver that maps the logical key to an already
   prepared, authorized workspace and honors cancellation

The resolver receives the immutable job digest, kind, repository identity and
pinned Git SHAs derived from persisted inputs. It must authorize the key against
that repository and job. A queue producer cannot make the resolver browse a
path or choose an executable. PR mining pins the before/merge-base checkout;
review and revision pin the captured after/head checkout. Revision uses only
its frozen selected feedback graph, preserves holdout checks, and keeps model
repository tools disabled. Semantic review still recaptures the exact snapshot
from local Git before accepting runtime evidence.

The normal `node dist/worker.js` entrypoint has **no configured application
backend or resolver**. It registers the application queue but returns a durable
`blocked / not_run / runtime_unavailable` result before reading private domain
inputs, resolving a workspace, or reserving a runtime. It does not fall back to
fixtures or infer backend setup from environment variables. A reviewed deployment
bootstrap must call the service with trusted dependencies. There is deliberately
no arbitrary module/executable loader controlled by environment or job JSON.
`node dist/worker.js --check` checks compiled imports and reports this blocked
boundary without opening sockets, connecting a database, or invoking a model.

`/readyz` reports queue-service readiness; its `applicationRuntime` field is
`blocked` unless those dependencies are explicitly configured. A ready replay
service is not evidence that workspace/model execution is available.

## Persistence, retries, and cleanup

The normalized job digest is its durable application identity; pg-boss uses a
stable UUID derived from it. Candidate IDs and semantic-review attempt identities
are also derived from the full job digest. Candidate timestamps are frozen in the
job, rather than changing on delivery. Domain receipts continue to distinguish
authored tests (`modelExecution: not_run`) from model execution.

Migration 012 adds a durable application ledger. Claims have an owner token and
15-minute lease. Only one owner can complete a claimed job. After adapter
execution **and verified cleanup**, the opaque in-process capability persists
through the existing domain APIs inside the same transaction as the terminal
application outcome. Cancellation is checked inside that transaction before
persistence, before its outcome update, and after awaited validation, so an
observed pre-commit abort rolls back domain writes. Durable reads validate both the ledger identity and its
referenced domain outcome. JSON cannot mint these capabilities.

- Re-delivery after a committed outcome, including lost queue acknowledgement,
  returns that outcome before workspace lookup or execution; it does not create
  another rule, review, finding, or revision outcome
- Safe failures with verified cleanup (or no runtime start) are recorded as
  retryable and throw back to pg-boss's bounded retry policy
- A crash before commit or a safely retried persistence failure may require
  repeated inference. This does **not** provide model exactly-once execution
- Interrupted expired claims become terminally blocked and are not stolen;
  startup, bounded 30-second service reconciliation, and status reads perform
  expiry reconciliation even after the broker has exhausted its retry budget;
  unverified cleanup likewise retains a blocked result. Operators must verify
  external runtime recovery before intentionally submitting a new attempt
- Blocked outcomes are immutable. Correcting runtime configuration does not
  silently rerun old blocked jobs; submit an explicit new logical attempt
- Application ledger retention is independent of pg-boss's job retention, so
  queue deletion does not erase the stable outcome identity

Shutdown and pg-boss cancellation signals propagate into the dispatcher and
existing supervised runner. Timeouts, process stopping, bounded evidence
collection, physical destruction checks, and lease release stay in that runner.
Unverified cleanup is never converted into a successful result or automatic
allocation retry. Raw backend errors and potentially sensitive paths are not
printed in queue summaries. Consult the trusted runtime's secured recovery
records when cleanup is retained.

## What remains outside this implementation

The checked-in OpenSandbox image/gateway configuration is still blocked. A real
production lifecycle authority, admission fencing, protected request/evidence
storage, verified physical destruction, credential-isolated authenticated model
gateway, and reviewed workspace resolver are still required. No credentials,
real backend, service, container, PostgreSQL server, image build, deployment,
network policy, or model inference were configured or tested by this work.

The integration tests use fresh PGlite databases and real asynchronous pg-boss
work callbacks, plus authored SDK executables through the existing adapters.
They validate application wiring, immutable domain persistence, retries and
reopen behavior. They do not establish PostgreSQL server / cross-process crash
recovery, production isolation, live gateway correctness, or k3s readiness.

### Verified working-tree checks (2026-10-02)

- Full suite: **827 tests in 58 files passed**, using `vitest run --maxWorkers=2`
- Typecheck and production TypeScript build passed, including migration copying
- Compiled worker `--check`, application job validate/status against a fresh local
  PGlite database, and the compiled offline demo passed
- Static deployment validation passed all 30 YAML documents; all 9 workspace
  image-recipe checks passed; `git diff --check` passed
- New coverage includes real asynchronous application/replay callbacks, authored
  SDK outputs, domain transaction rollback, cancellation during commit, timeout,
  retained cleanup, lost acknowledgement, store reopen, capability-forgery/reuse
  rejection, independent expiry reconciliation, and mocked service shutdown /
  readiness recovery

The service tests mock HTTP rather than bind a port. The compiled worker check
is import/configuration validation only. These checks do not provide live
PostgreSQL, cross-process crash recovery, runtime isolation, gateway, image, or
cluster evidence.

### Selected repository context for semantic-review jobs

A `semantic-review` reference job may additionally specify a nonempty canonical
(sorted, unique) `repositoryContextDigests` array of at most 8 registered package
digests. Omit the field for the unchanged snapshot-only contract. The dispatcher
loads every exact package, and the adapter verifies the complete frozen selection
against local Git at the review head before allocating a worker. Persistence and
job completion reject absent, substituted or expanded selections. Context packages
are never accepted inline as job payloads. See [context bounds and trust](repository-context.md).


### Governance-selected local reviews

Semantic-review reference jobs may carry `governancePlanDigest`. The dispatcher
then requires exact membership in the immutable local plan and records a fresh,
locked governance-head check before each execution attempt. See
[governed semantic reviews](governed-semantic-reviews.md) for plan/enqueue/status,
stale-plan races, bounds and historical admission semantics. Jobs without that
field retain their existing explicit-digest replay identity and are labeled
non-governed in CLI output. No new application runtime is implicitly enabled.
