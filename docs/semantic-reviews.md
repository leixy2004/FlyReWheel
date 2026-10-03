# Local semantic snapshot reviews, feedback and revision requests

Selected unchanged contracts/tests now have a separate [repository-context
capture and typed-citation API](repository-context.md). The opt-in context-aware
contract accepts exact selected packages as supporting evidence. Merely capturing
a file does not fill a judgment's required-context gap; that judgment must cite it.

This is a bounded local application slice in the same FlyReWheel repository and
PostgreSQL/PGlite store. It applies one exact stored v2 rule to one exact stored
change snapshot, preserves structural occurrences and coverage, accepts explicit
offline semantic fixtures, records exact local feedback, and freezes a pending
revision request. The CLI remains offline. A separate [supervised workspace
review API](semantic-review-model-boundary.md) now connects typed runtime judgments
to the same store, while preserving exact evidence and context limits. Neither
path activates a rule or notifies a provider.

## One-command synthetic loop

```sh
npm run cli -- reviews demo --db .flyrewheel/review-db --out review-demo.json
# Or, after npm run build:
node dist/cli.js reviews demo --db .flyrewheel/review-db
```

The demo imports explicitly synthetic rule/source/snapshot records, runs real
native ast-grep, preserves two overlapping asset occurrences as **one finding**,
then applies an explicitly authored fixture judgment. It appends a fixture note
with `label: null` and creates a pending request for a future rule version.
The returned finding's human verdict remains **Unknown**. No simulated human
approval or TP ground truth is manufactured. The requested version is not created.
The synthetic commit declarations are not verified Git history.

Repeating the demo returns the same records. Reusing one of its fixed local IDs
for different content is an immutable conflict, not a reason to overwrite data.

## Review your stored inputs

First [import an exact v2 rule](semantic-rules.md) and
[capture/import a change snapshot](change-snapshots.md) into the **same database**.
Repository identities must match literally. Then:

```sh
npm run cli -- reviews run --rule-digest RULE_SHA256 \
  --snapshot-digest SNAPSHOT_SHA256 --db .flyrewheel/review-db --out review.json
npm run cli -- reviews show --id REVIEW_ID --db .flyrewheel/review-db
npm run cli -- reviews list --rule-digest RULE_SHA256 \
  --snapshot-digest SNAPSHOT_SHA256 --db .flyrewheel/review-db --limit 20
npm run cli -- reviews finding --id FINDING_ID --db .flyrewheel/review-db
```

All commands require persistent local storage and support `--out`. Review list
returns summaries ordered by immutable ID; `nextAfter` is an exclusive `--after`
cursor, not chronological ordering or a promise of another nonempty page. The
page limit is 1–100. A successful command is **not a clean-code verdict**.
Scanner errors or exhausted execution budgets persist their explicit coverage
and return exit 2; invalid inputs/identities fail with exit 1. Unsupported assets
and missing semantic judgments remain visible even when the command exits 0.
Output-file failure can occur after a database write; `show` recovers that record.

The run identity binds rule digest, snapshot digest, runtime/scanner contract,
fixture digest and attempt. Per-anchor reviews use `semantic-snapshot-review-v2`;
legacy reviews retain `semantic-snapshot-review-v1`. Selected-context reviews use
`semantic-snapshot-review-v3` and bind `repositoryContextDigests` plus immutable packages. The outer stored review still
has `schemaVersion: 1`; fixture schema versioning is separate.
`--attempt fresh-label` creates another immutable attempt. A retry may run deterministic scanners again; it cannot replace stored
results. Multiple rules are separate explicit runs, with no mutable “latest”
selection or automatic production catalog.

### Structural and semantic coverage are separate

- Only captured **after-side** files admitted by the rule's exact scope are review
  targets. Each changed entry has a coverage row, including deletions, exclusions,
  out-of-scope files and unsupported scope representations
- Native ast-grep scans the **whole captured file**, not just changed lines.
  A head finding may have already existed before the change. Every finding retains
  `introduction: "unverified"` and `notificationEligibility: "unverified"`
- Asset occurrences have snapshot-, side- and asset-bound IDs. Identical exact
  anchors for the same rule/run aggregate into one finding with all occurrence
  IDs. These occurrences are not independent bug discoveries or benefit counts
- No detector, zero hits, unsupported engines/languages, filename-language
  mismatches, parser errors and missing fixtures do not imply semantic safety
- JS/TS/TSX/JSX/Python ast-grep assets use a conservative filename-extension map.
  Unknown extensions are not guessed. Semgrep/OpenGrep assets remain explicit
  unsupported coverage in this runtime; their existing standalone import adapter
  is not silently invoked or treated as completed review
