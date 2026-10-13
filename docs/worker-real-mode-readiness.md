# Real-mode wiring and offline preflight

Audit outcome: configuration alone does **not** make the ordinary CLI a ready
production model runner. A production lifecycle authority is an injected interface
in `src/adapters/opensandbox-workspace.ts`; there is no built-in implementation
of its four external control operations in `src`. The SDK backend factory exists,
but explicitly requires that authority. The local no-model trial scripts do not
implement this production contract and are not auto-selected as replacements.

The existing `createPreparedWorkspaceResolver` factory was available but not wired
into ordinary worker configuration. It is now connected through the optional
`preparedWorkspaces` field of `WorkerBootstrapConfigSchema`, reusing
`PreparedWorkspaceResolverConfigSchema` without a new runtime format or dynamic
module loading. Composition builds this resolver from exact selections, prepared
workspace identities and manifest digests. It does not prepare a workspace.
Supplying both a configured and injected resolver is rejected as ambiguous.

| Entry point | Actual execution capability |
| --- | --- |
| `reviews run` | Structural review or explicit offline fixtures; no worker-config option |
| `reviews batch run --offline-fixtures ...` | Explicit fixture review; no workspace/model receipt |
| `reviews batch run --config ...` | Existing worker composition; built-in prepared resolver now available, production authority still required |
| `node dist/worker.js` | Existing queue service with application runtime blocked unless trusted service bootstrap is used |
| `node dist/worker.js --config ...` | Explicit error before database/queue startup; config is not silently ignored |
| `startConfiguredWorkerService(config, dependencies, options)` | Reviewed deployment code injects the missing lifecycle authority and authorized credential environment |

## Check without inference or credential reads

```sh
npm run build
node dist/cli.js application-jobs bootstrap-check --config examples/worker/preflight-only.json
node dist/worker.js --check --config examples/worker/preflight-only.json
node dist/cli.js reviews batch preflight --db ./state --digest <batch-sha256> --config worker-config.json
node dist/cli.js reviews batch preflight --db ./state --digest <batch-sha256>
```

The checked-in [example](../examples/worker/preflight-only.json) is schema-valid
and intentionally inert: `.invalid` endpoints, placeholder image digest/model,
no workspace entries, no secret value and no authority. It is not a deployment
configuration or authorization. Its observed result is `blocked`, configuration
`schema-valid`, resolver `built-in-prepared-workspace-resolver`, and missing
production authority. In this session the selected `OPENSANDBOX_API_KEY` name was
also absent. Missing config is explicitly disabled and lists required fields.

These commands and the existing `application-jobs preflight --file job.json --config worker-config.json` path enumerate environment **names only**. A present name is reported as
`name-present-value-unread`; the value may be empty/invalid and authentication
remains `not_verified`. No credential files are inspected, values are never read,
and no authorization, SDK connection, allocation, resolver invocation or model
call is created. Programmatic trusted composition remains separate and necessarily
consumes its explicitly injected credential when real execution is authorized.

Batch preflight also compares each existing job's exact selector to configured
prepared-workspace entries. It reports `exact-config-selection-not-verified`,
`missing-exact-selection`, or a required dedicated evaluation resolver. It does
not inspect workspace paths/manifests or certify readiness. It never claims jobs.
Opening the explicitly selected database can apply ordinary pending migrations.
Offline-fixture batches are reported as offline, not certified as configured
workspace runs. Preflight emits a successful inspection response
with `status: blocked` when prerequisites are absent; malformed/unreadable input
files still produce a command error.

## Local development lifecycle

The separate [local workspace adapter](local-development-workspaces.md) now
creates fresh fixed-SHA worktrees, exports existing prepared resolver entries,
records content-hashed evidence and conservatively cleans its owned worktree.
`node dist/worker.js --check --local-development receipt.json` verifies this local
state and explicitly reports `productionReady: false`; it starts no worker
execution. Ordinary directory/worktree management supplies none of the external
production authority guarantees below. Production config checks remain blocked.

## Exact remaining blockers

The missing production authority must implement and independently establish:

1. Allocation fencing/reconciliation and deployment isolation preflight.
2. Whole-runtime stop with a frozen immutable evidence snapshot.
3. Bounded out-of-band frozen artifact collection.
4. Independently verified physical destruction, including unknown/late allocations.

An SDK success response, login, boolean JSON flag or fixture result does not supply
these operations. No factory was fabricated. This is an implementation/deployment
integration gap **in addition to** any absent authorization/credential; it is not
blocked solely by user login. An authorized deployment must also have a real
pinned worker image, endpoint/gateway, exact prepared workspace entries and
explicit credential provisioning. No such deployment was configured or tested
by this change, and no login or persistent authorization was created.

## Verification

[Recorded compiled command outputs](evidence/worker-real-mode-preflight-2026-10-13.json)
cover valid-example, missing-config and worker config-start rejection. Focused
checks verify no credential-value access (a throwing getter), fixed resolver
composition without runtime operations, ambiguous configuration rejection and
compiled batch preflight for exact declared, missing and invalid configuration.
The batch test uses a deliberately nonexistent workspace path: it would fail if
preflight attempted to resolve it. No job is claimed. Synthetic dependency objects
only test wiring, not production lifecycle guarantees. No W1 data was read.
