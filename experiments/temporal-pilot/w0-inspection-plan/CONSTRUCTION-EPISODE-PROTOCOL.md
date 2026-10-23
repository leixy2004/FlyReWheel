# Deterministic construction and episode selection, v1

Prospective protocol supplement to the [frozen W0 roster](PROTOCOL.md), grounded
in base `e410339414f42292f14f938d877a58308e997c25`. This document proposes the
remaining procedural freeze; it does not claim external preregistration, completed
human judgments, unexposed collaborators, or authorization for models/acquisition.
The 50 REST attempts are exhausted. Existing three rejected development cases and
all later unassessed cases remain in the original 38-PR denominator.

## Claim and mandatory freeze

The primary contrast is **single-update constrained transfer H versus U**, with
the same supplied independent diagnosis, initial rule, representation, allowed
context, revision resources and gate. Only the revision constraint differs.
Evaluate the resulting state on independently predefined opportunities. This does
not test autonomous issue discovery, repeated learning, or unrestricted repository
review. H versus M is a secondary practical comparison owned by the main lane;
this supplement changes neither M nor its implementation. Gate failures retain
the original state under the shared frozen gate policy, rather than dropping runs.
All selected failures, abstentions and missing outputs stay in coverage accounting.
No numerical efficacy threshold, effect estimate or label is asserted here.

Before further remaining-W0 source or construction exposure, commit and verify
on the remote this procedure and the common constructor configuration below. The
three already inspected development cases and PR 3034 metadata-only identity checks
are disclosed exceptions, not blind construction attempts. Do not choose the
constructor or instructions after observing remaining-W0 yield.

After W0 completion and before any W1 content exposure, commit and verify on the remote: this procedure,
the complete W0 inspection/construction ledger, raw proposal files and their hashes,
accepted rule roster, semantic keys, source packets, exposure audit and operational
configuration. Configuration must name one constructor, versioned instructions,
serialization, parser, common context envelope and budget for the whole roster.
Model use, if ever separately authorized, additionally needs frozen model/version,
seed and decoding/resource settings. None is configured or run by this document.
Missing configuration or an incomplete exposure audit blocks the freeze, not an
invitation to choose settings after seeing yield. Prior three cases are development
exclusions with retained reasons, not fresh blind attempts. No claim of whole-team
non-exposure follows from a local declaration. Accidental W1 exposure pauses and
records a deviation; it cannot be repaired by silently restamping the freeze.

## W0 construction: one attempt, one retained candidate per PR

1. Follow all 38 PRs in frozen mergedAt/numeric-number order. Previously rejected
   three keep their decisions. Each remaining PR receives at most one constructor
   invocation using only its complete admitted W0 packet and the frozen common
   instructions. No cross-PR retrieval, outcome-based prompt changes, reruns,
   best-of sampling or manual repair. An inaccessible/incomplete packet produces
   `not_run` with missing evidence; an interrupted/invalid invocation is `failed`.
   Such rows consume their slot and are never replaced with later PRs.
2. The constructor is instructed to return zero or one candidate with exact source
   path, side, start/end span, scope/applicability, invariant, exception boundary,
   required context and evidence references. One candidate means one invariant and its applicability/
   exception contract; a bundle of independent rules hidden in one object is invalid,
   consumes the slot and cannot be manually split. A zero-candidate response is `no_rule`
   only when the inspection was completed. Freeze the unedited raw output before
   screening; preserve every unexpected extra candidate in the rejection ledger.
3. The hard cap is one retained candidate per invocation, not a guarantee about raw
   output length. If an output violates the requested format by returning multiple
   candidates, choose at most one deterministically
   from the raw list: sort by UTF-8 path bytes, side (`before` then `after`), numeric
   start/end line, then SHA256 of canonical candidate JSON. Canonicalization sorts
   object keys recursively, preserves array order and strings without trimming,
   and rejects duplicate keys, nonfinite numbers and ambiguous coordinates.
   Paths are repository-relative UTF-8 without Unicode normalization; reject invalid
   encodings or dot-segment aliases. Spans use 1-based inclusive whole-line numbers
   in the pinned file, splitting only on LF (CR remains source data); no byte-offset
   or column conversion. An absent side cannot carry a span.
   Malformed candidates receive explicit rejection reasons; if any cannot be
   ordered unambiguously, the whole invocation fails rather than selecting around
   them. Exact duplicates are retained as duplicate records with one representative.
   All nonselected candidates are `cap_excluded`, irrespective of perceived value.