- Empty files remain file-level coverage units without a fabricated line-1 finding
- Snapshot filenames represent more literal characters than current v2 scope
  schemas. Such paths remain `unsupported_scope`, without normalization, omitted
  records or failure of unrelated files

## Explicit offline fixtures

The default run performs no semantic inference. An authored fixture packet can
be applied explicitly:

```sh
npm run cli -- reviews run --rule-digest RULE_SHA256 \
  --snapshot-digest SNAPSHOT_SHA256 --offline-fixtures fixtures.json \
  --db .flyrewheel/review-db
```

The strict contract is `ReviewFixtureSchema` in
[`src/core/semantic-review.ts`](../src/core/semantic-review.ts). A packet identifies
its exact rule and snapshot, provides anchored evidence, and declares one judgment
per selected target ID. Target IDs are available in ordinary review output. New
snapshot-only packets use `schemaVersion: 2`: every target has `decision`, `reasoning`,
`evidenceRefs`, `missingContext` and `anchorJudgments`; each anchor entry has its
own `anchor`, `decision`, `reasoning`, `evidenceRefs` and `missingContext`. Exact
after-side anchors can independently be safe, violation or unknown, including
mixed decisions in one file. Duplicate or conflicting entries for one anchor fail.

Target coverage is still explicit: an unknown target may retain known anchors; a
violation target requires a declared violation anchor; a safe target cannot declare
violation or unknown anchors. Local adjudications never promote an unknown target
to file-level safety. Unselected targets remain `not_run`, and selected anchors do
not adjudicate other structural hits. Anchored judgments can create findings
without detector hits. Schema-version-1 fixtures retain their original shared
decision and `findingAnchors` contract, payloads and identities. Legacy target-only
safe aggregation remains readable but cannot establish exact-anchor safety in
current revision comparisons.

Evidence references bind snapshot, **before/after side**, literal path, source
SHA-256 and a checked span. Positions are 1-based lines/columns and 0-based UTF-16
offsets, end-exclusive. Excerpts must exactly match captured bytes decoded as
strict UTF-8 with BOM and CRLF preserved. The helper functions
`makeSnapshotAnchor` and `makeReviewEvidence` in
[`src/adapters/semantic-review-fixture.ts`](../src/adapters/semantic-review-fixture.ts)
construct these records from stored snapshots. No source path is opened on disk.

