# OpenSandbox SDK execution adapter

## Status and boundaries

`src/adapters/opensandbox-workspace.ts` is a real SDK-backed adapter for `createCodexWorkspaceRunner(backend)`. It is opt-in trusted application code. The native worker and the runner's default remain fail-closed. There is no fixture fallback, live cluster, model call, credential lookup, login, provisioned image, or deployment in this increment. Nothing is published.

The adapter can allocate through the official SDK, transfer a Sandcastle full-history bundle, verify the exact checkout using an immutable image's worker, launch that worker, bound responses and output, and coordinate lifecycle/evidence operations. It does **not** pretend that the public OpenSandbox lifecycle API establishes the repository runner's stronger verification contract.

Without an `OpenSandboxLifecycleAuthority`, `prepare()` reports `OpenSandbox production blocked` before allocation. This dependency must be independently implemented for the chosen self-hosted k3s/runtime/storage deployment. It is not a job flag or an instruction to return `{verified:true}`. Tests supply an explicitly authored authority; that proves protocol behavior, not production isolation.

## Official API evidence (SDK 1.1.0)

Source inspected: the installed official npm package `@alibaba-group/opensandbox@1.1.0`, including its shipped TypeScript source, plus the [official JavaScript SDK documentation](https://open-sandbox.ai/sdks/javascript) and [official repository](https://github.com/opensandbox-group/OpenSandbox). Exact lock/integrity are in `package-lock.json`.

- `Sandbox.create(options)` provisions an image-backed sandbox. `image`, `resource`, `env`, `networkPolicy`, `metadata`, TTL, readiness timeout and AbortSignal are supported.
- `commands.runStream(command | argv, opts, signal)` yields SSE events through the official command adapter. Array commands avoid shell interpretation for verification and worker launch.
- `files.writeFiles()` supports Node async-iterable upload; `readBytesStream()` supports streaming reads. Read limits are not a substitute for client-side byte limits, and the SDK error path reads the entire error body.
- `pause()` acknowledges an asynchronous, runtime-dependent operation. A `Paused` state cannot establish all the required deployment invariants; pausing execd also prevents ordinary in-sandbox collection.
- `kill()` delegates to lifecycle DELETE. `close()` only releases local client resources. A DELETE acknowledgement or API 404 is not evidence that every runtime resource/process is physically gone.
- In `src/sandbox.ts`, create failure can trigger best-effort deletion whose error is discarded. Abort cleanup can be fire-and-forget. A create rejection may hide a remote allocation ID.
- The default connection timeout is cleared after response headers; SSE has no connection timeout. SDK JSON/SSE/error-body buffering is not a raw byte bound.

`BoundedOpenSandboxConnection` subclasses the SDK's public `ConnectionConfig` methods/getters. It replaces only fetch transport; the SDK's default lifecycle/files/commands adapters still construct and parse all protocol requests. There are no manually constructed OpenSandbox API requests, private-field patches, or custom fake production SDKs.

The transport enforces a finite response-body size and time bound, including SSE and error bodies; disallows redirects; restricts endpoint requests to the configured HTTPS origin/path prefix; and cancels the underlying body when limits are exceeded. It uses explicit API configuration, disables creation telemetry, and does not use the SDK's automatic client-IP probe transport. A key, when explicitly supplied by trusted deployment code, stays in control-plane request headers and is absent from sandbox create data, uploads, command arguments and forwarded environment. Raw SDK failures are not surfaced as worker output.

## Sandcastle transfer

`src/workspace/sandcastle-transfer-process.ts` uses the actual public `createWorktree`, `createIsolatedSandboxProvider`, and `worktree.createSandbox` APIs from Sandcastle 0.12.0. Sandcastle owns `git bundle --all`, upload, clone, branch checkout and its host/remote HEAD check. This does not rewrite that library's Git transfer protocol.

The transfer child receives an explicit credential-free environment, absolute trusted Node/tsx loader paths, disabled Git hooks/config helpers/network transports, and a private temp root. It rejects `.sandcastle/.env` without reading the contents. No Sandcastle agent, hooks, environment forwarding, copy paths or sync-back is enabled. The parent only accepts bounded transfer RPCs, safe temp-bundle paths and a regular file under its owned temp root, and uploads in 64 KiB chunks. The fixed remote checkout is `/workspace/repo`. The existing host worktree is retained. Transfer requires its active execution lease and reuses the workspace manager's repository-operation lock, orphan-directory refusal and before/after exact clean identity checks; upstream pruning cannot silently delete unregistered evidence.

Sandcastle creates its temporary bundle **on disk before** `copyIn`. The upload is byte-bounded; upstream disk generation requires an external host scratch-disk quota. Failed local transfer temp directories are retained for recovery. A transfer process exit is not a container receipt. Repository object contents, including full history, are deliberately transferred; this does not prove temporal isolation or that committed data contains no secrets. Dedicated source-store admission remains necessary.

## Immutable image/worker protocol

Trusted configuration requires an image pinned by sha256 digest, explicit resource limits, a HTTPS control-plane endpoint, a maximum bundle size, a gateway hostname and an executable below `/opt/flyrewheel/`. It exposes no general sandbox env/mount/lifecycle-hook option. Create requests contain an empty environment and no volumes, deny-default egress with only the configured gateway hostname, a finite TTL, and a unique allocation metadata token.

The image must actually implement:

1. `workerExecutable verify EXPECTED_SHA EXPECTED_BRANCH all-local-refs-v1`, executed in `/workspace/repo`, returning one JSON `RuntimeObservation` on stdout. It must independently verify exact SHA, branch identity, full history, cleanliness including ignored/untracked files and index flags, and repository/ancestor configuration restrictions
2. `workerExecutable run /run/flyrewheel/request.json`, returning a bounded JSON result on stdout, using the existing official Codex SDK worker contract inside the isolated runtime

Input contains working directory, explicit model, optional reasoning effort, prompt, tool/history policies, fixed output contract and limits. Matched requests additionally carry strict execution declarations and selected citation bindings through the [shared worker encoder](matched-workspace-runtime.md); native admission remains blocked before allocation. Worker event streams have cumulative byte and event limits, require exactly one completion, reject error/malformed/unexpected events, and reject output after completion. SDK streaming ends must still be observed before accepting a result.

The optional fixed `outputContract: "pr-mining-v1"` request selects the strict
mining schema and protocol-version-2 envelope. It is relayed by the adapter; no
request-supplied schema is accepted. Legacy generic answers remain protocol
version 1. Mining output is consumed by the [generation provenance adapter](pr-mining-model-boundary.md)
only after its existing runner lifecycle succeeds and cleanup is verified.

The executable implementation now lives in `src/workspace-worker-entrypoint.ts`, with schemas in `src/workspace/worker-protocol.ts`, checkout observation in `src/workspace/runtime-checkout.ts`, and an [immutable-input image build recipe](../deploy/workspace-worker/README.md). No image has been built or validated against a real runtime. The checked-in image configuration keeps model execution blocked.

`verify` uses the fixed `/usr/bin/git`, disabled ambient/system Git configuration and hooks, and bounded commands. It observes the requested full SHA and branch, standalone Git storage, full local-ref connectivity, tracked changes, all untracked bytes including ignored files, and assume-unchanged/skip-worktree flags. It refuses ancestor/repository `.codex` or Sandcastle `.env`, config includes/filters, partial history/alternates/grafts, unsafe Git control files and unsupported local configuration. A dirty or wrong-SHA checkout yields `clean:false` or `identityValid:false`; the adapter refuses it. Invalid configuration fails with a fixed diagnostic. The verifier establishes completeness of the received local refs; it cannot independently prove that the source advertised every original ref.

`run` reads only `/run/flyrewheel/request.json`, with no-follow regular-file validation and a 2 MiB pre-parse cap, then applies its strict input schema and the request's smaller byte limit. Unknown fields, provider overrides, credentials and custom output schemas are not accepted. It returns one versioned JSON envelope containing a schema-validated answer (`summary`, `changedFiles`, `checks`, `limitations`), usage, session identity, and process-group evidence. The serialized envelope is also bounded by `maxOutputBytes`. Failed runs emit a fixed JSON diagnostic on stderr and no result on stdout; exit 78 denotes an explicit production configuration block. A process-group receipt still does not establish whole-runtime isolation or cleanup.

The worker now supports a **trusted image-only** credential-free gateway profile. The profile fixes a HTTPS base URL and its exact allowed hostname; it accepts no API key, headers, environment keys, login cache, or authentication command. The official SDK generates a `flyrewheel_gateway` provider using `responses`, `requires_openai_auth=false`, disabled WebSockets and zero application retries. The supported provider keys are documented in the [official configuration reference](https://developers.openai.com/codex/config-reference/). These settings mean authentication must happen outside the sandbox; they do not establish a working route, account/plan compatibility or billing behavior. No live provider, credential or gateway was tested.

The checked-in profile is `{"schemaVersion":1,"gateway":{"kind":"blocked"}}`. Enabling a profile is an explicit, separately reviewed deployment configuration change, not a job flag. The executable checks necessary local root-owned/non-writable control paths and its dedicated UID; it cannot establish the external lifecycle/gateway authority. The adapter must still refuse allocation unless real `preflight` verification succeeds. Source/compiled tests use a function-injected, named authored fixture boundary; production CLI arguments and environment expose no fixture switch.

Production request delivery remains an explicit integration gap: the adapter currently creates a mode-0700 control directory and mode-0600 request through execd, while UID 10001 must be able to read but not modify control data. The deployment needs independently verified ownership/ingress and protection for the supervisor's temporary files and evidence against repository descendants. Image filesystem/UID controls must protect the worker, request/evidence files, supervisor and policy configuration. Empty create env, root-owned image files, or same-UID process-group supervision alone do not prove those properties.

## Required lifecycle authority

The production authority must establish all of these, with durable evidence keyed by the preallocated `allocationId`:

- Before create: verify actual isolation, no host/credential exposure, immutable worker/control files, CPU/memory/process/disk quotas, ingress/egress policy and a credential-isolated authenticated model gateway. The check is read-only and must fail without those capabilities
- Stop: durably fence allocation admission; reconcile all in-flight, late and unknown-ID creates carrying the token; terminate or freeze every repository/SDK/CLI descendant; independently verify the resulting process/runtime state and immutable evidence snapshot
- Collection: read regular-file artifacts out-of-band from the frozen snapshot/volume without resuming execd or repository processes. Reject links, special files and traversal before opening. Return incremental byte chunks. The adapter enforces unique safe names, count and cumulative byte limits before retaining chunks and copies accepted bytes
- Destroy: remove and independently verify all physical resources for the token, including orphan allocations. The adapter issues official `kill()` when it has a handle, but only authority evidence can make the result verified

`stop()` immediately fences future adapter work and aborts owned operations. It waits for setup/worker operations to settle, then asks authority to reconcile and verify; a late create cannot start a transfer or worker. The runner's cleanup deadline still bounds this wait. An unresolved/failed stop retains the lease and skips collection/destruction. Failed collection prevents destruction. Repeated stop/destroy reuse the same operation. No-runtime cleanup is only verified when allocation was never attempted.

Production k3s pause/freeze, external evidence storage, admission fencing, recovery and physical-removal implementations remain open deployment work. TTL is a damage bound, never verified cleanup. The lease deliberately remains blocked on uncertainty.

## Verification

Authored tests cover:

- Official SDK create, endpoint lookup, streamed argv command, file upload and kill using an in-memory HTTP transport; no server/network/model
- Real Sandcastle bundle production/public isolated-provider transfer, full refs, exact historical branch, byte refusal and `.env` rejection using authored remote responses
- Zero-allocation missing-authority refusal, config constraints, explicit secret-free create/worker data, ordered lifecycle, unverified stop/destruction, unknown and late creates, exact-SHA mismatch, missing/duplicate/error/oversized/post-completion output, and artifact count/bytes/path/duplicate failures
- Raw success/error response caps, redirects/origin confinement, cancellation and response-body deadlines
- Exact historical checkout observation, dirty/ignored/index-flag refusal, history/config restrictions and strict typed request/result handling
- Source and freshly compiled CLI protocols with explicitly authored fake CLI executables through the real Codex SDK; production CLI refusal paths, gateway option generation, supported progress events, malformed/unknown/duplicate/post-completion event failures
- Nine offline image-recipe checks for immutable base reference syntax, lockfile pins, default blocked profile, fixed wrapper, secret-excluding context and native asset staging; these do not build or execute a container

Run `npm run typecheck`, `npm run build`, and `npm test`. These results establish adapter contracts only. They do not certify a live self-hosted runtime or model authentication.

Post-change verification on 2026-10-02: typecheck passed; build passed; all 399 tests in 36 files passed with `--maxWorkers=2`, including 44 entrypoint tests; nine separate offline image-recipe checks passed; deployment validation passed for 30 YAML documents. Independent review has not completed. No live cluster, container image build, gateway, credentials, or model inference was exercised.
