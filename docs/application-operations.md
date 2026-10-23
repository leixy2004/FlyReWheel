# Explicit semantic-v2 application operations

This slice connects existing domain storage, job contracts, pg-boss and worker
service interfaces. It does not implement a deployment lifecycle authority or
authorize model spending. The default executable remains fail closed. No JSON
field can enable a fixture fallback, load a module, or supply a trusted resolver.

The [explicit worker bootstrap](worker-application-bootstrap.md) now connects the
actual executable to those injected capabilities using explicit CLI opt-in and
a reviewed module digest. Default behavior and queue/JSON authority boundaries
remain unchanged.

## Prepare and inspect real inputs without inference

Use one explicit database for domain records and jobs. `--db` selects local
PGlite; `--postgres` explicitly selects `DATABASE_URL`. Ambient credentials never
switch the destination. Opening either store uses the existing migrations.

Import a frozen GitHub evidence package with `github-pr import`, then use its
existing request input. A W0 source package's `evidence` member is that GitHub
package; retain the complete original source package for provenance. The three
W0 request inputs are under
`experiments/temporal-pilot/w0-first-three/mining-preparation/`.

For a store already prepared by the W0 offline preparation:

```sh
node --import tsx src/cli.ts application-jobs prepare-mining \
  --db /absolute/path/to/research-db \
  --request experiments/temporal-pilot/w0-first-three/mining-preparation/request-input-3035.json \
  --workspace-id httpx-w0-3035 --candidate-created-at 2026-10-03T23:00:00Z \
  --attempt initial --job-out /absolute/path/to/new-job-3035.json
node --import tsx src/cli.ts application-jobs preflight \
  --db /absolute/path/to/research-db --file /absolute/path/to/new-job-3035.json
node --import tsx src/cli.ts application-jobs recovery \
  --db /absolute/path/to/research-db --file /absolute/path/to/new-job-3035.json
```

Repeat for 3031 and 3036 with their corresponding input, workspace ID and output.
The timestamp is an explicit preparation/attempt timestamp, never a historical
evidence cutoff. `prepare-mining` idempotently persists the request and exports
the normalized job; **it does not persist a queue job or claim execution**. An
existing identical job file is reused; conflicting bytes are never overwritten.
If writing the file fails, the immutable request may already be stored; rerun
with a valid new output path. No candidate or finding is fabricated.

`preflight` reads domain bindings, candidate timestamps, selected revision
snapshots, review context and governed-plan freshness. It emits the exact
repository and expected SHA (mining=mergeBase, review/revision=head), plus each
missing deployment dependency and its next action. It never calls the resolver,
SDK, backend, model or queue, and does not reconcile job leases. A configured
report means dependencies are present, not that live workspace/lifecycle checks
have passed. Evaluation bindings still require trusted resolver verification.

Revision preflight validates the frozen feedback graph and existing holdout
exclusions without reserving source content as training. Actual generation
revalidates and reserves the consumed content before runtime execution; a
preflight result does not reserve data or guarantee that a later execution will
remain admissible. Fixture labels stay separate from caller-declared human
verdicts, and readiness checks do not resolve Unknown or Disputed attribution.

## Explicit composition and the external deployment boundary

`application-jobs bootstrap-check --config /absolute/admin-config.json` checks a
separate strict configuration. Without a file it reports disabled and missing
prerequisites. A job never includes paths, backend/model settings, credentials
or module names. The administrator config accepts only the fixed OpenSandbox
backend, explicit enabled/model/generation limits and bounded runtime settings.
Credential values are not JSON fields: `runtime.apiKeyEnv` names the one
environment entry consulted. Diagnostic output never includes its name/value
or the configured endpoint.

Configuration shape (illustrative `.invalid` endpoints, disabled by default;
replace only through reviewed deployment configuration):

