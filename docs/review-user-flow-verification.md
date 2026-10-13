# Review user-flow acceptance, 2026-10-13

The complete continuation → batch → failed item → explicit retry → history →
JSON/CSV export flow passed across separate Node processes reopening one local
PGlite database. A real implementation defect was fixed first: retries previously
cleared the only stored failure result. Commit `3e9dc82` adds an append-only attempt
result archive, migration of surviving current results, and paginated history.
Unknown/missing historical attempts are explicitly reported rather than invented.

## Input and execution evidence

Source bytes come from the existing GitHub checkout, upstream diff
`0b476d9f6835fec63b3b924c0de3120d3c79922f` →
`1bc2afffdd28c5ebde64f81e39944d816fdca8f7`. Only
`src/application-preflight.ts` and unchanged `src/core/identity.ts` were read.
A local two-file projection preserves those source bytes and makes the original
added-file diff runnable without reading or checking out research/W1 contents.
Its Git SHAs are explicitly different from the original repository SHAs.

Rules, feedback, diagnoses and review responses are authored. The backend returns
explicit authored runtime envelopes, not SDK or model calls. Actual Git capture,
source/context revalidation, workspace lifecycle, dispatcher and database paths
execute. This is plumbing acceptance with real source bytes, not a live-model,
semantic-accuracy, complete-repository or developer-acceptance experiment.

The [machine-readable verification record](evidence/review-user-flow-verification-2026-10-13.json)
contains source/projection SHA bindings, source hash, exact process commands,
execution trace, retained retry history and final report. Original session artifacts
remain in `/tmp/flyrewheel-real-source-flow-3`, including `report.csv`,
`cancel-status.json`, `interrupted-history.json` and the persistent database.

Observed behavior:

- Initial first-item runtime failure remained retryable; the second item completed.
- After a process restart, concurrent API retry calls plus repeated delivery ran
  the failed review exactly once. The successful second review was reused.
- A new process read both attempt 1 `failed/runtime_failed` and attempt 2
  `completed`; original finding, feedback and outcome were unchanged.
- Both completed review jobs retained one `unknown` anchor and zero `safe` anchors.
  Continuation assessment stayed `unknown`; completed execution was not repair.
- Cancellation after runtime entry left the first item retryable with reason
  `cancelled`, and the next item not started.
- A separate process exited with an uncompleted claim. Accelerating its lease
  timestamp in the authored harness caused a subsequent CLI query to record
  `blocked / interrupted_execution_requires_recovery / modelExecution: unknown`.
  This tests expiry handling without pretending 15 minutes actually elapsed.
- CSV handling preserved quotes/newlines and neutralized `=`, `+`, `-`, `@`, tab
  and newline prefixes in authored cell samples. JSON and CSV exports started no
  runtime and made no external comments or activation changes.

The first harness revision correctly hit the existing Unknown-feedback operator
gate; the final fixture uses an explicit authored FP routing label, never human
feedback. A second harness revision tried to allocate an existing workspace after
restart; the resolver now inspects/reuses the prepared workspace. Neither correction
relaxes product validation or changes historical research policy.

## Exact user entry points

All CLI examples use `node dist/cli.js` after `npm run build`:

```sh
node dist/cli.js revisions continuations create --db ./state --id followup-1 \
  --outcome-digest <outcome> --finding-id <finding> \
  --repository-context-digest <context> --workspace-id <workspace> --attempt followup-1
node dist/cli.js revisions continuations status --db ./state --digest <continuation>
node dist/cli.js reviews batch create --db ./state --file batch-input.json
node dist/cli.js reviews batch status --db ./state --digest <batch>
node dist/cli.js application-jobs history --db ./state --file exact-job.json
node dist/cli.js reviews batch export --db ./state --digest <batch> --out report.json
node dist/cli.js reviews batch export --db ./state --digest <batch> --format csv --out report.csv
```

Actual execution remains a trusted application API:
`runReviewBatch(dependencies, batchDigest, signal)`. Explicit retry uses the same
function with `{ retryJobDigests: [exactFailedJobDigest] }` as its fourth argument.
Standalone continuation uses `runReviewContinuation(dependencies, digest, signal)`.
There is no general `reviews batch run` CLI and no implicit runtime bootstrap.
The verification driver supplies authored dependencies itself; it must not be
presented as a production model runner.

Reproduce the full acceptance flow with a new output directory:

```sh
npm run build
node scripts/smoke-review-user-flow.mjs /tmp/flyrewheel-user-flow-new
```

## Remaining usability limits

An operator must still supply trusted runtime/workspace resolver code to execute
batches locally; CLI creation, inspection and export alone do not execute reviews.
Workspace resolution must persist/recover its mapping across process restarts.
PGlite was reopened by sequential processes; concurrent API calls shared one owner
process. Multi-process PostgreSQL contention and live-model behavior were not
validated. Existing overwritten failures from before migration cannot be recovered.
Reports read jobs sequentially and are not an atomic cross-job snapshot.
