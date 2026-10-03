# Local rule revision comparisons and decisions

This bounded local workflow extends [semantic snapshot reviews and revision
requests](semantic-reviews.md). It compares an explicitly imported v2 candidate
with its exact base rule using stored reviews of the **same frozen snapshots**,
then records an explicit local accept, reject or defer decision. It neither
authors a candidate nor runs a model, activates a rule, publishes a result, or
changes the existing v1 evaluation/promotion path. An accepted decision can be
cited by a separate, explicit [local governance command](semantic-rule-governance.md)
for experimental review eligibility; recording it alone never selects a rule.

## One-command fixture demonstration

```sh
npm run cli -- revisions demo --db .flyrewheel/revision-db --out revision-demo.json
# Or, after npm run build:
node dist/cli.js revisions demo --db .flyrewheel/revision-db
```

The demo uses real native ast-grep against two explicitly synthetic TypeScript
files. Both contain a detector hit: an unguarded positive and an explicitly
guarded safe negative. Authored base fixtures declare a violation in both files.
Two separate requests and manually authored candidate versions share that base:

- The guard-aware candidate preserves the positive and explicitly judges the
  negative safe. Its comparison is `compatible`, with a **fixture** `accept`
- The lost-positive candidate explicitly judges both files safe. Its comparison
  is `regressed`, with a **fixture** `reject`

Selected fixture TP/FP labels bind exact base finding anchors. They are examples
of comparison expectations, not human ground truth; the returned human finding
verdicts remain `Unknown`. Fixture judgments and decisions are never model
measurements, authenticated approvals or production certification. Synthetic
commit declarations are not verified Git history. Repeating the demo reuses the
same immutable identities and produces identical output within the same fixture
contract version. Conflicting content under one of its IDs is rejected.

Changes to fixture contracts and the current scorer change review/comparison
identities. For a demo database created before these updates, keep the old records
for inspection and run the current demo in a fresh database, for example
`.flyrewheel/revision-per-anchor-v3-db`. Reusing an old demo database can raise
`IMMUTABLE_CONFLICT`; old records are never silently replaced. Likewise use a fresh
output/database for the [closed-loop demo](local-closed-loop.md) when upgrading.

## Prepare exact inputs

Use one local database for the base rule, revision request, candidate, regression
cases, snapshots and reviews. First [import the v2 rules](semantic-rules.md) and
[run the reviews](semantic-reviews.md). The candidate must:

- Have the base rule's exact logical `ruleId`
- Set `provenance.parentDigest` to the request's exact `baseRuleDigest`
- Use the request's exact `requestedRuleVersion`, distinct from the base version

Importing a candidate is a separate action. The pending request does not reserve
a version, synthesize rule content or authorize a decision.

Prepare a comparison input JSON object:

```json
{
  "id": "my-local-comparison-1",
  "requestDigest": "COPY_EXACT_REQUEST_SHA256",
  "candidateRuleDigest": "COPY_EXACT_CANDIDATE_RULE_SHA256",
  "reviewPairs": [
    {
      "baseReviewId": "COPY_EXACT_BASE_REVIEW_ID",
      "candidateReviewId": "COPY_EXACT_CANDIDATE_REVIEW_ID"
    }
  ],
  "caseBindings": [
    {
      "caseId": "my-existing-regression-case",
      "baseReviewId": "COPY_EXACT_BASE_REVIEW_ID"
    }
  ]
}
```

```sh
npm run cli -- revisions compare --file comparison.json \
  --db .flyrewheel/revision-db --out comparison-result.json
npm run cli -- revisions comparison --digest COMPARISON_SHA256 \
  --db .flyrewheel/revision-db
npm run cli -- revisions comparisons --request-digest REQUEST_SHA256 \
  --db .flyrewheel/revision-db
```

Each pair must contain the exact base-rule and candidate-rule reviews of one
identical snapshot. No review ID may appear in two pairs. A case binding selects
a base review from those pairs; the stored case must match that snapshot's
repository, head commit, literal after-side path and source digest. A wrong or
stale binding is rejected rather than silently rebound to another file.