4. Screen only the selected candidate against the existing substantive-source
   admission rubric, with two independently locked assessments and separate
   adjudication. No substitution from the extras if it fails. Keep rejected,
   unresolved, disputed and missing decisions; absent assessment is not a negative
   or Unknown judgment. Independent conflict resolution may decide eligibility
   but may not rewrite the rule. Typographical, scope, exception or evidence edits
   require a new development version outside this frozen cohort, never a retry.
   Source completion, if permitted by the inspection plan, precedes the one attempt;
   subsequent missing context blocks this version. The procedure bounds selection
   freedom; it does not make semantic construction or eligibility objective.
5. Candidate identity is `(PR number, raw-output digest, sorted candidate rank)`.
   Family key is SHA256 of canonical JSON containing repository, scope,
   applicability, invariant, exception boundary and required-context contract;
   source anchors, prose rationale and candidate IDs are not part of this key.
   Only byte-identical semantic keys merge, with the earliest frozen PR/candidate
   as representative and every member retained. Family order is representative PR
   inspection order, then semantic digest in ASCII ascending order. No human similarity merge/split or
   key rewriting. Near-duplicates stay separate and are flagged in a frozen lineage
   audit; unresolved lineage means no independence claim, not independent samples.
   All supported distinct families enter the roster; no yield quota or discretionary
   family selection. Record provisional/no-rule/failed/not-run dispositions using
   existing `constructionAttempt` and `screening` records plus a referenced ledger
   for raw extras, slot consumption, semantic-key inputs and rejection decisions.

## W1: select the index finding before learning correctness

Use the complete fixed 13-PR W1 metadata roster in mergedAt/numeric-number order,
then frozen family order. This is a future rule, not permission to inspect W1 now.
Freeze the source-only opportunity roster and common review configuration before
review outputs. A separately authorized common review uses the old rule, not H/U/M
revisions. Lock each full raw response, including no-finding, errors and missing
responses. Feedback collectors cannot edit or choose a more convenient finding.

For each family, the index is the first structurally valid finding in that order;
within a PR use the same path/side/span/digest ordering above. Any malformed,
unbound or unorderable finding invalidates the entire family×PR cell and blocks
index finalization rather than being skipped. With otherwise valid cells, exact duplicates
collapsed only for index choice. Structural validity means parsable, exact source
anchor and frozen-family binding, not correct diagnosis or useful feedback. Freeze
this choice **before** any correctness assessment is disclosed. Retain all other
findings and all no-finding/error/missing family×PR cells. Any earlier missing or
invalid response blocks index finalization for that family; it cannot be treated
as no finding and skipped. A completed no-finding response permits continuation.
Missing earlier source likewise blocks, without silently advancing to a later PR.

The chosen finding receives independent correctness assessment and diagnosis under
the common protocol. Supported TP, supported FP, Unknown, disputed or unassessed
all remain index records. Unknown/disputed/missing supervision blocks episode
admission; it does not allow replacement by the next usable finding. A supported
feedback record must also satisfy existing episode/source/lineage gates. At most
one admitted single-update episode per frozen family; no iterative updates or
search for the first favorable correction. TP/FP composition is reported. The
repeated-false-alarm endpoint may have no estimable denominator; do not switch to
FP-only sampling or reinterpret a TP as corrective evidence to avoid this result.
No finding in the complete roster means no episode, with all 13 cells retained.

Freeze the entire index/feedback/gate ledger before any W2 source/content exposure.
No gate tuning using W2 inputs or outcomes is permitted. Future opportunity
availability or expected H/U separation cannot decide whether to retain an index.
Missing W2 opportunity types leave endpoints unestimable, not permission to replace
the family/index. Independent lineage exclusions retain reasons and denominators.
Report all transitions: 38 W0 PRs → construction attempts → supported families →
W1 family×PR coverage → frozen indices → admitted/blocked episodes → fixed targets.
These are conditional development-cohort results, not population discovery yield.

## Neutral target packet contract using existing source annotation