Required-context kinds must appear among each target or anchor judgment's own
cited evidence. Missing required kinds or that judgment's declared `missingContext`
yield Unknown even if it claims violation/safe. Context is never pooled across
anchors or inherited from the target. A safe target becomes unknown if any selected
safe anchor is context-gated unknown; a violation target becomes unknown if all
its violation anchors are gated unknown. Known anchors can survive an unknown
target. A matching authored kind label is **not independently verified proof of
the semantic fact**. All fixture decisions remain visibly fixture-origin, not model
measurements or human
labels. Invalid bindings/excerpts fail before the missing-context gate, so a gate
cannot hide a forged fixture. Unchanged repository files and excluded bytes cannot
be invented as evidence. Selected unchanged sources are accepted only through
fixture schema 3 with the exact preselected repository-context package set;
findings remain changed after-side snapshot anchors. See the
[context-aware contract and limits](repository-context.md#opt-in-semantic-review-integration).

## Exact local feedback

Prepare a JSON object using the exact finding/review/rule IDs from the stored
finding. All fields below are required:

```json
{
  "id": "my-local-feedback-1",
  "findingId": "COPY_EXACT_FINDING_ID",
  "reviewId": "COPY_EXACT_REVIEW_ID",
  "ruleDigest": "COPY_EXACT_RULE_SHA256",
  "ruleVersion": "COPY_EXACT_RULE_VERSION",
  "source": "local-human-declared",
  "actor": "your-declared-local-identity",
  "kind": "note",
  "label": null,
  "reason": "The exact feedback you want to preserve.",
  "createdAt": "2026-10-01T00:00:00Z"
}
```

Use the actual authored event timestamp. Then:

```sh
npm run cli -- feedback add --file feedback.json --db .flyrewheel/review-db
npm run cli -- reviews finding --id FINDING_ID --db .flyrewheel/review-db
```

Source is either `fixture` or `local-human-declared`. The latter is an explicit
caller declaration, **not authenticated identity**. Feedback text, whitespace,
actor and timestamp are retained as supplied; no correctness label is inferred.
Only `kind: "label"` may carry TP, FP, Unknown or Disputed. Notes, merges and
resolves require a null label and do not approve findings. Fixture labels are
excluded from the human verdict, even fixture TP labels. No feedback means Unknown;
conflicting explicit local-human TP/FP labels mean Disputed. Nothing promotes or
activates a rule.

## Freeze a pending revision request

```json
{
  "id": "my-revision-request-1",
  "baseRuleDigest": "COPY_EXACT_RULE_SHA256",
  "requestedRuleVersion": "draft-2-requested",
  "feedbackIds": ["my-local-feedback-1"],
  "requestedChange": "The exact change you want a future author to consider.",
  "actor": "your-declared-local-identity",
  "source": "local-human-declared",
  "createdAt": "2026-10-01T00:00:00Z"
}
```

```sh
npm run cli -- revisions request --file request.json --db .flyrewheel/review-db
npm run cli -- revisions show --digest REQUEST_SHA256 --db .flyrewheel/review-db
npm run cli -- revisions list --base-rule-digest RULE_SHA256 --db .flyrewheel/review-db
```

A request freezes exact selected feedback IDs **and content digests** against one
base rule version. Later feedback does not expand that selection. The requested
rule-version label must differ from the base, but has no numeric/chronological
meaning. A request does not reserve that label, create a rule version or imply its
acceptance. It is an immutable `status: "pending"`, `synthesis: "not_run"` proposal.
Changed instructions need a new request ID; no generic request state machine is
introduced. Listing rejects more than 100 matching requests instead of truncating.

For the next local step, explicitly import a candidate or use the application
[feedback-driven generation API](rule-revision-generation.md), then use
[revision comparisons and declared decisions](local-revision-comparisons.md).
Comparison freezes same-snapshot base/candidate evidence without changing this
pending request or activating an accepted candidate. Generated proposals have a
separate immutable receipt; the request itself remains pending and unchanged.

## Persistence and trust limits

The complete review and its exact finding index commit in one transaction.
Review/finding/feedback/request rows are append-only. Reads verify parent rule and
snapshot identities, fixture digest, target coverage, side/path/source/span anchors,
asset occurrences, finding aggregation and indexed-member hashes. Feedback and
revision requests revalidate their exact parent bindings. Public review creation
accepts pinned inputs, not caller-forged result rows or identifiers. Legacy v1
replay/evaluation/promotion APIs retain their v1-only guards.

Builder and reader share deterministic engine/language/filename eligibility.
An unsupported asset cannot claim successful scanning, a runtime error or budget
exhaustion; an eligible asset cannot claim an unsupported/mismatched state. These
checks also reject contradictory coverage with an unchanged review ID and a
recomputed payload hash. Reads do not rerun scanners or authenticate execution:
eligible scans retain their recorded success/error/budget outcomes, and zero hits
still do not establish semantic safety or prove complete detection.

Stored snapshots are **package-integrity-only**. Neither this review nor its
fixtures authenticate Git ancestry, tree membership, inventory completeness,
repository ownership or the caller's identity. All coverage remains
`changed-entries-only` with incomplete repository context, even if every supplied
file has a fixture verdict. No precision/recall, introduction rate, newly discovered
bugs, notification readiness or production quality is inferred from this slice.

Bounds: at most 16 assets, 256 native scanner invocations, 8 MiB aggregate scanner
input, 100 candidates per scan, 1,000 stored asset occurrences, 2 MB fixture input
and 4 MB compact review JSON. Per-scan or aggregate failures stay explicit; no
successful coverage is produced from a truncated match list. An asset-count or
encoded-result violation rejects the whole run. These are bounded local-work
controls, not a security sandbox or wall-clock guarantee.

## Verification

Focused tests exercise detector-less/multiple assets, aggregation, exact Unicode
anchors, missing/forged evidence, before/after separation, full-file matching,
coverage gaps and limits. Real PGlite tests cover transactional rollback,
idempotency/concurrency, immutable SQL, exact feedback/request binding and tampered
reads. Separate-process source and compiled CLI checks exercise the complete loop.
See [the verification record](verification.md) for actual results. The separate
[mixed-anchor record](evidence/mixed-anchor-review-verification-2026-10-02.txt) and
[compiled mocked-SDK smoke](evidence/compiled-mixed-anchor-review-smoke-2026-10-02.json)
cover independent anchor judgments and their store/comparison boundary; their
authored outputs do not establish live model quality or empirical improvement.

The supervised full-repository review API is implemented; live Codex/OpenSandbox
execution, model synthesis, authenticated provider feedback, temporal
causality/heldout evaluation, notifications and production rule governance remain
unverified or separate pending capabilities. No model/authentication,
Windows, external upload or repository publication occurs here.