The comparison freezes the complete union of both rules' declared regression
cases, their roles, source identities and content digests, plus the request's
exact selected feedback and review content digests. A case present only in one
rule stays in the comparison. Source-only case digests are also frozen for
integrity, without creating additional scored regression rows. Omitting a case
binding leaves that case visibly inconclusive. A known case expectation must
agree with its role: `positive`
means `violation`, while `negative` and `fixed` mean `safe`. Conflicting
positive/safe roles or known expectations are rejected; an `unknown` expected
label remains unscored.
Held-out cases cannot be used as candidate-authoring sources or local regression
cases in this workflow. Comparison also refuses any known captured or excluded
before/after snapshot source SHA-256 registered as holdout in the local split
registry, including evidence used only through feedback. This is a conservative
local leakage guard, not authenticated provenance: an unknown or unregistered
source split is not evidence of safe dataset separation.

Inputs select stored evidence and may explicitly provide the bounded applicability declarations described below. The CLI rejects unknown fields, including
caller-supplied outcomes, summaries or trust claims. Derived results cannot be
imported as if they had been computed locally.

## Conservative outcomes

Snapshot-only reports without the opt-in applicability policy record `scorer: "per-anchor-semantic-v3"`. An observation is known
only from an explicit, validated semantic judgment at its own scope, with its own
required context present: target judgment for a file case, exact anchor judgment
for selected feedback. Detection assets are optional: no assets or zero hits can
accompany such a judgment, but never produce safety themselves. Every declared
asset must still have successful scan coverage before either scope can score;
unsupported assets, scan errors and exhausted scan budgets remain inconclusive.

A regression `ProblemCase` declares a **file-level** expectation, bound to exact
repository, head, after path and source digest. Its target-level judgment can score
that file case, including for detectorless rules. The full union of base/candidate
regressions is retained, so removing a detector or dropping a positive case cannot
hide lost positive coverage. Missing semantic execution, missing context, unknown
judgments, missing pairs/bindings, exclusions and out-of-scope targets cannot
demonstrate a fix.

For a known expected label and known observations on **both** sides:

| Base meets expectation | Candidate meets expectation | Outcome |
|---|---|---|
| Yes | Yes | `preserved` |
| No | Yes | `corrected` |
| Yes | No | `regressed` |
| No | No | `still_failing` |

Anything not sufficiently scored is `inconclusive`. `compatible` requires every
case and selected feedback item to be preserved or corrected. Any `regressed` or
`still_failing` entry makes the summary `regressed`; otherwise any inconclusive
entry makes it `inconclusive`. Counts describe selected comparison entries,
**not independent bug counts**: a regression case and feedback anchor can refer
to the same example.

Selected feedback is compared at its exact snapshot/side/path/source/span anchor
across rules. Only an explicit selected TP label expects a violation, and only an
explicit selected FP label expects safety. Notes, resolves, merges, Unknown and
Disputed labels have no correctness expectation and remain inconclusive. Later
feedback does not replace or enlarge the request's frozen selection. An FP
label concerns that exact finding anchor; it never declares an entire file safe.
Both violation and safety observations require an explicit claim at the same exact
snapshot/side/path/source/span and a corresponding validated known finding. New
`anchorJudgments` provide an independent decision, reasoning, evidence references
and context gaps per anchor. Historical explicit `findingAnchors` remain supported
under their original shared target decision; their name also covers explicit safe
anchors. Neither form requires detector occurrences to create a semantic finding.

An unrelated adjudication elsewhere in the file does not adjudicate the selected
anchor. Target-only safety with an empty anchor list cannot score an FP, even if
evidence cites that span or legacy aggregation marks a structural finding safe.
Evidence citations establish context, not the scope of a safety claim. A known
anchor can score even when target coverage remains unknown; target state does not
override the independently gated anchor. Conversely, a missing or unknown anchor
stays inconclusive regardless of a known target or another supported anchor.

A single file can now preserve one explicitly violating site while treating another
as a safe exception. Required-context and missing-context gates apply separately
to each judgment; one site cannot borrow another's evidence. File-level regression
cases still use the explicit target judgment, so an unknown target remains
inconclusive for those cases even when selected anchors are known.

## Record an explicit decision

Prepare an input using an actual authored timestamp and a source appropriate to
the declaration:

```json
{
  "id": "my-local-decision-1",
  "comparisonDigest": "COPY_EXACT_COMPARISON_SHA256",
  "choice": "defer",
  "actor": "your-declared-local-identity",
  "source": "local-human-declared",
  "reason": "The exact decision and reasoning you want to preserve.",
  "createdAt": "2026-10-01T00:00:00Z"
}
```

```sh
npm run cli -- revisions decide --file decision.json --db .flyrewheel/revision-db
npm run cli -- revisions decision --digest DECISION_SHA256 --db .flyrewheel/revision-db
npm run cli -- revisions decisions --comparison-digest COMPARISON_SHA256 \
  --db .flyrewheel/revision-db
```

