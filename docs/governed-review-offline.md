# Execute an explicitly offline governed review plan

A governed plan can now freeze authored review responses and execute directly via
`reviews governed run`. This reuses the existing plan, dispatcher, admission and
atomic review/result storage. It does not require model credentials, a workspace,
a queue or production lifecycle authority. Candidates still require an explicit
comparison-backed local selection before they can appear in the plan.

## Create and execute

Use the existing plan input JSON (`id`, `repository`, `paths`, `snapshotDigest`,
`workspaceId`, optional `attempt` and registered `repositoryContextDigests`).
`workspaceId` remains a logical identity; no workspace is resolved in offline mode.
Supply one existing ReviewFixtureSchema JSON response per selected rule:

```sh
npm run build
node dist/cli.js reviews governed plan --db ./state --file plan-input.json \
  --offline-fixtures authored-response.json --out plan.json
node dist/cli.js reviews governed run --db ./state --digest <plan-digest> \
  --offline-fixtures authored-response.json --out execution.json
node dist/cli.js reviews governed status --db ./state --digest <plan-digest>
node dist/cli.js reviews show --db ./state --id <execution.jobs[0].result.outcome.id>
```

Multiple fixture files follow the same `--offline-fixtures` option. They must
match the plan's exact snapshot, registered context set and every selected rule;
missing, ambiguous and extra rule bindings are rejected. The optional
`plan.input.offlineFixtures` field stores normalized `{ruleDigest, fixtureDigest}`
bindings. Job identities include both plan and fixture digests. No new database
migration is needed; old plans/jobs retain their previous identities.

The run command requires the same authored bytes by canonical digest. Changed
responses fail before claims. It never derives a response from a decision or calls
a model. A legacy workspace plan must be recreated under a **new explicit plan ID**
with the fixture option; it cannot be silently converted. Offline plans cannot
claim evaluation exports or be enqueued by the governed enqueue command.

## Governance and recovery semantics

Execution checks current selection before starting, then reuses each job's existing
current-plan check and atomic governance admission. Suspension or any changed
registry head makes the old plan stale. A change between initial validation and
admission produces a blocked job with no review. This also applies on retries.

Admission remains the existing linearization point: a change **after admission**
does not revoke already admitted work. The result records that historical selection;
the status reports whether the registry still matches. This is not continuous
revocation or a new governance policy. New work needs a newly selected, current plan.
Even rerunning an already completed stale plan is rejected by this entry point;
`status` and `reviews show` remain available for historical inspection.

Repeated execution of a current plan reuses finished results. The existing governed
runner retries cleanup-safe retryable jobs on explicit reinvocation; a runtime or
persistence failure stops that invocation, leaving earlier results committed. This
is separate from the existing batch command's individually selected retry policy.
Cancellation uses the existing abort handling and durable attempt history.
The CLI returns 0 when every job completed, 2 when returned status contains a
noncompleted job, and an error exit for invalid/stale input or a thrown execution
failure. Inspect `status` and existing application-job history after a failure.

The result includes `reviewSelection: local-governed`,
`executionMode: authored-offline-fixtures`, `modelExecution: not_run` and
`workspaceExecution: not_run`. Each job exposes its exact rule/fixture digest,
admission plan digest, attempt and resulting review identity. The stored review
contains that rule digest, snapshot, fixture digest and `application-<jobDigest>`
attempt, with **no workspace/model execution receipt**. Thus its lineage is
review → job digest → admission → plan → selected version and governance evidence.
A completed offline job's existing `cleanup: verified` field does not claim sandbox
allocation or physical destruction; no workspace was started.

## Verification

```sh
node scripts/smoke-governed-review-offline.mjs /tmp/flyrewheel-governed-new-run
npm test -- tests/governed-review-offline.test.ts
```

Use a fresh nonexistent artifact directory. The compiled CLI flow uses the existing
synthetic revision demo to create feedback, imported candidate versions, comparisons
and explicit decisions; then it explicitly selects the accepted candidate, freezes
fixture responses in a plan and executes that plan directly. It verifies review
lineage, cross-process idempotence, altered-response refusal and stale-plan refusal
before any new claim. The focused tests also suspend selection immediately before
admission and verify no new review is saved.

[Recorded compiled flow](evidence/governed-review-offline-verification-2026-10-13.json).
Inputs are authored synthetic source snippets, candidate edits, judgments and
feedback; CLI/database/structural scan operations are real. No upstream-source
quality claim, real developer assessment, model call or substitute model runtime
is involved. Real-runtime authority remains a separate unsolved deployment gap.
No credential/W1 access or frozen research protocol changes are required.

## Post-commit interaction regression

On `db205be`, the related aggregate passed **109 tests in
19 files**, with 0 failed, 0 skipped and
0 todo (293.61 seconds). The 3 focused tests above
are included in this aggregate, not additional unique coverage.
Four prior compiled CLI flows were rerun on fresh databases: source-projection
restart, batch CLI/retry history, feedback discovery/freeze and revision explanation/
governance selection. All four passed. The new 19-command governed offline flow
also passed, as recorded separately above. Typecheck, build and diff checks passed.

[Exact commands and per-file counts](evidence/governed-review-offline-regression-2026-10-13.json).
No new regression was found. No unrelated full-suite repetition was performed.
