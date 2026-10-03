# Matched requests on the existing workspace transport

This slice connects typed matched request/result **data** to the existing workspace
runner and OpenSandbox worker encoder. It does not enable native inference, provide
an isolation or billing authority, or run an empirical study. No new runtime,
credentials, gateway, callback-based permission framework or dependency is added.

## Implemented path

`buildSdkNativeMatchedWorkspaceRequest()` in `src/matched-workspace.ts` takes the
existing strict `SdkNativeMatchedRequest`, exact workspace/SHA/history binding,
selected response-evidence IDs and ordinary `WorkspaceLimits`. It verifies the
fixed stage output schema, snapshots and freezes the inputs, and produces a strict
`CodexWorkspaceRequest` with:

- `matched-diagnosis-v1`, `matched-proposal-v1` or `matched-review-v1`; gate and
  future remain distinct stages in the selection binding
- An explicit requested model and optional reasoning effort; omitted effort stays
  omitted. Neither field claims effective provider settings
- `selected-evidence-no-tools-v1`, the unchanged selected-evidence prompt and exact
  evaluation/export identity when supplied
- `matchedExecution: { kind: "sdk-native-pending-admission", profile:
  "paired-restriction-sdk-native-v1-draft" }`; this is a declaration, **not approval**
- Stage-scoped `matchedEvidence`: proposal permitted/required citation IDs,
  diagnosis feedback IDs with their own permitted/required citations, or review
  target IDs with their own permitted/required citations

The native declaration accepts no sampler, generation seed or output-token cap.
The old frozen-control route still refuses its unsupported temperature, seed and
output-token requirements. Removing those unsupported requirements is legitimate
for the separately identified native profile; it does not itself authorize spending.

`buildWorkspaceWorkerInput()` is the single fixed encoder now used by the actual
OpenSandbox adapter. It carries matched declarations, selected IDs, optional
reasoning effort, policies, limits and exact evaluation binding without a
request-provided schema, environment, executable, provider override or credentials.
Its byte bound applies to the complete encoded request. The SDK worker separately
counts its input plus the fixed JSON schema before launch.

Selected IDs are response bindings, not proof that a caller's prompt contains
accurate or genuine evidence. The caller must derive them from the same frozen
selected source graph used to render the prompt. Existing matched episode,
proposal-policy, diagnosis-source, state-budget and review/scoring validators
remain necessary; this transport layer neither replaces them nor applies H's
policy to the other arms.

## Response and cleanup acceptance

The worker checks selected-ID binding when `matchedEvidence` is present. The
outer runner independently checks matched output after its existing full cleanup
sequence. It requires:

1. The fixed stage schema and matching output contract, request digest, backend
   boundary and explicit forwarded reasoning setting
2. Every selected target/feedback exactly once, no additional identities and
   citations belonging to that exact target/feedback's selection. Required
   citations may not disappear; proposal replacement citations are also bounded
3. Successful bounded process-group evidence and usage sanity checks
4. The unchanged complete workspace lifecycle, verified stop, collected bounded
   artifacts with matching digests, verified destruction and released lease

A malformed answer becomes a failed execution. Its bounded output and cleanup
receipt remain available for diagnosis; a valid-looking answer with unverified
cleanup cannot be accepted. `MatchedWorkspaceWireResult` describes wire bytes,
including an isolated diagnosis envelope; parsing it does not establish that any
execution occurred. The existing authored diagnosis entrypoint/result schema
remains explicitly authored-only.

Neither citation membership nor a local process-group receipt proves semantic
correctness, independent annotation, provider acceptance, whole-runtime containment,
monetary admission, rule activation or permission to persist an empirical result.
No cost is inferred from tokens, and unknown cost is not represented as zero.

## Current denial points

The native declaration is unconditionally denied by the existing matched policy at:

- Outer runner, before acquiring a workspace lease or calling `reserve()`
- OpenSandbox `reserve()`, including direct callers, before allocation/preflight
- SDK worker, before runtime verification, executable access or SDK invocation

The denial states the actual missing implementation: deployment-bound gateway
admission and an authorized monetary arrangement. No serialized authorization,
configuration/call-record digest, backend label, environment flag or authored
exception removes it. Authored exceptions still fail under an isolated boundary.
The checked-in worker gateway is also blocked and the real OpenSandbox lifecycle
authority is still absent. Those are separate deployment gaps.

