# Run review batches from the CLI

`reviews batch run` now executes a stored batch and selectively retries failures
through the existing `runReviewBatch` API. There is no default inference mode:
choose explicit authored fixtures or an existing worker bootstrap configuration.
No arbitrary script/module is loaded from configuration.

## Local authored execution

Use ordinary semantic-review job JSON in `{ "id": "batch-1", "jobs": [...] }`.
Supply existing `ReviewFixtureSchema` JSON files, as for single `reviews run`:

```sh
npm run build
node dist/cli.js reviews batch create --db ./state --file batch-input.json \
  --offline-fixtures review-a.json review-b.json --out batch.json
node dist/cli.js reviews batch run --db ./state --digest <batch-sha256> \
  --offline-fixtures review-a.json review-b.json --out run.json
node dist/cli.js reviews batch status --db ./state --digest <batch-sha256>
node dist/cli.js reviews batch run --db ./state --digest <batch-sha256> \
  --offline-fixtures review-a.json review-b.json \
  --retry-job-digest <failed-job-sha256> --out retried.json
node dist/cli.js application-jobs history --db ./state --file exact-job.json
node dist/cli.js reviews batch export --db ./state --digest <batch-sha256> --out report.json
node dist/cli.js reviews batch export --db ./state --digest <batch-sha256> --format csv --out report.csv
```

Creation matches fixtures by exact rule, snapshot and context selection. Each job
must match exactly one selected fixture; ambiguity and unused inputs are rejected.
Multiple attempts may share one fixture. To disambiguate several fixtures for the
same rule/snapshot, the input job can explicitly select `offlineFixtureDigest`.
Creation freezes that digest into a distinct job identity. Existing live jobs
cannot silently become fixture jobs; create a separate offline batch.

Execution requires the exact frozen fixture bytes (canonical JSON identity).
These are authored declarations, not model judgments or developer feedback.
The CLI reports `executionMode: authored-offline-fixtures`, `modelExecution:
not_run` and `workspaceExecution: not_run`. It uses the existing offline semantic
review builder and atomically saves each review and application-job result. It
creates no workspace/model execution receipt and invokes no backend or resolver.
A logical `workspaceId` remains part of the existing job schema but is unused in
fixture mode. Governed/evaluation workspace claims are rejected for offline jobs.

Default resume handles not-started items and leaves retryable failures untouched.
`--retry-job-digest` explicitly selects existing failed jobs; completed or active
jobs are never restarted. Retry history survives process restarts. Changed fixture
content needs a new job/batch, not a retry under the old identity. Exit code 0 means
all jobs completed, 2 means the batch still needs action, and 1 reports input,
configuration, cancellation or infrastructure errors. Unknown findings remain
unknown even when review execution completes. SIGINT/SIGTERM requests cooperative
cancellation; committed results are retained.

For an offline continuation, create a new continuation with
`--offline-fixture-digest <canonical-fixture-digest>`. Its exported job then binds
that exact fixture and can be included in an offline batch. This does not modify
an existing workspace continuation or its original outcome.

## Existing trusted runtime configuration

```sh
node dist/cli.js reviews batch run --db ./state --digest <workspace-batch-sha256> \
  --config worker-config.json --retry-job-digest <failed-job-sha256>
```

This uses `WorkerBootstrapConfigSchema` and `composeWorkerApplication`; no second
runtime configuration format was introduced. The standard CLI can now construct the existing prepared-workspace resolver from
`preparedWorkspaces` configuration, but has no built-in production lifecycle
authority or credentials. Such a run
fails before a job claim rather than inferring authorization from JSON or reading
ambient credentials. Reviewed deployment code can pass the existing
`WorkerBootstrapDependencies` into `registerReviewBatchCommands` to compose an
already authorized runtime. Lifecycle authority and credential environment remain code-injected. Resolver
selection is either the fixed built-in `preparedWorkspaces` configuration or an
injected resolver, never arbitrary module paths or secret values in JSON. This work neither
sets up authentication nor validates live OpenSandbox/model execution.

## Verification

The [compiled CLI verification](evidence/review-batch-cli-verification-2026-10-13.json)
records 17 fresh CLI invocations on real upstream-source bytes in a selected-path
projection. It exercises offline continuation creation, batch creation/execution,
a one-time authored database insert failure, default resume, process restart,
explicit retry, repeat execution, history and JSON/CSV export. It checks no extra
reviews or fabricated receipts, unchanged original finding/outcome, unknown
preservation, and rejection of incorrect fixtures and untrusted configuration
before claims. No credential, model or workspace execution is used by batch run.
Setup separately uses the existing explicitly authored outcome harness.

```sh
npm run build
node scripts/smoke-review-batch-cli.mjs /tmp/flyrewheel-batch-cli-new
```

The source/projection boundary and authored fault are recorded in the evidence.
This is PGlite CLI acceptance, not PostgreSQL multi-process contention, live-model
accuracy, production authorization or frozen-research evidence. No W1 inputs are
read. Offline execution does not verify a source checkout; it validates registered
snapshot/context bytes using the same boundary as single `reviews run`.

See [real-mode readiness](worker-real-mode-readiness.md) for the current factual
limits and presence-only preflight commands; a valid config is not a working
production lifecycle authority.
