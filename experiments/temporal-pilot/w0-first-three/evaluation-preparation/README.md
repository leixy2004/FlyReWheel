# W0 evaluation preparation and paper data audit

This is a retrospective preparation checkpoint, not preregistration or an effect
estimate. It links the original fixed three W0 PRs to their source snapshots, eight
source-side bindings, six complete context exports and actual behavior evidence.
Only PR 3031 has a paired executable tool check. Formal rule eligibility remains
unknown for all three. No real rule family, human label, developer feedback or model
run exists, so valid dataset/annotation/run objects are deliberately not fabricated.

The formal contracts remain `src/core/paired-evaluation.ts` and the existing feedback
schemas in `src/core/model.ts`/semantic review code. `schema-contracts.json` hashes
the existing dataset and annotation schemas. It is not an instantiated dataset.
The generator reuses package/frame validation, mining request derivation and exact
context bindings rather than introducing a second evaluation framework.

## Artifacts and audit boundaries

- provenance-ledger.json: per-PR identity, source/context linkage, command results,
  temporal observations, eligibility unknowns, feedback absence and split exclusions.
- heldout-selection.json: all 13 W1 metadata candidates for possible feedback
  development and all 19 W2 metadata candidates for possible holdout, with stable
  mergedAt/PR-number ordering. No source/discussion acquisition is authorized.
- blind-draft.schema.json: strict unassigned first-pass source draft envelope.
- PAPER-DATA-AUDIT.md: compact facts and limits for the independent paper worker.

Observed source acquisition times are in 2026. Merge dates define the 2024 window,
not a verified historical review checkpoint. Historical visibility and annotation
observation cutoffs remain unknown/null. Existing mining requests contain a current
untrusted pull statement; they are not claimed to be valid as-of experiment inputs.
All those statements are withheld from blind drafts.

