# Supervised semantic-v2 workspace review

The application can now run an exact stored semantic-v2 rule through the existing
full-repository Codex workspace runner, validate the typed judgments against exact
captured source bytes, and atomically persist the review and its finding index.
This is a reusable application API, not a live deployment or a model-quality claim.
The existing review CLI remains structural/offline-fixture only.

## Application integration

A trusted caller first loads the exact stored rule and snapshot, provisions an
existing managed workspace at the snapshot **head**, and supplies its separately
configured runtime dependency:

```ts
import { createSemanticReviewWorkspaceModelAdapter } from './src/adapters/semantic-review-model.js';

const rule = await store.getRuleVersion(ruleDigest);
const snapshot = await store.getChangeSnapshot(snapshotDigest);
// Prepare the managed workspace with baseSha: snapshot.snapshot.head.
// Passing mergeBase as baseSha and head as headSha does not check out head.
const adapter = createSemanticReviewWorkspaceModelAdapter({
  enabled: true,
  model: 'explicit-requested-model',
}, trustedRuntime); // { id, backend, limits }; trusted application code, never JSON
const outcome = await adapter.review({
  rule, snapshot,
  context: {
    kind: 'full-repository',
    repository: snapshot.snapshot.repository.id,
    checkout: 'after',
    workspace: { repoPath: '/trusted/repository-store', runId: 'review', attemptId: 'one' },
  },
  attempt: 'one',
}, signal);
if (outcome.execution === 'succeeded') {
  const review = await store.saveSemanticReviewModelResult(outcome.persistence);
}
```

No default backend, live authentication discovery, isolated-runtime fallback,
backend provisioning or model-enabling CLI flag is installed. An absent or disabled
runtime returns `not_run`. The runtime must satisfy the existing
[workspace lifecycle](codex-workspace-runner.md) and production prerequisites.
The shipped production worker remains blocked until those requirements are met.

## Exact inputs and accepted evidence

The pure `buildSemanticReviewModelInput` helper validates immutable rule/snapshot
identities, derives every changed-entry target and its exact rule scope, and freezes
a bounded prompt and schema. The model receives rule semantics, captured before/after
source, target identities and the expected head SHA. Source BOM, Unicode and CRLF
are preserved. Host workspace paths remain in execution context, outside the prompt.
Repository content, history, comments and rule prose are untrusted data.

Before runtime allocation, the adapter uses the existing bounded local Git capture
path to re-capture the entire supplied change inventory with identical base tip,
head, limits and metadata. Its digest must match the frozen snapshot exactly. This
checks captured bytes, ancestry, tree inventory and exclusions against local Git
objects instead of pairing an unrelated package with a valid workspace SHA.
It does not authenticate repository ownership, a PR's historical visibility, or
caller-supplied PR metadata. Local recapture has the existing separate 120-second
aggregate bound; cancellation is checked before it and again before allocation.
The runner then verifies the leased host checkout and runtime checkout at head.

New execution uses the fixed output contract `semantic-review-v2`. The immutable
entrypoint chooses its schema in application code and returns protocol version 2
with session, usage, process supervision and boundary fields. It cannot accept an
arbitrary output schema. The historical `semantic-review-v1` contract, generic
protocol-v1 answer and `pr-mining-v1` contract remain distinct.

A response contains exact `ruleDigest`, `snapshotDigest`, anchored `evidence`, and
one judgment for every captured in-scope after-side target. The new judgment shape
is `{ targetId, decision, reasoning, evidenceRefs, missingContext, anchorJudgments }`.
Each `anchorJudgments` entry carries its own `{ anchor, decision, reasoning,
evidenceRefs, missingContext }`. It replaces the shared-decision `findingAnchors`
list for new responses; offline packets use the same shape with `schemaVersion: 2`.
Duplicate, omitted, unavailable or out-of-scope targets, duplicate/conflicting
anchors and invented citations fail the complete response. Each selected anchor
must bind the exact snapshot, after side, path, source digest and span. A decisive
target or anchor judgment requires its own cited evidence.

Target coverage and individual anchors are separate. A target declared `unknown`
may contain independently known safe and violation anchors and is never promoted
to known from those local claims. A target declared `violation` requires a violation
anchor and may also contain safe or unknown anchors. A target declared `safe` cannot
contain declared violation or unknown anchors; an empty list is a target-only claim.
Thus one file can retain an explicitly violating site alongside an explicitly safe
exception without declaring the whole file safe. Evidence citations alone do not adjudicate
anchors, and selected anchors do not adjudicate other structural hits. Detectorless
anchor findings are supported without inventing detector occurrences. Current
revision comparisons require explicit exact-anchor claims for selected feedback.

Evidence IDs bind canonical content, kind and snapshot anchor. Every excerpt is
rechecked against captured UTF-8 bytes, including exact side, path, source digest,
UTF-16 offsets and line/column positions. Captured before-side evidence is allowed
as context, never as an after-side finding or proof that a violation is introduced.

Full-repository inspection does **not** expand accepted evidence to unchanged or
uncaptured files. The model must report needed uncaptured facts in `missingContext`.
For each target and each anchor independently, required context is checked only
against that judgment's own `evidenceRefs`. Unmet kinds are unioned with its own
`missingContext`; any gap forces that judgment to Unknown even if it proposes
safe/violation. Anchors
never inherit a target's state, citations or gaps, so one unsupported anchor cannot
borrow evidence from another. If a declared safe target has a context-gated unknown
anchor, its coverage becomes unknown; a declared violation target also becomes
unknown if none of its violation anchors survives the gate. Target-level missing
context can leave coverage unknown while a separately supported anchor stays known.
Context kind labels remain declarations rather than independently proven semantic
facts. Unknown is preserved; no structural hit, zero hits, an empty file, or
successful worker exit implies safety.

