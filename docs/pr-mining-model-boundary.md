# Bounded PR mining generation boundary

`src/adapters/pr-mining-model.ts` adds a reusable input builder, an injected
response boundary, and supervised workspace generation with immutable execution
provenance. The workspace path can accept a typed response from a trusted configured
runtime and persist a reviewable candidate; it no longer has a schema-only model
provenance blocker. **No live model or production isolation has been exercised.**
There is no default backend, credential lookup, login, deployment or CLI switch
that enables generation. It executes no detector and does not write database
records unless the caller explicitly saves the returned capability.

## What is usable now

- `buildPrMiningModelInput(input, { model, limits })` rederives a frozen mining
  request from its exact PR evidence, checking the request digest and every
  source/statement binding. Changing a binding and recomputing the digest does
  not bypass this check. It produces a deeply frozen, deterministic generation
  input with a strict object-root JSON output schema
- Only selected source sides and discussion records enter the prompt. UTF-8
  source bytes retain BOM and CRLF. Source cases stay `expected: "unknown"`
- `createPrMiningModelAdapter(config, transport).generate(input, signal)` accepts
  an explicitly authored test transport. This exercises bounded JSON parsing,
  structured output validation, evidence citation checks, and the existing
  `derivePrMiningCandidate` validator. The returned `candidateInput` can be passed
  explicitly to the existing `store.importPrMiningCandidate` method
- `buildPrMiningWorkspaceRequest(prepared, limits)` maps a full-repository context
  request to the existing workspace runner's public request type. It builds a
  request with the fixed `pr-mining-v1` output contract, not a successful execution
- `createPrMiningWorkspaceModelAdapter(config, runtime).generate(input, signal)`
  calls the existing lifecycle runner, accepts its typed mining envelope only
  after verified cleanup, and returns a non-serializable persistence capability
- `store.savePrMiningModelCandidate(outcome.persistence)` atomically stores the
  accepted rule and version-2 mining record. JSON imports remain supplied/fixture
  only and cannot authorize a claimed model execution

Example of the offline authored-test path:

```ts
import {
  createPrMiningModelAdapter,
  type PrMiningGenerationTransport,
} from './src/adapters/pr-mining-model.js';

// request and evidence are the exact stored mining request and PR package.
// authoredResponse is an explicitly supplied test JSON string, not model output.
const transport: PrMiningGenerationTransport = {
  kind: 'authored-test',
  id: 'deterministic-fixture',
  async generate(_input, _signal) { return authoredResponse; },
};
const adapter = createPrMiningModelAdapter({
  enabled: true,
  model: 'authored-test-no-model',
}, transport);
const outcome = await adapter.generate({
  request,
  evidence,
  candidateId: 'fixture-candidate',
  candidateCreatedAt: '2026-10-01T00:00:00Z',
  context: { kind: 'selected-evidence' },
});
if (outcome.execution === 'succeeded'
    && outcome.status === 'candidate_requires_review') {
  await store.importPrMiningCandidate(outcome.candidateInput);
}
```

All authored test results report `origin: "authored-test"` and
`modelExecution: "not_run"`. Candidates always have `source: "fixture"`, including
when the original request was supplied rather than synthetic. They retain the
common candidate contract's truthful `synthesis: "not_run"`. No fixture is
silently substituted when a transport is absent or unavailable.

## Output ownership and trust

The response schema has one required `result` object, with either:

- `status: "candidate"`, semantic fields, included/excluded path prefixes, zero
  or more bounded ast-grep detector drafts, rationale, and supplied evidence refs
- `status: "insufficient_evidence"`, reasoning, missing evidence, and zero or more
  supplied evidence refs

Model-writable structured fields do not include rule identity, repository
identity, provenance, expected labels, regression roles, verification, activation,
or certification. Unknown fields are rejected, not discarded. The system copies
rule ID/version/parent from the frozen request; reconstructs all exact source
provenance; pins repository scope to the selected sources; supplies the declared
candidate timestamp and runtime-derived author; and initializes regression roles
to an empty array. The common semantic rule schema and mining validator run after
this reconstruction. Detector drafts are never executed by this boundary.

Citations must be unique and selected for this input: `case:<case ID>` or
`statement:<content digest>`. The adapter outcome preserves these references and
a response digest. Workspace receipts retain the complete typed response and its
citations in the existing candidate payload, with no execution/citation tables.
The candidate-to-request link still binds the complete selected evidence package.