`accept` is allowed only for a `compatible` current-scorer comparison. `reject` and `defer` are
allowed for any valid comparison. No choice is inferred from a comparison,
request, feedback label, actor name, timestamp or CLI success. `source` is always
explicit: `fixture` or `local-human-declared`. The latter is a caller declaration,
not authenticated identity. Text and timestamps are retained exactly.

Every decision is a separate append-only record. Repeating identical content is
idempotent; changing an existing decision ID fails. Later decisions with new IDs
do not mutate earlier ones or create an authoritative mutable "latest" state.
Even an accepted local decision has `activation: "not_performed"` and
`certification: "none"`. The original request remains immutable `pending` with
`synthesis: "not_run"`; no rule, active catalog or v1 promotion record changes.
The separate `local-semantic-review` registry requires an explicit CAS command,
exact rule/scope bindings and nonempty scored current-comparison evidence to
select a revised `local-shadow` version. Even then, production activation and
certification remain absent.

## Immutable scorer compatibility

Reports without a `scorer` marker rederive with the original detector-gated
algorithm, including its historical whole-target safety behavior. Reports marked
`explicit-semantic-v2` rederive with that version's target-gated explicit-anchor
algorithm. Neither is retroactively treated as `per-anchor-semantic-v3`. Existing
report IDs and recorded decisions remain readable and idempotent. New comparisons
always use the current scorer; to re-evaluate an old selection, use a new comparison
ID. New `accept` decisions against either older scorer are blocked. Previously
recorded accepts remain historical declarations; reject/defer remain available.
No stored report or decision is rewritten, and caller input cannot select a scorer
or supply a result.

See the [methods review](../paper/method-draft.md), the historical
[detectorless verification](evidence/detectorless-comparison-verification-2026-10-02.txt),
and the new [mixed-anchor verification](evidence/mixed-anchor-review-verification-2026-10-02.txt)
with its [compiled SDK/worker/store/comparison smoke](evidence/compiled-mixed-anchor-review-smoke-2026-10-02.json).
Authored fixture and mocked-SDK checks validate application behavior, not live
model/backend operation, semantic ground truth, empirical improvement or complete
repository coverage.

## Persistence, bounds and trust

All commands require `--db` and support `--out`. Inspect/list commands return
stored records; optional list filters are exact digests. A successful compare can
return `regressed` or `inconclusive`: exit 0 means the operation completed, not
that a candidate passed. Invalid inputs, conflicts and disallowed acceptance
fail with exit 1. If writing an output file fails after a database write, retrieve
the saved record with the corresponding inspection command.

Strict CLI JSON input is capped at 2 MB and decoded as valid UTF-8. A comparison
allows at most 16 review pairs, 200 unique source/regression cases, 100 selected feedback
records, 16 MB of loaded comparison inputs and 2 MB of derived result JSON.
Listings refuse more than 100 matching records instead of truncating; narrow by
request or comparison digest where possible. Comparison lists additionally
refuse results exceeding 16 MB; retrieve an exact comparison in that case. No
partial comparison is stored to fit a bound.

Stored comparisons and decisions are immutable and content-addressed. Reads
revalidate pinned rule/request/review/case/feedback identities and recompute the
derived comparison from those exact records. This checks stored package
integrity and semantic binding; it does not rerun the scanner, authenticate
execution, establish Git ancestry, verify repository ownership or prove full
repository context. Semantic evidence remains
`offline-fixture-declarations` for legacy fixture/structural inputs, or
`includes-workspace-execution-receipts` when any selected review or feedback review
carries a supervised execution receipt. The latter preserves both authored/model
receipt provenance without granting correctness or human certification. Identity
remains `caller-declared-unverified`, and scope
`declared-cases-and-selected-feedback-only`.

This slice makes no claim about held-out generalization, precision/recall,
production readiness, provider notifications, causality or model quality.
The supervised workspace review API is available separately; live model execution
and production rule governance remain unverified or separate work. The opt-in
[local governance registry](semantic-rule-governance.md) adds experimental
eligibility and history only; it does not close those production trust gaps.

## Generated candidate inputs

[Feedback-driven revision generation](rule-revision-generation.md) now supplies an exact requested-version candidate through an application API. Use its saved rule digest with the same comparison and local-decision APIs documented above. Generation preserves all base regression cases and source provenance; comparison remains a separate step. Its execution receipt does not establish correctness or permit activation.