## Receipts, authority and persistence

Only completed runner execution, a matching typed worker boundary, successful
bounded process supervision, the exact completed lifecycle, and independently
verified stop/collection/destruction/lease release permit acceptance. Cancellation,
including during cleanup, withholds the review capability. Failed cleanup retains
the runtime result and recovery information rather than claiming acceptance.

The receipt records exact rule/snapshot/head, workspace context, local recapture
check, requested model/runtime, generation/prompt/response/request/result digests,
limits, session and usage, process evidence, artifact hashes/sizes, lifecycle and
cleanup. The model identity is requested configuration, not provider attestation.
Artifact contents are not archived by this API; their bounded manifests are retained.
These are trusted-application observations, not cryptographic backend attestation,
model-quality certification, authenticated feedback, or evidence of semantic truth.

The adapter returns a deeply frozen review and an opaque process-local WeakMap
capability. `saveSemanticReviewModelResult` rejects JSON, copied capabilities,
claimed model receipts, result rows and type casts. The existing `runSemanticReview`
input remains strict and cannot import execution claims. No public mint/import API
can promote serialized provenance into runtime authority.

The existing append-only review/finding tables store both parent and exact index
in one transaction. Saves of the same capability are idempotent; a failed index
write rolls back everything and the same capability can be retried. Reads rederive
generation/prompt/response/request/result bindings, scope, judgments, context gates,
occurrences, findings and index integrity without rerunning Git, scanners or models.
New receipts include `judgmentContract: "per-anchor-v3"`, binding the new prompt,
schema and `semantic-review-v2` worker contract. Derived reviews use
`config.runtime: "semantic-snapshot-review-v2"`; legacy reviews retain their
original runtime and identity. Receipts marked
`target-and-anchors-v2` rederive their original explicit-safe-anchor prompt/schema;
receipts without a marker rederive their original no-safe-anchors contract. Adding,
removing or changing a marker without matching bindings fails. Schema-version-1
fixtures, historical review payloads and identities remain immutable and readable,
including duplicate required-context declarations and legacy target-only safe
aggregation. They are not rewritten into independent anchor judgments. Existing
feedback/revision comparison flows retain workspace receipt provenance as `includes-workspace-execution-receipts` rather
than relabeling it as offline fixture evidence; certification stays `none`.

An authored executor always reports `origin: authored-test` and
`modelExecution: not_run`; accepted findings remain fixture-origin. Its successful
supervised process is not a live model run, isolation verification or human label.
A genuinely configured isolated runtime can produce model-origin judgments, still
with a human verdict of Unknown until separate explicit feedback exists.

All coverage remains changed-entries-only with incomplete repository context.
Stored snapshot provenance remains package-integrity-only; the separate receipt
records the local Git check. Every finding retains `introduction: unverified` and
`notificationEligibility: unverified`; notification is `not_performed`. No rule is
activated, revision synthesized, source case labelled or external comment sent.

## Verification and remaining work

Defaults: 262,144 encoded generation-input bytes, 131,072 output bytes and 30 seconds
for prepare/execute. Configured ceilings are 2,000,000 input bytes, 1,000,000 output
bytes and 300 seconds; workspace output/time limits cannot exceed adapter limits.
Input includes prompt, output schema and context. Worker raw-byte supervision and
cleanup limits apply separately. Existing snapshot/scanner/evidence/review bounds
also apply; no partial truncated response is accepted.

Authored tests exercise actual Git snapshots, exact-head workspaces, the pinned
official SDK using an authored executable, strict worker output, context gates,
source/anchor binding, immutable save/reopen, rollback/retry, tampered receipts,
forged authority, cancellation and cleanup recovery. They make no model call.
The compiled API/SDK/store smoke is reproducible without credentials:

```sh
npm run build
node scripts/smoke-semantic-workspace.mjs
```

It creates and removes an authored temporary Git repository and local database,
then prints a bounded result with explicit fixture/not-run/Unknown labels.
See [verification](verification.md) for recorded checks. The new
[mixed-anchor verification record](evidence/mixed-anchor-review-verification-2026-10-02.txt)
and [compiled mocked SDK → worker → store → comparison smoke](evidence/compiled-mixed-anchor-review-smoke-2026-10-02.json)
cover mixed-site decisions, independently gated context, exact-anchor comparison
and immutable compatibility. Authored outputs test this contract, not a live
model/backend or improved semantic accuracy.

Live backend/gateway authorization, actual model behavior, production isolation,
resource/network enforcement, durable artifact storage, unchanged-file evidence
capture, introduction analysis, authenticated feedback, notifications and rule
governance remain separate unfinished work. No live authentication, model/backend
call, deployment, upload, repository publication, dependency install or commit is
part of this increment.

## Selected unchanged supporting evidence

An optional nonempty `repositoryContexts` package selection chooses
`per-anchor-context-v4` / `semantic-review-v3` without altering any earlier
prompt or output contract. Every package must match the exact snapshot repository
and head and pass bounded local Git recapture before runtime allocation. The
frozen package set and citations are bound through the prompt, execution receipt,
stored review and reference job. Decisive declarations cite their own changed
after-side target; context anchors are supporting evidence only. Read rederivation
uses immutable captured bytes and preserves package-integrity-only coverage.

See [selected context integration](repository-context.md#opt-in-semantic-review-integration)
for package/count limits, fixture/runtime versions, downstream comparison,
known-holdout rejection and the explicit context-aware revision-generation block.
