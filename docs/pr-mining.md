# PR evidence → mining request → supplied semantic candidate

This local slice turns a stored GitHub PR evidence package into an immutable mining
request, exact unknown-label source cases, and a separately supplied semantic-v2
rule candidate. It is functional request/provenance plumbing, **not live rule
mining**. It never calls a model, infers a correctness label, executes target code,
posts a comment or activates a rule. Ambient model credentials/configuration do
not change this behavior.

## Run the complete synthetic example

```sh
mkdir -p .flyrewheel
npm run cli -- github-pr import --file examples/pr-mining-evidence.json --db .flyrewheel/mining-db
npm run cli -- mining request --file examples/pr-mining-request.json --db .flyrewheel/mining-db
npm run cli -- mining supply --file examples/pr-mining-candidate.json --db .flyrewheel/mining-db
npm run cli -- mining list --db .flyrewheel/mining-db
npm run cli -- mining candidates --db .flyrewheel/mining-db
```

These three input files are explicitly synthetic. Their fixed digests match each
other; modifying an input requires updating its downstream digest bindings. The
PR body even contains an adversarial instruction to report TP: it remains inert
untrusted text. Merged state, approval and “fixed” comments create no feedback,
labels or ground truth.

All commands also work after `npm run build` using `node dist/cli.js`. Every mining
command requires `--db` and accepts `--out <file>`. To inspect a single exact record:

```sh
npm run cli -- mining show --digest REQUEST_SHA256 --db .flyrewheel/mining-db
npm run cli -- mining candidate --digest CANDIDATE_SHA256 --db .flyrewheel/mining-db
npm run cli -- rules show --digest RULE_SHA256 --db .flyrewheel/mining-db
```

The candidate is an ordinary stored v2 rule and can immediately be selected by the
existing `reviews run --rule-digest … --snapshot-digest …` flow. No fixture verdict
is created by supplying it. A semantic-only candidate has explicit uncovered/
not-run semantic review targets, not evidence of safety. See [snapshot reviews](semantic-reviews.md).

## Freeze a request from existing evidence

1. Capture/import one PR through [the read-only provider](github-pr-evidence.md).
2. Prepare a request like [the example](../examples/pr-mining-request.json), with
   the exact evidence digest, selected source sides/paths, statement IDs, desired
   rule ID/version/parent, an authored objective, declared actor/source (`supplied`
   or `fixture`) and time.
3. Run `mining request`. The result exposes source case IDs, exact provenance tuples
   and statement content digests for a future author/adapter.

Only present, captured, regular UTF-8 sides can become source cases. Before binds
to the snapshot's **merge base**, after to its **head**; the current base tip or
reported merge commit is never substituted. Git blob ID, mode, byte length,
SHA-256 and case digest are frozen. Exact BOM/CRLF bytes remain in the existing
snapshot. Absent, excluded, missing or unsupported semantic-rule paths fail
closed. An empty current PR comparison cannot produce a mining request; this
feature does not reconstruct a historical checkpoint.

Statements select the entire PR metadata record (`kind: "pull"`) or an exact
`issue-comment`, `review` or `review-comment` ID. The request freezes each selected
record's content digest. Selecting a comment does not assert that its line/commit
context matches a selected source, that its opinion is true, or that it was
visible at a historical review time. Source and discussion claims retain the
provider package's trust limits.

Each selected side creates an existing `ProblemCase` with `split: "training"`,
`expected: "unknown"`, `provenance.kind: "imported"` and `reviewedBy: null`. Before
and after from the same PR share a deterministic lineage. Cases bind the evidence
digest and side/path, so reusing the evidence with another objective reuses the
same cases; changed evidence yields new case IDs. The store's existing lineage
and identical-source split protections still apply. Registered heldout/validation
source bytes cannot be relabelled as training by this path. These protections do
not establish historical independence or absence of temporal leakage.

## Supply a candidate

`mining supply` accepts a strict envelope with `id`, `requestDigest`, `source`
(`supplied` or `fixture`), and a full authored semantic-v2 `rule`. A fixture request
requires a fixture candidate. Supplied means caller-provided content; it does not
mean a model ran, a human verified the rule, or an identity was authenticated.

Validation requires:

- The exact requested rule ID, version and parent digest
- Every selected request case in `provenance.sourceCases`, with exact repository,
  full commit, path and source digest, and no additional sources
- Regression references, if any, drawn only from those selected source cases
- All existing rule schema, immutable version, lineage and case-store checks

Regression roles remain intended roles. Naming an unknown case `positive` or
`fixed` neither labels it nor runs it. Additional regression evidence should be
introduced through a separately authored later rule version and the existing
revision workflow, rather than silently expanding this frozen mining request.

The candidate record explicitly says `synthesis: "not_run"`,
`validation: "schema-and-exact-provenance-only"`, `semanticValidation: "not_run"`,
`regressionExecution: "not_run"`, `activation: "not_performed"` and
`certification: "none"`. Authored mechanisms, scope and detectors remain unverified.
The request stays immutable/pending; a candidate neither closes it nor reserves
or promotes a rule version. Multiple distinctly identified candidates may link to
one request, but the shared rule registry still rejects conflicting content for
one logical rule/version.

## Supervised generation API

The [workspace generation adapter](pr-mining-model-boundary.md) can now bind a
strict model response to completed runtime execution and verified cleanup, then
atomically save a version-2 candidate through an in-process capability. Its
receipts bind request/prompt/response, configured model/runtime and worker session.
They are application observations, not cryptographic attestation. The existing
CLI remains supplied/fixture-only; no live backend or authentication is enabled.
Authored executor tests retain fixture provenance and explicitly say no model ran.

## Persistence, limits and verification

The implementation reuses `qe_github_pr_evidence`, `qe_change_snapshots`,
`qe_problem_cases`, split/lineage records and `qe_rule_bundles`. Migration 007 adds
only immutable request records and candidate-to-request/rule links. There is no
second rule registry, model engine, queue or workflow state machine.

Request plus cases commit atomically; candidate plus rule commit atomically.
Conflicts roll back newly inserted records. Reads rederive selected source and
statement bindings from the pinned evidence, verify exact case payloads, and
check the candidate against the request and stored rule. These are integrity
checks, not independent authentication of Git history, execution or semantic truth.

Bounds: 32 source sides, 128 selected statements, 16,384 characters each for the
request objective and actor, and 2 MB compact mining input/request JSON. Candidate
authored fields retain their existing semantic-rule schema limits; the complete
candidate input envelope is also limited to 2 MB. Existing PR/snapshot limits
still apply. List commands return at most 100 records and fail rather than silently
truncate; optional `--evidence-digest` / `--request-digest` filters narrow them.

Tests cover adversarial source text, merge/approval non-labeling, exact side/commit/
byte provenance, empty/excluded sources, statement identity, strict schemas,
fixtures, missing/extra cases, holdout guards, rollback, concurrency, append-only
SQL, tampering with recomputed digests, disk reopen and separate-process CLI use.
See [verification](verification.md) for actual runs and real-evidence smoke limits.

Next capability: an explicitly enabled bounded mining adapter that consumes these
frozen inputs and emits a candidate through the same validator. Full repository
context, historical checkpoint reconstruction, live model quality, authenticated
human labels and production promotion remain separate work.

## Bounded repository discovery

[PR-history ingestion](github-pr-history.md) can discover and capture a small explicit repository/time-window selection, then link these same authored requests to exact per-PR captured evidence. It reuses the request and unknown-case derivation here; it does not automatically select sources, synthesize rules, label defects or start queue work.