Prompts mark code, comments, PR opinions, repository instructions, and the authored
objective as untrusted data. This is an input contract, not a security sandbox or
a guarantee that a future model will resist every injection. A merge, approval,
or “fixed” comment supplies no human feedback or correctness label. Frozen
requests remain current-state observations with no historical review checkpoint.
A candidate mechanism and scope are unverified authored hypotheses.

## Full repository context

The default `context: { kind: "selected-evidence" }` explicitly says that only
selected changed sides are available and that no tools are available. It never
calls a captured change package a full repository.

A full-repository request must instead name an existing workspace identity and
its caller-declared repository identity:

```ts
context: {
  kind: 'full-repository',
  repository: request.request.sourceBindings[0].repository,
  checkout: 'before', // or 'after'
  workspace: { repoPath: '/trusted/repository-store', runId: 'mine', attemptId: 'one' },
}
```

The repository identity must equal the frozen snapshot identity. `before` derives
`expectedSha` from the snapshot's **merge base**; `after` derives it from the
snapshot's **head**. Neither uses the current base tip or a reported merge commit.
The context maps to `full-repo-shell-v1` and `all-local-refs-v1`, with explicit
`requires-workspace-runner` verification. The pure builder does not verify the
filesystem, Git history, remote origin, or repository identity. The workspace
runner and isolated backend must perform their existing checkout, lifecycle,
resource, and identity checks. Even a successful local checkout would not
independently authenticate the provider's historical claims.

The host repository path remains in the transport context rather than the model
prompt. `buildPrMiningWorkspaceRequest` enforces the runner's schema and serialized
request budget and prevents larger output/time limits than the mining boundary.
The optional fixed `outputContract: "pr-mining-v1"` selector is forwarded through
the runtime request. The immutable entrypoint selects `PrMiningModelResponseSchema`
from application code and emits `protocolVersion: 2` plus the same contract name,
value, session ID, usage and supervised-process receipt. It never accepts a
request-supplied schema. The legacy general workspace answer remains protocol
version 1 and cannot be mistaken for a mining response. See
[the workspace runner boundary](codex-workspace-runner.md).

## Bounds and outcomes

Defaults are 262,144 encoded input bytes, 131,072 response bytes, and 30 seconds.
Maximum configurable ceilings are 2,000,000 input bytes, 1,000,000 response bytes,
and 300 seconds. The input check includes the prompt, structured output schema,
context, and generation settings. Oversized input or output is rejected without
truncation. Semantic response text is bounded at 8,192 characters per field,
semantic lists and scope prefixes at 32, detectors at four, and citations at 160.
Existing PR evidence and mining limits also apply.

The injected transport is a trusted code dependency, not deserialized job input.
It must enforce byte limits before buffering and honor its abort signal; this
adapter's response-size check is an acceptance guard after receipt. The authored
test transport contract forbids models, SDK calls, networks and shells. It is not
a replacement for process/container supervision.

Outcomes distinguish:

- `not_run`: disabled, transport unavailable, caller already cancelled, or real
  raw model transport without trusted runtime authority
- `failed`: invalid input, transport exception/timeout/cancellation, or invalid
  output, always with no candidate
- `succeeded`: a validated response producing insufficient evidence or a
  review-required candidate. Authored transports/executors always report
  `modelExecution: "not_run"`; configured isolated-runtime completion can report
  `modelExecution: "completed"`

Timeout/cancellation requests transport abortion and reports
`requested-not-verified`; it does not claim that a process or container stopped.
The workspace adapter instead waits for the runner's stop/collect/destroy/lease
receipt, including after timeout/cancellation. Missing or failed cleanup withholds
candidate acceptance and returns `runtimeResult` with its recovery lease path.
Cancellation during cleanup also prevents candidate acceptance. Failed production
responses report model execution as unknown once a worker started unless a
matching typed envelope and successful bounded process completion were observed.

## Trusted workspace API and persistence

The runtime argument is a trusted application-code dependency with `id`, `backend`
and bounded workspace `limits`; it is not a deserialized job field. The adapter
constructs and calls `createCodexWorkspaceRunner(backend)` itself. There is no API
to submit arbitrary JSON and declare that a run happened:

```ts
import { createPrMiningWorkspaceModelAdapter } from './src/adapters/pr-mining-model.js';

// backend must already be independently provisioned/verified application code.
// This example does not configure a backend or grant execution authorization.
const adapter = createPrMiningWorkspaceModelAdapter({ enabled: true, model }, {
  id: 'operator-configured-runtime', backend, limits: workspaceLimits,
});
const outcome = await adapter.generate({ request, evidence, candidateId,
  candidateCreatedAt, context: { kind: 'full-repository', repository,
    checkout: 'before', workspace } }, signal);
if (outcome.execution === 'succeeded' && outcome.status === 'candidate_requires_review') {
  const saved = await store.savePrMiningModelCandidate(outcome.persistence);
}
```

