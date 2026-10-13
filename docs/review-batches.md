# Explicit review batches

`reviews batch` freezes an ordered collection of 1–20 existing semantic review
jobs. Jobs may select different rules or snapshots, including exact governed or
continuation jobs. This fills the multi-snapshot explicit-review gap; the existing
governed plan still selects eligible rules for a single snapshot.

```sh
node dist/cli.js reviews batch create --db ./state --file batch-input.json --out batch.json
node dist/cli.js reviews batch show --db ./state --digest <batch-sha256>
node dist/cli.js reviews batch status --db ./state --digest <batch-sha256> --out progress.json
```

Input is strict JSON `{ "id": "batch-1", "jobs": [ /* semantic-review jobs */ ] }`.
Every job uses the existing application job contract. Creation validates registered
rules, snapshots, context and optional plan bindings; it does not run a model or
resolve a workspace. The complete manifest is append-only. Repeated identical
creation reuses it; changed jobs or order under the same ID are rejected. Duplicate
job identities are rejected. Existing job identities are not re-keyed by a batch:
sharing a job between batches shares its durable result.

Trusted application code runs the batch with:

```ts
await runReviewBatch(dependencies, batchDigest, signal);
// Only after inspecting the failure and correcting its cause:
await runReviewBatch(dependencies, batchDigest, signal, {
  retryJobDigests: [exactRetryableJobDigest],
});
```

The dependencies are the existing application dispatcher dependencies, supplied
by trusted bootstrap code. CLI creation/status intentionally cannot load a runtime,
model, credential or executable from JSON. Existing worker dispatch can consume
the exact manifest jobs individually. No authentication setup is added.

Each review/result commits independently through the existing dispatcher.
A persisted retryable failure does not prevent later batch items from running.
Resuming a batch processes not-started jobs only by default; failed jobs require
explicit digest selection. Completed and terminally blocked jobs stay unchanged.
Concurrent active owners are skipped, never stolen. The dispatcher still performs
governance admission and workspace verification for each job.

Cancellation and unexpected database/integrity errors stop the invocation;
earlier committed results remain queryable. After fixing a terminal blocked job,
create a new job attempt in a new batch instead of resetting the old record.
This feature adds no automatic scheduling, queue retry policy or external comments.
The current job ledger stores the latest retry result. A separate append-only
attempt history now preserves each observed failure/completion across retries.
Use `application-jobs history --db ./state --file job.json` to page through it.
The migration backfills only the current result and explicitly reports any older
missing attempts; already-overwritten historical failures cannot be recovered.

Status returns counts for not-started, running, retryable, completed and blocked
items, plus each job's exact identity, result, attempts and recovery guidance.
`needs_attention` means all items were attempted but at least one requires action;
`completed` means all jobs completed, not that findings were repaired or correct.
Status inherits expiry reconciliation from the application ledger and can record
an expired running lease as blocked. It never starts a review.

## Verification (2026-10-13)

Implemented after `4de5084ad03a8634289557f72cdbc6ec97cb53c0` in the local
`codex/explicit-review-continuation` branch. Tests use PGlite and authored SDK
executables with synthetic Git input and `modelExecution: not_run`; they provide
no real-model, developer-feedback, isolation or PostgreSQL-service evidence.

The focused test covers a first-item runtime failure followed by two successful
reviews, default resume without retry, explicitly retrying only the failed item,
completed-result reuse, database reopen, concurrent ownership, cancellation,
missing-runtime blocking, input rejection, immutability and CLI progress output.
The database migration suite covers migration compatibility. Build and typecheck
are required before committing. No old research results or W1 inputs are used.

## Descriptive JSON and CSV export

The independent export action reads existing results and provides a smaller
report suitable for local sharing or spreadsheet inspection:

```sh
node dist/cli.js reviews batch export --db ./state --digest <batch-sha256> --out report.json
node dist/cli.js reviews batch export --db ./state --digest <batch-sha256> --format csv --out report.csv
```

Each row includes job/rule/snapshot identities, attempt and execution count,
state, failure reason, model-execution boundary, cleanup, review ID, stored finding
counts and recovery instructions. Unreviewed items have null finding counts, not
zero violations; active jobs without results have unknown model execution. A
completed authored fixture remains `modelExecution: not_run`. Counts describe
stored declarations, not ground truth, empirical quality or successful repair.

JSON additionally includes an exact `retrySelection` suitable for the API's
options argument. It is a suggestion for inspection and explicit selection, never
an automatic retry instruction. It contains only currently retryable batch members.
CSV quotes fields, preserves multiline text and neutralizes spreadsheet formula
prefixes. JSON retains original text. Both formats leave domain records unchanged
apart from the existing expired-lease reconciliation performed by status reads.
A report reads items sequentially; it is not a transactional snapshot across jobs.

Export was implemented after batch commit `fa843e3`. Its focused check exercises
an authored runtime failure, a completed SDK fixture review and an active owner,
then exports JSON and CSV through fresh compiled CLI processes against the closed
persistent database. It verifies exact output, failure-only retry selection and
formula quoting; no inference is started by export. Reproduce the compiled check:

```sh
npm run build
REVIEW_BATCH_COMPILED_SMOKE=1 npm test -- tests/review-batch-export.test.ts
```

Without that flag, the test runs the source CLI so a normal test run does not
require preexisting build artifacts. This retains the same authored evidence
boundary as batch execution.
