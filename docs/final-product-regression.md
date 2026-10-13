# Final product regression review — 2026-10-13

Scope: `4de5084` through `c044e73`, on branch `codex/explicit-review-continuation`.
Base: `17879c170b7ba6bdbbe86a5c977a9b4de88da386`.
Verified product tree: `0c7e87e508c46cc3427bdea80d33060c4bea6aa7`.
Final code/test commit: `da486abce5c981a57808ba342f3773cad3537d1a`. The subsequent report commit contains only
this report and its evidence. Initial and post-fix worktrees were clean.

## Outcome

The bounded review is complete. One test-fixture regression was found and fixed;
no production behavior change was required. All nine independent product changes
have their own commits; the tenth original commit is a standalone workflow
verification. No old-session patch was imported or claimed as part of this chain.

| Run | Files | Pass | Fail | Skip | Todo |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh aggregate on c044e73 | 30 | 186 | 2 | 0 | 0 |
| Post-fix affected storage/history/batch tests | 3 | 17 | 0 | 0 | 0 |
| Final latest result per file (deduplicated, **not one rerun**) | 30 | 188 | 0 | 0 | 0 |

The first aggregate took 354.59 seconds. `npm run typecheck`
passed before and after the fix; `npm run build` and `git diff --check` passed.
Five fresh compiled CLI flow scripts passed, zero failed/skipped. No historical
results are counted here. Unselected tests were not run; they are not reported as
skipped. No complete repository suite was necessary: only the rollback-scoped test
helper changed after the aggregate, and its full file plus the interacting history
and batch files were rerun. Production sources and packaged migrations stayed
byte-identical to c044e73.

## Failure and fix

The two failures were in `tests/application-jobs.storage.test.ts`: intentional
corruption of a finished ledger row used to disable only its transition trigger.
Migration 018 adds an attempt archive trigger; it tried to insert the same attempt
again and failed with a duplicate key before the intended read-integrity assertion.
The test helper now disables both triggers inside its always-rolled-back transaction
and asserts both are enabled afterwards. No production trigger or migration was
weakened. Fix committed independently as `da486abce5c981a57808ba342f3773cad3537d1a` after 17/17 checks passed.

## Commands and fresh evidence

Tests used an explicit environment containing only PATH (the installed Node binary,
/usr/bin and /bin), HOME=/tmp/flyrewheel-final-regression/home, LANG=C.UTF-8 and
TZ=UTC. No ambient credential values or credential directories were inherited.
There is no AGENTS.md instruction file in the repository or its checked ancestors;
package.json supplies test/typecheck/build scripts and no separate lint requirement.

```sh
npm test -- \
  tests/review-continuation.test.ts \
  tests/review-batch.test.ts \
  tests/review-batch-export.test.ts \
  tests/review-batch-cli-execution.test.ts \
  tests/application-job-history.test.ts \
  tests/application-jobs.test.ts \
  tests/application-jobs.storage.test.ts \
  tests/application-jobs.cli.test.ts \
  tests/application-job-context.test.ts \
  tests/application-operations.test.ts \
  tests/application-operations.cli.test.ts \
  tests/application-evaluation-binding.test.ts \
  tests/worker-bootstrap.test.ts \
  tests/worker-bootstrap-preflight.test.ts \
  tests/worker-preflight.cli.test.ts \
  tests/worker-service.test.ts \
  tests/prepared-workspace-resolver.test.ts \
  tests/local-development-workspace.test.ts \
  tests/semantic-review.storage.test.ts \
  tests/semantic-review.cli.test.ts \
  tests/semantic-governance.test.ts \
  tests/semantic-governance.storage.test.ts \
  tests/semantic-governance.limits.test.ts \
  tests/semantic-governance.cli.test.ts \
  tests/governed-semantic-review.test.ts \
  tests/governed-semantic-review.cli.test.ts \
  tests/revision-inspection.storage.test.ts \
  tests/revision-explanation.test.ts \
  tests/database-migrations.test.ts \
  tests/database-migration-locking.test.ts \
  --reporter=json \
  --outputFile=/tmp/flyrewheel-final-regression/aggregate.json
```

Post-fix commands (the build had already passed on identical production sources):

```sh
npm test -- tests/application-jobs.storage.test.ts tests/application-job-history.test.ts tests/review-batch.test.ts --reporter=json --outputFile=/tmp/flyrewheel-final-regression/followup.json
npm run typecheck
git diff --check
```

Fresh compiled flows (each used its new directory beneath
`/tmp/flyrewheel-final-regression/`):

| Script | Result | Seconds |
| --- | --- | ---: |
| `node scripts/smoke-review-user-flow.mjs /tmp/flyrewheel-final-regression/review-user-flow` | pass | 27.43 |
| `node scripts/smoke-review-batch-cli.mjs /tmp/flyrewheel-final-regression/review-batch-cli` | pass | 28.74 |
| `node scripts/smoke-local-development-lifecycle.mjs /tmp/flyrewheel-final-regression/local-development-lifecycle` | pass | 8.47 |
| `node scripts/smoke-feedback-discovery.mjs /tmp/flyrewheel-final-regression/feedback-discovery` | pass | 17.81 |
| `node scripts/smoke-revision-explanation.mjs /tmp/flyrewheel-final-regression/revision-explanation` | pass | 25.29 |

