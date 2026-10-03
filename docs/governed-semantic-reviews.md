# Governed local semantic review execution

`reviews governed` connects the local semantic-v2 governance registry to the
existing trusted semantic-review application dispatcher. The coordinator freezes
an immutable selection manifest, explains every registered version it excludes,
and derives at most 20 exact review jobs. No rule import, comparison acceptance,
plan creation or successful review performs production activation or publication.

This is local experimental eligibility. A root bootstrap remains explicitly
unvalidated. Fixture decisions and authored SDK responses remain fixtures;
selection never creates feedback labels or changes a finding's truth status.
Repository identities and actors retain their existing caller-declared trust.

## Plan, inspect, enqueue and track

First import the snapshot/rules and explicitly register/bootstrap or select the
versions as described in [local rule governance](semantic-rule-governance.md).
Create a strict JSON input, using the exact stored repository and snapshot:

```json
{
  "id": "change-42-local-review-1",
  "repository": "exact-repository-identity",
  "snapshotDigest": "COPY_EXACT_SNAPSHOT_SHA256",
  "paths": ["src/worker.ts"],
  "workspaceId": "approved-repository-workspace",
  "attempt": "initial"
}
```

Replace the placeholder digest. Paths must be unique, literal changed paths
present in either side of the snapshot; repository aliases and globs are not
inferred. Path order is normalized. These paths select applicable **rules**;
each job reviews its full pinned snapshot filtered by that rule's scope. They do
not restrict its review to only those paths or supply additional source content.
A captured deletion or excluded file can select a rule; its existing review
coverage still reports the missing/excluded target and does not invent a result.

Optional `repositoryContextDigests` accepts the existing sorted, unique maximum
of eight registered context packages. Optional `evaluationExportId` preserves
the existing trusted resolver binding. A workspace ID is a logical lookup key,
never a path, runtime configuration or executable. Job JSON cannot supply a model,
backend, credentials, detector output, result or approval.

```sh
node dist/cli.js reviews governed plan --file plan-input.json --db local-db
node dist/cli.js reviews governed show --digest PLAN_SHA256 --db local-db
node dist/cli.js reviews governed status --digest PLAN_SHA256 --db local-db

# Use the same explicitly chosen PostgreSQL database for domain inputs and jobs.
# Requires separately authorized PostgreSQL access; queue startup performs DDL.
node dist/cli.js reviews governed plan --file plan-input.json --postgres
node dist/cli.js reviews governed enqueue --digest PLAN_SHA256 --postgres
node dist/cli.js reviews governed status --digest PLAN_SHA256 --postgres
```

`plan` persists `{ digest, plan }` and prints the derived reference jobs. `show`
revalidates and returns that historical plan. `status` reports whether current
registry selection still matches, every job's durable application state, its latest
attempt's exact admission and bounded outcome references. It does not open pg-boss or
run a model. `finished` means all jobs have terminal application outcomes; inspect
individual results for `completed` versus `blocked`. `no_eligible_rules` creates
no jobs and is not a safe-code verdict. Imported, unregistered rules are absent;
registered exclusions retain candidate/suspended/retired/superseded/out_of_scope
reasons and exact version/head bindings.

All commands use [explicit database selection](database-selection.md). `--db`
and `--postgres` cannot be combined; `DATABASE_URL` alone never selects a server.
Enqueue requires `--postgres` and uses the same resolved destination for the
store and queue. Local PGlite plans cannot be dispatched by a separate PostgreSQL
worker that lacks those domain records. There is no implicit database transfer.

## Trusted execution

Trusted bootstrap code can call `runGovernedReviewPlan(dependencies, planDigest,
signal)` from `src/governed-semantic-review.ts`, or use the ordinary application
worker callbacks for the returned jobs. The in-process coordinator dispatches
serially. Each derived `semantic-review` job includes `governancePlanDigest`;
its full identity must exactly match a member of the stored manifest, including
rule, snapshot, context selection, workspace, evaluation export and attempt.

The same existing application adapter, exact local Git recapture, supervised
execution, cleanup checks and opaque persistence capabilities apply. There is no
new runtime loader or fixture fallback. The ordinary CLI worker still returns
`blocked / not_run / runtime_unavailable` without explicitly supplied trusted
runtime dependencies. A plan/enqueue response is not proof of model execution.
The local compiled smoke tests this fail-closed boundary; integration tests use
explicit authored SDK programs through the real adapter and pg-boss callbacks.