Reuse `experiments/annotation/contracts.ts` Plan/Assignment/Submission/Adjudication
and the `target`/`observation` definitions in
`paper/experiment-protocol/record.schema.json`; do not add schema fields or repurpose
source-label submissions as output-support judgments. A referenced packet manifest
binds dataset, exact snapshots, capture/allowed-source times, neutral opportunity
IDs and spans, family/rubric digest, permitted contracts/context, and missingness.

Before common W1 review or W2 arm outputs, source-only enumerators lock the entire
opportunity list with two independent inventories, their union and explicit
adjudication of duplicates/out-of-scope entries. Enumerators receive no arm outputs,
expected labels, index correctness or method identities. Define one opportunity
as an operation issue at an exact source span; preserve multiple anchors as one
issue. Every inventory entry survives in the audit even when excluded. No number
of targets is selected for anticipated effect. This is a predefined opportunity
study: enumerator omissions remain a limitation, not an exhaustive-discovery claim.
The family applicability rubric necessarily informs enumeration; output-selected
spans and source packages derived from alerts are forbidden.

All arms receive byte-identical neutral source/context and opportunities. Do not
include expected label, violation/repair explanation, legal-neighbor subtype,
mechanism membership, adjudicator notes, PR narrative or method-specific hints.
Use neutral task language (assess the stated rule at this operation) and opaque
IDs. Source truth and subtype/membership judgments remain separate sealed records.
Passing packet hashes proves byte equality only; it cannot prove neutral content,
semantic support, historical visibility or rater independence. Current-capture is
primary; historical as-of requires additional visibility evidence.

## Independent output-support assessment contract

After source-reference labels and arm outputs are locked, retain and assess every predefined arm×repetition×opportunity output slot
(including missing/failed outputs and safe/not-applicable/unresolved claims), not
just alerts. Unexpected duplicate outputs remain in the audit; they invalidate
the slot rather than permit selecting the best response. Keep
source truth raters distinct from output-support assessors. Two independently
working assessors and a third adjudicator receive neutral source/rubric packets,
opaque randomized output IDs, exact output bytes and citations, without method
identity, paired alternative outputs, expected effectiveness or peer judgments.
Assignment/randomization and key are frozen and sealed before assessment; log
unblinding/reidentification because output prose may reveal a method. Missing
assessor work blocks a supported final decision; do not fabricate consensus.

A sidecar assessment record referenced by `assessmentRecordDigest` must retain
both original judgments, distinct declared identities, exact packet/output hashes,
submission/lock times, conflicts, independent reasons, evidence spans and final
adjudication. No real such records are produced here. Map final judgments to the
existing `evidenceSupport` values:

- `supported`: cited permitted bytes plus reasoning establish the claimed
  applicability, contract, value identity, control/data flow and conclusion for
  this exact opportunity; material premises are all resolved.
- `unsupported`: an identified contradiction, irrelevant citation or invalid
  inference defeats a material claim, with the counterevidence recorded.
- `unknown`: an assessment occurred but a material premise or disagreement remains
  unresolved. Neither rater uncertainty nor unresolved conflict becomes support.
- `not_assessable`: output absent/unparseable, required judgment missing or no
  assessable substantive claim. Retain the corresponding `resolutionReason`.

Valid citation IDs/spans and matching digests are necessary structural checks only.
Fixture citation validity never supplies semantic support. A correct source label
with a false rationale is not supported; a supported explanation of uncertainty is
not strict resolution. Score label correctness, semantic support and coverage
separately. Strict resolution requires the frozen correct disposition and supported
reasoning; abstention/no-alert alone cannot count. No automatic conversion from
source-positive to actual TP finding, or source-negative to FP feedback.

## Validation and present boundary

This is a prose contract, not a new schema, executable selector or completed study.
The existing schema permits the referenced ledgers; structural acceptance alone
cannot enforce this protocol. Before execution, the parent lane must bind the
operational configuration, candidate serializer/parser, neutral-packet audit and
support-assessment sidecars, then demonstrate fail-closed checks for cap violations,
rejected first candidates, incomplete earlier W1 cells and unresolved support.
Until then there is no execution-ready freeze. No model, source acquisition,
W1 exposure, human label or M implementation change occurred in preparing it.
