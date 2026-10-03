# Bounded Codex workspace execution contract

This increment implements a testable execution boundary, not a provisioned production runner. `createCodexWorkspaceRunner()` with no backend fails closed. Nothing selects an authored fixture when production is unavailable. No login, credentials, network model call, OpenSandbox instance, deployment, or live repository-code execution was performed for these tests.

## Request and checkout identity

`src/workspace/codex-runner.ts` accepts an exact `WorkspaceIdentity`, immutable `expectedSha`, explicit model, `full-repo-shell-v1` tool policy, `all-local-refs-v1` history policy, prompt, and byte/time/artifact limits. The strict request schema accepts no environment, credentials, provider overrides, arbitrary executable, hooks, or configuration. The entire serialized request is subject to the input limit. The SDK worker additionally bounds its serialized input plus output schema.

A fixed optional `outputContract: "pr-mining-v1"` selects the typed mining
response in the immutable worker. Omitting it preserves the original generic
answer contract. Neither route accepts arbitrary request-provided output schemas.
The [mining execution adapter](pr-mining-model-boundary.md) waits for this runner's
complete cleanup receipt before granting a candidate persistence capability.

The worker also has fixed `matched-proposal-v1` / `matched-review-v1` contracts
for the [local matched-experiment bridge](../experiments/matched-revision/README.md#bounded-official-codex-sdk-bridge).
They require selected-evidence/no-tools execution and an explicit controls
declaration. Current frozen temperature/seed/output-token requirements fail
before dispatch with SDK 0.159.2. An explicitly authored script can exercise
the contracts without claiming those controls or real inference. The [matched workspace transport](matched-workspace-runtime.md) now carries fixed
matched requests, selected citation bindings and optional reasoning settings in the
outer runner/OpenSandbox wire protocol. Its native declaration is denied before
lease/allocation until deployment-backed gateway and monetary admission exist;
authored exceptions still cannot cross into isolated execution.

The managed host worktree must be `ready`, identity-valid, and independently clean (including ignored/untracked files and suspicious index flags). `expectedSha` must equal both the observed checkout and the manifest's `baseSha` / `initialHeadSha`. `prepareWorkspace({baseSha, headSha})` checks out **baseSha**, not headSha. A second independent runtime observation must report the same SHA, cleanliness, identity, and history policy before worker launch.

`all-local-refs-v1` means that later commits reachable from local refs may remain visible. It is intentionally **not temporal isolation**, a train/test split, or protection from answer leakage. A worktree is **not a sandbox**.

## Lease and lifecycle

The workspace manager's new `acquireWorkspaceExecutionLease()` creates a cooperative `active-execution` lease while holding the existing repository operation lock. `cleanupWorkspace()` refuses that active lease under the same lock. Other managed runs cannot acquire it simultaneously. Lease ownership is checked at release; there is no expiry or automatic stale-lock removal. A process crash or unverified cleanup keeps a blocking recovery lease. This protects cooperating FlyReWheel operations, not arbitrary filesystem writers, Git commands, other users, or OS-level process isolation.

The injected backend reserves a side-effect-free handle synchronously before any asynchronous setup. The handle owns partial setup as well as the worker. Execution follows:

1. Acquire lease and verify host checkout
2. Reject `.sandcastle/.env` at host repo/worktree without reading its contents
3. Prepare owned runtime and verify its independent checkout observation
4. Execute within a shared prepare/execute deadline
5. Request stop and independently verify that all pending setup, SDK/CLI, and repository descendants have stopped
6. Collect bounded evidence with constrained unique artifact names, copy returned bytes, and hash each artifact
7. Destroy runtime and independently verify destruction
8. Release the host workspace lease

Abort or a timeout is merely a stop request. An unverified stop skips collection and destruction. Failed collection preserves the stopped runtime. Failed or timed-out destruction retains the lease. Cleanup failure converts a nominal worker success into an execution failure. Partial artifact evidence is not silently discarded by destroying an uncollected runtime. The host worktree is never removed by this runner; its ordinary explicit cleanup remains separate.

The coordinator's output/artifact size checks are **acceptance checks**. A trusted backend must enforce collection/output limits before materializing bytes and must fence pending asynchronous operations on stop. It must not claim that `Promise.race`, event counts, or a settled direct-child promise bound an external runtime. The current result contains bounded copied evidence in memory; durable evidence persistence is a separate deployment responsibility.

## Official SDK worker and raw-byte supervision

`src/adapters/codex-workspace-worker.ts` imports the actual pinned `@openai/codex-sdk@0.159.2`. Tests use its real `Codex`, `startThread`, `runStreamed`, argument translation, JSONL decoding, completion and exit handling with a self-authored `codexPathOverride` executable. They do not mock the SDK or call a model.

The worker creates empty dedicated HOME/CODEX_HOME directories and supplies a complete literal environment (HOME, CODEX_HOME, PATH, LANG, LC_ALL), rather than inheriting `process.env`. It never reads authentication files. The SDK adds its non-secret originator variable. The worker uses:

- Explicit model and canonical `workingDirectory`
- Optional explicit `modelReasoningEffort` via the pinned SDK's typed thread
  option; absent input stays absent, without an invented default. Valid values
  are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent`
- `sandboxMode: workspace-write`, `approvalPolicy: never`
- `networkAccessEnabled: false`, disabled web search
- No additional directories; Git repository checks remain enabled
- Shell/unified execution enabled for the intended full-repository test/edit workflow
- Disabled hooks, multi-agent/apps/memories and automatic skill MCP installation
- Empty MCP config, fixed provider selection, empty shell environment inheritance
- Project-document byte limit zero; repository AGENTS text does not become policy

Production rejects `.codex` at the checkout/launch path or any ancestor. Test-only authored executables do not load Codex config; their explicit fixture-root scope makes this test independent of the host's unrelated ancestor config. Neither this exception nor a local fixture is a production isolation route. CLI config acceptance itself has **not** been tested against a real Codex executable, so unknown feature/config differences remain an operational verification requirement.

The SDK has no remote spawn transport, buffers stderr, and uses readline JSONL parsing without a raw-byte cap. Its AbortSignal only targets its direct child. This worker therefore supplies a trusted executable shim to the SDK that:

- Spawns the trusted CLI executable as a Linux process-group leader
- Counts combined stdout/stderr bytes before forwarding anything to the SDK
- Stops forwarding and kills the process group on overflow, cancellation, or timeout
- Applies output backpressure and records bounded process metadata
- Kills same-group background descendants when the direct executable exits
- Checks Linux `/proc` for remaining live members before reporting group stop

The evidence is a **process-group** receipt, not proof that an entire hostile process tree or container stopped. A malicious `setsid` descendant can escape process groups. The external sandbox backend must stop and independently verify the entire container/VM before collection. This shim also does not provide CPU, memory, disk, network, filesystem, or credential isolation by itself.

When explicitly supplied, `processEvidence.modelReasoningEffort` records the
setting forwarded through the typed SDK option, on successful and failed process
receipts. Missing fields in existing or unspecified receipts stay missing. This
is not an assertion that a real CLI/model accepted the setting. The matched
bridge uses one shared setting across its arms and stages; its mandatory
temperature/seed/output-token preflight and production block remain unchanged.

SDK 0.159.2 removes child event listeners when its generator closes. Aborting again afterward can trigger an unhandled `AbortError`. The worker therefore does not pass a caller AbortSignal to the SDK. Cancellation writes a bounded marker to the trusted supervisor control directory; the shim observes it every 10 ms and terminates its process group. The worker then waits for the separate stop receipt. This also avoids the SDK's asynchronous output-schema-cleanup race window; a late cancellation never targets an SDK child whose error listeners were removed. Missing or invalid process evidence retains the worker scratch directory and returns its recovery path in `CodexWorkspaceWorkerError`.

## Sandcastle and intended production boundary

Inspection of actual `@ai-hero/sandcastle@0.12.0` confirms that `createSandbox` reads `.sandcastle/.env` and resolves empty values through ambient `process.env`. The new runner rejects that file and does not call `worktree.run`, untrusted hooks, or Sandcastle agent providers. No environment-forwarding option exists in the request. Any later Sandcastle transport integration must additionally prove that provider/runtime setup inherits no secrets.

The intended production arrangement remains the official SDK and CLI **inside OpenSandbox**, with full repository history transferred deliberately and a credential-isolated gateway outside the repository-execution boundary. There is no implemented production OpenSandbox provisioning/transport, gateway authentication or routing, verified sandbox stop/destroy adapter, resource quotas, or durable bounded artifact collector in this increment. An injected `isolated-runtime` backend and worker-boundary verifier are trusted application code, not a user-settable assertion or proof of isolation.

Before enabling production, implement and verify those pieces, including orphan/partial-allocation recovery, immutable supervisor/evidence storage inaccessible to repository commands, read-only control-plane mounts, prevention of repo-config/provider re-enablement, denial of container/host escape, and authoritative descendant termination. The local tests establish protocol behavior only; they do not establish those isolation guarantees.

## Verification

Dedicated tests cover success, actual SDK option generation, invalid schema, malformed JSONL, nonzero exit after a completion event, missing completion, cancellation, timeout, raw stdout/stderr flooding without newlines, unexpected tool activity, config refusal, input/output/artifact bounds, exact SHA, dirty checkout, cooperative cleanup exclusion, and stop/collection/destruction failures. Existing workspace lifecycle tests are rerun to check lease integration.

Run:

```sh
npx vitest run tests/codex-workspace-runner.test.ts tests/codex-workspace-worker.test.ts tests/workspace.test.ts --maxWorkers=2
npm run typecheck
npm run build
```