### Selected repository-context comparisons

When selected reviews use context-aware evidence, comparison chooses
`per-anchor-context-v4`. Base and candidate must have identical canonical context
digest sets, recorded in pair bindings alongside exact review digests. Legacy
scorers reject context-enabled reviews; old report rederivation is unchanged.
Registered holdout SHA-256s in any selected captured/binary context entry block
comparison, even if uncited. Current local acceptance/governance preserves v4
identity without promoting fixture feedback to human ground truth. Unsupported
snapshot-only model revision generation fails explicitly before consuming these
reviews. Full limits and evidence boundaries: [repository context](repository-context.md).

## Explicit applicability for literal path revisions

A comparison can explicitly opt into `scope-applicability-v5` by adding
`applicability: { policyVersion: "selected-finding-applicability-v1", adjudications: [] }`.
An empty list enables coverage reporting but supplies no semantic correction.
The old v1–v4 scorers, stored hashes and `out_of_scope` interpretation remain
unchanged. New fields are emitted only for the opt-in v5 contract.

The dedicated [comparison applicability channel](../src/comparison-applicability.ts)
may assess a selected base feedback finding whose after-side bytes are captured
but whose candidate review target is `out_of_scope` because literal paths changed.
Repository scope must remain identical. This is **not** permission for ordinary
semantic review to bypass its rule scope. Normal candidate review retains its
out-of-scope target, no finding, no scan and `not_run` semantic state.

Each adjudication binds the exact request, base/candidate rule digests and version
labels, base/candidate review IDs and content digests, snapshot, repository, full
head, feedback ID/content digest, base finding ID/content digest, after-side anchor
and canonical selected context digest set. Both reviews must select the same
context packages. Every citation, including unused evidence, is checked against
captured bytes. A decisive claim must cite after-side target evidence spanning
its selected finding and independently satisfy the union of base and candidate
required-context kinds. An explicit context gap or missing cited context makes
that claim unknown; another judgment cannot supply context implicitly.

The response vocabulary is `NOT_APPLICABLE`, `APPLICABLE`, or `UNKNOWN`.
Only an explicit, context-complete `NOT_APPLICABLE` response becomes a distinct
`not_applicable` candidate observation and can correct a selected FP. It is not
stored as `safe`. Scope exclusion, missing claims, no model execution, failed
execution, silence, target disappearance and a prior FP label do not establish
non-applicability. `APPLICABLE` leaves an excluded target unscored; it does not
claim the underlying code is safe or violating.

Two existing-style input paths are supported:

- Offline fixtures use `kind: "comparison-applicability-offline-fixture"`, a
  `binding` from `buildComparisonApplicabilityInput(...)`, and an explicitly
  authored `response`. The existing `revisions compare --file` CLI accepts these
  declarations, never caller-supplied derived outcomes or runtime authority
- The application-only `createComparisonApplicabilityWorkspaceModelAdapter`
  exposes `adjudicate({ comparison, context })`. It uses the fixed
  `comparison-applicability-v1` typed worker and `selected-evidence-no-tools-v1`
  policy, exact local Git snapshot/context recapture, verified cleanup and a
  bounded receipt. Persist its returned adjudication through
  `createRevisionComparison(input, [outcome.persistence])`. Imported receipt JSON
  cannot mint the required process-local capability. Stored reads rederive the
  exact prompt, response, request and runtime-result bindings

V5 reports base and candidate target-disposition counts separately. If a
previously established positive regression or selected TP loses coverage because
of candidate path exclusion, that obligation is `regressed` and blocks acceptance,
including when a NOT_APPLICABLE declaration contradicts it. The full union of
regression declarations is retained. Missing positive case bindings or feedback
pairs remain inconclusive, also blocking acceptance. Coverage-loss counts describe
comparison obligations, not independent bugs; a case and TP can overlap.

This bounded policy assesses **selected finding anchors only**. It cannot turn
one finding's non-applicability into a whole-file negative/fixed regression pass.
If the excluded file is itself a declared negative/fixed regression, that file
row remains inconclusive and acceptance remains blocked. Whole-file scope
adjudication and detector-language applicability need separate contracts.

All applicability decisions remain unverified fixture/model claims. Exact bytes,
context-kind declarations and immutable receipts establish identity and execution
provenance, not semantic truth, logical narrowing, human ground truth or correct
contract routing. The literal scope operator is not a logical proof. No production
backend/model run, activation, publication or independent accuracy measurement is
implied by the offline checks.