[Machine-readable evidence](evidence/final-product-regression-2026-10-13.json)
contains exact commands, all commit/file mappings, per-file final test counts and
static-review observations. Raw aggregate/followup JSON, logs, databases and flow
artifacts are retained in `/tmp/flyrewheel-final-regression`.

## Static review and interaction coverage

This was a fresh source inspection by the current agent, separate from interpreting
test results; no separate human reviewer or subagent is claimed.

- CLI registration, explicit database selection, mutually exclusive offline/config
  execution and worker check-only routing remain intact.
- Migrations 016–018 are additions only; all older migration bytes remain unchanged.
  Added job identity fields are optional and do not add defaults to legacy jobs.
  Fresh databases, legacy migration adoption/checksums and surviving-result backfill
  are covered by the selected migration/storage tests.
- Continuations bind immutable outcomes, findings and explicit context. Their jobs
  cannot impersonate governed or evaluation fixture runs. Reopening does not require
  a live model or the original source checkout.
- Failed batch items retry only when selected. Finished/running items remain untouched;
  failure/cancellation preserves earlier commits. Attempt history survives retry and
  restart, and missing overwritten legacy attempts remain explicitly reported.
- Feedback catalog entries retain exact finding/review/rule/source bindings. Frozen
  requests and comparison evidence do not absorb later feedback. Current finding
  verdicts are labeled separately from selected frozen evidence.
- Revision explanations compare literal stored versions and use the existing atomic
  scoped selector. Acceptance is not selection; scoped exclusion and suspension are
  reflected. Governed plans pin the version and admission rechecks registry heads.
  Manual offline review remains explicitly nongoverned.
- Presence-only preflight does not authenticate credentials. Development worktrees
  and hashed local evidence do not implement production lifecycle authority. The
  real-runtime gate remains blocked without that separately injected capability.

## Complete local commit map

| Commit | Independent purpose |
| --- | --- |
| `4de5084ad03a8634289557f72cdbc6ec97cb53c0` | Explicit context-selected review continuations |
| `fa843e32a734ec7f3494b4eea74e7c2ed70fba87` | Durable review batches and selective retries |
| `695705de7c554b28cd7c3c9e1b7cceeb6cb30a88` | Batch JSON/CSV exports and retry selections |
| `3e9dc825555fd076085f506550c115f3b74c31c8` | Immutable job attempt history and migration 018 |
| `d02d1bbc941135dd9ed8605fa6925559cb93c7b6` | Cross-process upstream-source projection verification (validation commit) |
| `db09bab8a48b9c279c91ed4c6fa555bb6fda8560` | CLI batch execution with explicit offline fixtures / trusted bootstrap |
| `8f4633ff752fa4afbf3eb856d9c5272c474ea224` | Prepared resolver wiring and presence-only runtime preflight |
| `44a59e56947455cf334dc40ce3319afa69b8b502` | Development-owned workspaces, evidence and conservative cleanup |
| `10a0a020f978ddd8eeb25cb02230409e76c5686e` | Feedback discovery and exact evidence links |
| `c044e7351066601308619498dad8346dd2f2729c` | Revision field changes, evaluation explanation and scoped eligibility |
| `da486abce5c981a57808ba342f3773cad3537d1a` | Test-only corruption fixture compatibility fix found in this audit |

## Remaining gaps, ordered by impact

1. **Live end-to-end execution:** the default CLI/worker still lacks a built-in
   production lifecycle-authority implementation (allocation fencing, verified
   whole-runtime stop, external frozen evidence and verified destruction). This is
   a code/deployment integration gap, not merely missing model login. Local worktree
   readiness does not solve it.
2. **Governed offline execution:** governed planning/selection is available, but the
   explicit offline batch path intentionally rejects governed/evaluation jobs.
   The offline acceptance uses the selected digest in labeled manual replay; it
   does not establish governed worker execution. A dedicated offline governed
   execution capability remains a possible product follow-up, not added here.
3. **Empirical semantic quality and feedback:** the local mechanism supports declared
   feedback and comparisons, but this audit does not provide representative real
   model results, verified developer judgments or live PostgreSQL/deployment evidence.
   Literal diffs and compatible fixture outcomes do not establish real-world quality.

The user-flow/batch scripts use only two allowlisted GitHub-origin source files in
an explicitly projected repository and authored runtime envelopes. Other flows use
synthetic demo source/candidates/judgments. No real model was invoked, no credential
or W1 data was read, no frozen research protocol changed, and nothing was pushed,
deployed or published. No further feature work was started during this review.