```json
{
  "schemaVersion": 1,
  "enabled": false,
  "model": "deployment-selected-model",
  "generationLimits": { "maxInputBytes": 262144, "maxOutputBytes": 131072, "timeoutMs": 30000 },
  "runtime": {
    "id": "reviewed-opensandbox-runtime",
    "backend": "opensandbox",
    "endpoint": "https://sandbox.example.invalid",
    "apiKeyEnv": "DEPLOYMENT_SANDBOX_KEY",
    "image": "registry.example.invalid/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "cpu": "1000m",
    "memory": "512Mi",
    "maxBundleBytes": 1048576,
    "workerExecutable": "/opt/flyrewheel/bin/workspace-worker",
    "gatewayHost": "gateway.example.invalid",
    "limits": {
      "maxInputBytes": 262144, "maxOutputBytes": 131072, "timeoutMs": 30000,
      "cleanupTimeoutMs": 1000, "maxArtifactBytes": 1024, "maxArtifacts": 1
    }
  }
}
```

The named environment entry must be provisioned externally; this example neither
contains a credential nor permits model spending. Enabling this JSON alone still
reports missing code capabilities. Bounds constrain each execution; they do not
replace the deployment's monetary authorization or cumulative spend controls.

The exported `composeWorkerApplication(config, dependencies)` builds the existing
isolated backend/runtime without allocating it. The exported
`startConfiguredWorkerService(config, dependencies, serviceOptions)` composes
first, then delegates to `startWorkerService`. Reviewed deployment code supplies:

- `authority`: actual `OpenSandboxLifecycleAuthority` implementing preflight,
  allocation fencing, whole-runtime stop, out-of-band frozen artifact reads,
  and independently verified physical destruction.
- `resolveWorkspace`: a trusted lookup of already prepared and authorized exact
  workspace identities, including evaluation bindings when selected by a job.
- Explicit configuration and credential provisioning under the deployment's
  authorization and spending policy; JSON presence is not such authorization.

The repository does **not** supply that deployment-specific authority. The
ordinary CLI cannot inject it, and there is no dynamic module loader. The worker
image/gateway/isolation checks remain external prerequisites. Captured changed
files are not full repository workspaces. Composition tests use declared authored
dependencies; these are never claimed as production authority or model results.

## Persist, observe and recover through the existing queue

Once an authorized deployment implements those dependencies, import the domain
records and prepare the request in its **same PostgreSQL database** using
`--postgres`. Local PGlite records do not magically transfer to that database.
Then use the existing commands:

```sh
node --import tsx src/cli.ts application-jobs enqueue --postgres --file /absolute/job.json
node --import tsx src/cli.ts application-jobs status --postgres --file /absolute/job.json
node --import tsx src/cli.ts application-jobs recovery --postgres --file /absolute/job.json
```

`enqueue` persists through pg-boss, not another scheduler. With the default
unconfigured worker it will finish **blocked/runtime_unavailable**, not mine a
rule. Do not enqueue merely to test readiness. The new offline commands do not
start network services or model calls.

`recovery` explicitly uses the existing durable status operation: an expired
running claim may become terminally blocked with modelExecution=unknown and
cleanup=retained-for-recovery. It never resets records or retries:

| State | Next action |
| --- | --- |
| not_started | Check prerequisites, then explicitly enqueue in PostgreSQL. |
| running | Inspect the owning worker; do not steal its lease or duplicate it. |
| retryable | Inspect cleanup and fix the cause; explicitly re-enqueue the identical job. |
| finished/completed | Inspect its domain outcome, including insufficient-evidence; delivery completion need not produce a rule. |
| finished/blocked with retained runtime or unknown model activity | Reconcile, stop, collect and destroy using deployment authority; review possible prior model activity before any new attempt. |
| other finished failure/block | Fix prerequisites and inspect execution/cleanup; deliberately authorize a new attempt identity. The old job remains immutable. |

Changing attempt changes job/candidate identity. It is not permission to bypass
cleanup, governance or spending checks. Neither recovery nor configuration
automatically activates rules. Continue with semantic-v2 governance/review,
feedback, revision and comparison commands; legacy-v1 replay is not this route.