An unknown measured cost need not permanently forbid a native call. A future
operator-authorized monetary arrangement may permit bounded exposure with unknown
cost, if its scope, stop conditions and reconciliation are explicitly agreed and
enforced. Alternatively a claimed hard money ceiling needs actual reservation and
overshoot enforcement. The native profile does not require invented exact billing,
unsupported sampler controls or provider attestation simply to forward supported
settings. Requested/forwarded settings must still be distinguished from verified
effective settings and from evidence sufficient for an empirical conclusion.

## Smallest next deployment-backed slice

There is no selected live deployment or gateway in this checkout. Adding a
`verify: async () => {}` callback, `approved: true`, or a new receipt schema cannot
close the gap. The next implementation must target a **specific already authorized
OpenSandbox deployment and its external controller/gateway**, with the following
concrete responsibilities on the existing interfaces:

1. Implement `OpenSandboxLifecycleAuthority` against that deployment's real
   allocation registry/runtime observer: bind the preallocated `allocationId` to
   the actual workload, audit image/policy/storage configuration, fence late
   allocations, observe stop, collect regular files out of band, and observe
   physical destruction. SDK `pause`, DELETE acknowledgement, 404 or a process-group
   receipt are insufficient substitutes. Choose the implementation only after the
   actual runtime's supported controls/observation API are known
2. Extend that same trusted preflight/admission integration to bind the exact
   request digest, selected model, per-call limits and allocation to the external
   gateway's authorized run. The present `preflight(config, allocation)` interface
   does not receive the request, so it cannot perform request-scoped monetary
   admission today. The authoritative state must live outside the sandbox, use
   the chosen account/API billing arrangement without fallback, and reject
   unauthorized, replayed, expired or already-fenced admissions. Do not send
   credentials or a bearer authorization token through the request JSON
3. Resolve the existing protected-ingress mismatch: the adapter's execd upload is
   mode 0600 in a 0700 directory, while the worker requires root-owned protected
   input readable by UID 10001. Use the selected deployment's trusted ingress and
   verified ownership/mount controls; do not make the repository identity able to
   rewrite request, policy, supervisor or evidence files
4. Supply the existing immutable worker image/gateway configuration through the
   reviewed deployment bootstrap. Bind its local installation checks to the
   external allocation admission. Only then replace the native denial with checks
   backed by that concrete implementation; do not add a generic permission switch

Minimum inputs to implement that adapter are the selected deployment/runtime
identity and observation API, controller-managed protected storage/ingress route,
existing gateway's allocation identity/admission mechanism, and the specifically
authorized account/API monetary arrangement with its stop/reconciliation policy.
The repo currently supplies none of those deployment-specific facts.

### Exact integration test to run when those inputs exist

Use one disposable approved allocation and one tiny selected-evidence request,
then repeat for proposal, gate/future review and diagnosis. Keep the study runner
and publication disabled while verifying this transport:

- Deny absent/expired monetary admission before create; deny a wrong allocation,
  request digest, model or limits at the gateway without inference
- Verify immutable image/UID/control ownership and exact exported SHA; attempt
  direct-provider egress, credential access, altered input and tool use and require
  rejection under the actual runtime controls
- Send exactly one admitted request through the existing worker. Capture requested
  versus forwarded/observed settings, raw usage with unknowns preserved, actual
  gateway admission/charge-or-unknown evidence and all lifecycle receipts. Check
  source-scoped citations and reject malformed/wrong-stage/missing-target answers
- Cancel during preparation and during a request; exercise late create and worker
  exit with remaining descendants. Verify allocation fencing, remote request
  stop-or-unresolved monetary handling, frozen evidence collection and physical
  destruction using the external observer. Keep the lease when any receipt is
  uncertain; do not turn an SDK abort into remote-generation-stop evidence
- Check duplicate/replayed admissions cannot generate a second authorized call,
  and that no retry/account/API fallback is silently performed

A deployment test's authority comes from those live observations and approved
configuration, not from accepting the same authored fixtures described below.

## Offline verification

```sh
npm run typecheck
npm run build
node scripts/verify-matched-workspace.mjs
npx vitest run tests/matched-workspace.test.ts tests/opensandbox-workspace.test.ts \
  tests/matched-revision.sdk-native-diagnosis-worker.test.ts \
  tests/matched-revision.codex.test.ts tests/codex-workspace-runner.test.ts --maxWorkers=2
```

The compiled-import check covers four native stages, exact encoding and twelve
independent preflight denials with zero external execution invocations. Vitest
covers request/citation/cleanup validation, an authored mock outer lifecycle,
the existing real SDK with authored executable, and official-SDK-shaped mocked
OpenSandbox requests. These are local contract checks, **not live model or
runtime/deployment tests**. No study is adopted or unfrozen by passing them.