The capability is minted only after completed execution, successful process
supervision, exact request binding and verified cleanup. It is held in a private
WeakMap and bound to a deeply frozen input; copying/serializing it, forging a
TypeScript brand, or calling the ordinary candidate import cannot recreate it.
Save before the issuing process exits. Repeating the save is idempotent, including
after a rolled-back write. Persisted records remain readable across process/DB
reopen without re-running a model. Cross-process capability transfer or resuming
an unpersisted generation after a crash is intentionally not implemented.

Version-2 candidate receipts retain:

- Mining-request, generation-input, exact UTF-8 prompt, typed-response,
  runner-request and normalized runtime-result digests
- Requested model configuration, operator-assigned logical runtime ID, worker
  session ID, runtime/fixture boundary, usage and bounded process evidence
- Full-repository context selection, workspace identity and both sets of limits
- Completion time, ordered lifecycle receipt, verified cleanup and collected
  artifact names/digests/byte lengths (not artifact bytes)
- The full strict response, preserving both candidate semantics and citations

`model` records the requested configuration, explicitly marked
`requested-configuration-not-provider-attested`; `runtimeId` names the trusted
application configuration, not independently authenticated remote hardware.
Prompt and workspace-request digests hash exact UTF-8 bytes. Generation, response
and normalized runtime-result digests use canonical JSON. The normalized result
includes the accepted envelope, lifecycle, cleanup and artifact descriptors;
it excludes transient lease paths and artifact byte buffers. All these bindings
are recomputed on store reads, together with the prompt reconstructed from pinned
evidence and the rule reconstructed from the typed response.

These are **trusted application execution receipts, not cryptographic attestation**
of provider identity, model quality, isolation or the truth of a source statement.
Trusted backend code and database integrity remain part of the trust boundary.
A malicious backend implementation or a fully compromised database is not made
trustworthy by a digest or an in-process capability.

Existing schema-version-1 supplied/fixture records are unchanged and keep
`synthesis: "not_run"`. A completed isolated execution uses `synthesis: "completed"`
and source `model` for a supplied request. Fixture requests remain source `fixture`
even if a real model is later used; the receipt separately states whether model
execution occurred. Authored runtimes always produce source `fixture`, synthesis
`not_run`, and modelExecution `not_run`, including when fed a supplied request.
Requests stay immutable/pending; source cases stay unknown; semantic validation,
regression execution, certification and activation remain untouched.

Version-2 payloads use the existing append-only candidate table and rule registry;
no migration or additional table is needed. Generated candidate/rule writes remain
atomic and use the same exact source validator and registry constraints. The
ordinary `mining supply` CLI cannot import generated records. Raw `kind: "model"`
string transports return `trusted_runtime_required`; the supervised workspace API
is the route for generation, rather than falsely treating a response string as
execution evidence.

## Remaining production requirements

Production still requires a provisioned isolated workspace backend, independently
verified lifecycle authority, immutable worker/control storage, resource/network
policy, and an authorized credential-isolated model gateway. Missing backend,
blocked image gateway, failed authority and unavailable authentication remain
blocked. No such infrastructure, live provider, authentication, deployment or
publication was performed for this change. The OpenSandbox adapter's existing
unverified production requirements are unchanged.

## Verification

`tests/pr-mining-model.test.ts` uses only deterministic authored transports. It
covers exact byte/binding reconstruction, selected-only context, injected comment
text, JSON schema shape, frozen inputs, explicit workspace mapping and bounds,
not-run gates, rejection of self-assigned provenance/labels, invalid citations,
malformed/oversized output, no-rule output, timeout/cancellation, and existing
PGlite request/candidate/review integration. `tests/pr-mining-workspace-model.test.ts`
adds a complete official-SDK/author-controlled executable → typed entrypoint →
workspace lifecycle → candidate → atomic save → DB reopen path, along with forged
capabilities, receipt/rule tampering, rollback/retry, no-rule responses, invalid
output, bounded supervision, cleanup failures and cancellation. Every executor is
explicitly authored and every saved runtime test candidate says no model ran.
The integration keeps source cases unknown and does not activate a rule.

```sh
npm run typecheck
npx vitest run tests/pr-mining-model.test.ts tests/pr-mining-workspace-model.test.ts tests/workspace-worker-entrypoint.test.ts --maxWorkers=2
```

Passing these checks establishes the offline boundary, not model quality or a
working production backend.