## Exact stale-plan and race semantics

Planning acquires a shared governance-head lock inside a short transaction. It
captures the complete validated registry selection and all its heads, including
excluded rules. Plan payloads, inputs and selection are content-addressed and
immutable. Reading a historical plan validates only each recorded immutable
history prefix, so later evidence does not enlarge that historical read budget.

The dispatcher validates membership and current selection before workspace
resolution, then checks again immediately before invoking the trusted adapter.
The final check and a per-claim admission record commit together while holding
the shared head lock. Governance transitions use an incompatible lock. This
commit is the admission linearization point; **no lock is held during model work**.

- Any registry-head change invalidates pending admission, even a change to an
  unrelated or excluded rule. The conservative policy avoids silently missing a
  newly registered or selected rule. A new plan requires a new explicit plan ID
- Suspension/retirement/supersession before admission blocks the stale job with
  `stale_governance_plan`; a newly created plan excludes the stopped version or
  selects the explicit successor
- A transition after admission does **not** cancel that in-flight operation. Its
  completed result retains the exact historical plan/admission; status can report
  `stale-plan` beside that completed historical result. This is not continuous
  authorization or a claim that governance cannot change before actual inference
- Every cleanup-safe retry obtains a new claim and a fresh head check. An earlier
  admission does not authorize its next attempt after suspension
- Invalid plan/job bindings finish blocked as `governance_plan_rejected`.
  Operational database failures remain cleanup-safe retries, not immutable
  validation rejections. Unverified cleanup and expired claims retain the
  existing recovery behavior

Completed outcome replay returns the stored result without new workspace lookup
or inference, even after later suspension. Admission is required for an exact
completed governed claim; failed completion rolls domain writes back atomically.
Enqueue checks freshness before sending, but a change during partial enqueue is
still safe: callbacks recheck before admission. Retry the exact plan to recover
partial enqueue or a lost acknowledgement. Queue dedup and the durable ledger
preserve the same identities; they do not promise model exactly-once execution.

## Identity, replay and limits

A plan ID is immutable. Identical normalized input retries recover the original
plan even if governance changed. Reusing that ID with changed input fails; use a
new explicit ID after examining stale state. New plan IDs create new job identities
and can intentionally cause another review. They are not automatic retries.

`reviews run --rule-digest ...` and application jobs without a
`governancePlanDigest` remain explicit historical/manual replay. CLI output labels
them `explicit-digest-replay-not-governance-governed`. The replay label is presentation metadata added by `reviews run`, not a field
in the stored review contract; `reviews show` returns the original domain record.
Existing domain/job hashes are unchanged. They may deliberately review an excluded version and must not be
interpreted as current governance eligibility. The plan/admission binding lives
in the application ledger; immutable review/findings/feedback schemas retain
their existing identities and evidence contracts.

A plan permits at most 1,000 literal paths, 20 selected jobs and 2 MB encoded
payload. The registry retains its existing 100-rule, 100-version, 250-event and
16 MB read budgets. Exceeding a bound fails without saving a truncated plan.
Application payloads keep their 4 KB limit and existing bounded broker retry
policy. No plans or admissions are pruned automatically.

## Verification and limits

```sh
npm run typecheck
npm run build
npx vitest run tests/governed-semantic-review.test.ts \
  tests/governed-semantic-review.cli.test.ts --maxWorkers=2
node scripts/smoke-governed-semantic-reviews.mjs
npm test
```

Authored tests exercise root bootstrap → governed review → suspension → accepted
comparison-backed supersession → governed successor review, plus stale plans,
resolution/admission races, concurrent claims, deduplication, lost acknowledgement,
safe retries, no eligibility, bounds, immutable identities and persisted reopen.
They use local PGlite and real asynchronous pg-boss callbacks, not a live
PostgreSQL server. No credentials, live model/backend, upload, deployment or
publication are involved. These checks establish local contract behavior, not
semantic quality, authenticated human approval, production isolation or external
database crash recovery.


Final working-tree verification: **1,177 tests in 80 files passed**, with
`maxWorkers=2`, in 715.38 seconds. Typecheck, production build, compiled worker
configuration check, 30-document static deployment validation and diff-check
passed. The [compiled CLI smoke](evidence/compiled-governed-semantic-reviews-smoke-2026-10-02.json)
passed 16 checks with zero network attempts. See the
[verification record](evidence/governed-semantic-reviews-verification-2026-10-02.txt).