W0 is development-only (the application's existing case split is training), excluded
from future holdout because assistants have already inspected sources and outcomes.
The first three chronologically merged W0 samples are not a random sample or a
representative census of the 38 W0 PRs. W1 is not holdout. Lineage, backports,
cherry-picks and content overlap across windows remain unaudited; distinct PRs, SHAs
or windows do not establish independence. No unknown case is silently dropped,
replaced, or converted into a negative. All effect metrics remain null/not-estimated.

## Local unassigned blind drafts

Three private drafts were generated outside the repository with random UUIDs, only
captured before-side file content, null rule/response/label and unassessed coverage.
No PR number, source commit ID, title, author, merge state, after-side/diff, discussion,
Ruff result or assistant interpretation is added to a packet. Source content is not
redacted or rewritten; public paths/comments/versions can still identify a project
or change. This does not guarantee identity blindness.

Private packets and facilitator identity/hash mapping occupy separate 0700 directories,
with 0600 files. Neither the packet bytes nor their IDs/mapping are published. Do not
share the parent directory. Even individual packets remain formally blocked: historical
visibility and a substantive rule rubric are not established, and no annotator is
assigned. Full repository context is retained for provenance but is not exposed to an
annotator by this stage. Authors/agents who saw outcome data cannot be treated as
blinded independent annotators.

After independent approval of historical visibility, rubric and source allowlists,
future assigned annotators must submit judgments before tool/model outputs are
revealed. Existing annotation labels/anchors and feedback contracts apply only once
real rule, author and evidence bindings exist. Empty/unassigned is not a negative
label, a synthetic human record, or a runtime feedback event. This stage writes no
application feedback/store state and shares no annotation task externally.

## Reproduce offline

Use new directories with existing parents. The script rejects private paths inside any existing Git worktree, including gitfiles
and symlinked parents, before creating outputs, and prevents output/private overlap.

```sh
prep_run=$(mktemp -d /tmp/flyrewheel-w0-evaluation.XXXXXX)
node --import tsx scripts/prepare-w0-evaluation-inputs.ts \
  --out "$prep_run/public-summary" --private-dir "$prep_run/private-drafts"
diff -u experiments/temporal-pilot/w0-first-three/evaluation-preparation/provenance-ledger.json \
  "$prep_run/public-summary/provenance-ledger.json"
npx vitest run tests/w0-evaluation-inputs.test.ts --maxWorkers=1
npx tsc --noEmit
```

Public JSON is deterministic; private UUIDs intentionally differ. Tests reject a
missing/duplicated Ruff side, altered commands or version results, incorrect context
tree/verification, non-null draft labels, added after data and private paths in Git.
This lane owns only the new generator/test and this evidence directory. It does not
edit paper files or existing initialization/preparation cleanup code; the main paper
worker can consume the data audit without overlapping edits.

## Separate PR #26 integration boundary check

An independent worker fetched PR #26 code from our GitHub into an isolated checkout
at `9b6789fcf746e25bd0bc98476ba75cb58975dd40`; this branch does not merge that code.
The issue #3 comment 5974728875 evaluation-inspect command succeeds on a real W0
export. The probe then inspects all six retained exports and recomputes identical
evaluation bindings. Ordinary `createPreparedWorkspaceResolver` rejects all six
evaluation export IDs with its explicit unsupported-evaluation guard. No binding
was stripped, no source was fetched, and no runtime/model was entered.

The existing evaluation-aware preparation is `prepareEvaluationWorkspace`. Worker
bootstrap can accept a trusted injected resolver returning `{workspace,evaluation}`,
and dispatcher validates exact export/repository/checkout. What is missing at this
PR #26 SHA is a concrete evaluation-aware registry resolver, not W0 source data.
The diagnostic uses a dummy job digest and tests only the early rejection guard;
it is not an end-to-end queued mining run or a positive authorization check.
`resolver26-check.json` gives commands, code paths and six bindings; the exact
executed probe is archived as text and the successful CLI result is retained.

## Blind packet safety follow-up

Schema parsing validates shape only; the actual write path now additionally calls
`validateBlindDraft`, which derives the complete expected before-source list from
the original SHA256-pinned package and compares every path/content, count and order.
After-source substitution, appended answers and duplicate sources are rejected.
Reference-answer, split, commit and tool-result fields are rejected by the strict
envelope. Source evidence is never rewritten using keyword filters.

A private destination inside a different Git checkout or linked worktree is also
rejected. Empty protected `.git` placeholders supplied by this cloud environment
are not repositories; a directory with HEAD or any gitfile/symlink is rejected.
This prevents accidental generation into existing Git working trees, not a malicious
owner later initializing a new repository or copying files elsewhere.

Blinding remains prospective and limited: public ledger source hashes can identify
packet content even without the facilitator mapping. Do not give prospective
annotators ledger/package access alongside packets. The concrete default in ANNOTATION-TEMPORAL-PROTOCOL.md is a current-capture
retrospective study, with historical replay treated as a separate evidence-gated
claim. A real substantive rubric, independent human resources and controlled access
are still absent; no person has been recruited or assigned.

The six immutable W0 exports and acquisition cache remain retained for the resolver
owner. The late-result correction at `6a1a8ac1d56f659f2e7d96b000739025f9755672` was
independently fetched and checked: 47 authored SDK-shaped tests in three files and
typecheck passed. `late-eof-independent-check.json` records the exact commands and
limits. This establishes regression-test behavior, not actual sandbox execution.
The earlier PR #26 rejection-guard audit remains a separate historical checkpoint.

## PR #28 real evaluation-aware resolver audit

Exact GitHub code `ba319f64eafc06b816975ee159c510a8404e0644` was reviewed in a
separate checkout. All six retained W0 exports were actually prepared and positively
resolved by `createPreparedEvaluationWorkspaceResolver` under explicit offline-study
purpose, preserving each entire binding. Wrong purpose, binding, job digest and
expected SHA were rejected. Seven authored resolver tests also passed, separately
from these six real-object probes.

Every new prepared worktree reached cleanupWorkspace closed-clean, then its own
derived repository was removed. Reinspection confirmed the original baseline
objects/refs/tree and binding unchanged; all six cache commits and exports remain
available. The main probe took 93.535 seconds and final checks 4.620 seconds; observed
derived-root apparent-byte peak was 20,968,134 bytes, not a hard quota or an inclusive
measurement of shared dependencies and authored-test temporaries.

Evidence is `evaluation-resolver28-independent-check.json`, with exact executed
probe/postcheck sources archived as text. Diagnostic job digests were authored for
this contract check: no persisted mining job, execution lease, dispatcher/runtime,
model, new upstream read or full-snapshot recapture was performed. Before/after
resolver acceptance alone must not be promoted to end-to-end mining compatibility.
Historical visibility and annotation release remain unproven/blocked.

## Proposed annotation and visibility protocol

ANNOTATION-TEMPORAL-PROTOCOL.md defines the target estimand, evidence cutoffs,
future-information exclusions, W2 frame census and denominators, two independent
human raters and adjudication, Unknown handling, agreement, contamination checks,
and actual pre-collection decisions/resources. It proposes current-capture defaults
rather than assuming historical review visibility. It is a retrospective proposal,
not preregistration, collection authorization or a completed human-label dataset.
Protocol critique by two native agents is recorded separately in
protocol-independent-critique.json; these reviews are not human annotations.

Protocol v0.2 adds staged expenditure gates: a 2.75-person-hour existing-W0
calibration proposal, then an 18-hour one-family W1 pilot only if feasibility is
established, and a 26-hour one-family W2 descriptive option if justified. The frame
and samples do not change. Confirmation requires uncertainty-based design rather
than arbitrary small N; 152 hours is only the eight-family initial-rating ceiling.
No phase has started and all costs are planning assumptions, not measured effort.
