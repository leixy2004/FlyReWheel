# Semantic rule versions: local import and inspection

`schemaVersion: 2` stores a semantic rule without requiring a static detector.
The import commands are a persistence slice: they do not execute a review or
activate a rule. The opt-in [local governance registry](semantic-rule-governance.md)
separately records experimental review eligibility; importing alone does not
register or select a version. The separate [local snapshot-review flow](semantic-reviews.md)
uses these exact stored versions for native structural scanning, explicit offline
fixtures, local feedback and pending revision requests. A [local PR mining-request and supplied-candidate path](pr-mining.md) now binds
captured source bytes to these versions. Supervised review and revision-generation
APIs are documented separately; live model quality and production execution remain
unverified.

## Run the synthetic example

```bash
npm run cli -- rules import \
  --rule examples/semantic-rule-v2.json \
  --cases examples/semantic-rule-cases.json \
  --db .flyrewheel/semantic-db
npm run cli -- rules list \
  --rule-id effective-wait-deadline-semantic --db .flyrewheel/semantic-db
npm run cli -- rules show --digest SHA256_FROM_IMPORT --db .flyrewheel/semantic-db
```

All three commands require a persistent local PGlite directory and support
`--out <file>`. Import and show return `{ "digest": "…", "rule": { … } }`;
list returns an array of those records, ordered lexically by rule ID and version.
Version labels have no implicit numeric or chronological ordering. There is no
mutable “latest” or “active” flag in these immutable version records. Local
governance state is derived separately from explicit events, not written into the
version payload. `rules list` optionally filters by one exact `--rule-id`; it does not execute scope selection or detectors. Listing
is currently unpaginated and intended for a small local collection, not a
production-scale rule catalog.

The example is explicitly synthetic and has `expected: "unknown"` and
`reviewedBy: null`. It makes no claim of a verified human label, model result, or
bug discovery. Its declared source digest is the SHA-256 of these UTF-8 bytes,
including the final newline:

```typescript
async function waitForWorker() { await waitUntilReady(); }
```

The importer validates references against stored case records; it does **not**
fetch Git objects or verify source bytes. Those checks belong in a future evidence
ingestion path. It also does not establish repository availability or whether a
case's stated problem is true. Repository identities, authors, and case references are supplied
by the caller; they are not provider-verified identities.

## Contract

See the complete [example](../examples/semantic-rule-v2.json) and
[Zod schema](../src/core/semantic-rule.ts). Every object is strict: unsupported
fields or schema versions are rejected rather than discarded or guessed.

- `semantics`: title, failure mechanism, invariant, applicability, exceptions,
  required context, and a testable expected behavior
- `scope.repositories`: one or more exact, case-sensitive repository identity
  strings. A repository URL, local identifier, and fork name are not aliases
- `scope.paths.include` / `exclude`: literal POSIX repository-relative paths or
  subtrees. `src` includes `src` and its descendants, not `src-other`; `.` means
  the whole repository. Exclusions take precedence. No glob or host filesystem
  interpretation occurs. Empty scope, duplicate entries, exclusions covering all
  includes, traversal, absolute paths, backslashes, trailing slashes, and wildcard
  syntax are rejected
- `detectionAssets`: optional list of uniquely named embedded projections using
  existing ast-grep, Semgrep, or OpenGrep detector shapes. Omit it or supply `[]`
  for a semantic-only rule. Multiple assets are retained without selecting one or
  claiming executable coverage. Omission and an explicit empty array are distinct
  authored payloads and therefore have distinct digests
- `provenance.sourceCases`: at least one immutable case ID plus exact repository,
  lowercase 40-character Git SHA-1, path, and SHA-256 source digest. Every tuple
  must match an existing or atomically supplied `ProblemCase`
- `regressionCases`: explicitly named cases and intended roles; may be empty.
  Merely naming a case does not run or pass a regression
- `provenance.parentDigest`: null only for the first stored version of a logical
  rule; later versions must reference an existing parent of the same rule
- `author`, `createdAt`, and `rationale`: retained as authored provenance, not
  evidence of authenticated identity or time-isolated learning

`matchesRuleScope(scope, repository, path)` implements the literal scope contract.
A match only admits a candidate; semantic applicability and correctness still
require review. A historical source case need not belong to the target scope: a
rule may explicitly apply a lesson from one repository to another.

## Persistence and compatibility

The store reuses the existing `qe_rule_bundles` table, immutable SQL trigger, and
unique `(rule_id, version)` namespace. This remains the only immutable
rule-version catalog. The separate `local-semantic-review` governance event stream
adds local eligibility without duplicating version payloads, changing their
digests or writing to the legacy v1 active registry. `ruleVersionDigest` hashes
canonical JSON for the full validated authored record, including scope, assets and provenance. Object key order is irrelevant;
array order and all field values remain part of identity. Same logical version,
different content or schema is rejected. Reads verify the stored digest and
logical identity before returning the record.

`QualEvoStore.importRuleVersion(rule, cases?)` imports supplied cases and the rule
in **one database transaction**. Any conflict, invalid lineage, heldout reference,
or source mismatch rolls back all new cases, split/lineage entries and the rule.
Case files must be JSON arrays, with parents before derived cases, up to 1,000
records; both JSON input files are limited to 2 MB by the CLI. Previously imported
cases can be reused by omitting `--cases`. Repeating the same import is idempotent.

`getRuleVersion(digest)` and `listRuleVersions(ruleId?)` read v1 and v2 explicitly.
RuleBundle v1 payloads, required single detector, and `bundleDigest` remain
unchanged. To create a v2 descendant of v1, author a complete v2 record with a new
version label and the v1 digest as parent. No scope, source SHA, semantic mechanism,
or optional asset is invented by an automatic conversion. A v1 child cannot name
a v2 parent.

Legacy `importBundle` / `getBundle`, replay, scan, queue, execution records,
evaluation and promotion remain v1-only. They reject v2 instead of choosing its
first detector or treating a missing detector as no findings. Stored v2 rules are
not production-active. The separate local v2 review runtime has its own explicit
contract and evidence records; it does not weaken these legacy guards or fabricate
a mandatory detector. Its digest-pinned APIs continue to support explicit historical
and research replay regardless of opt-in local selection. See
[local semantic reviews](semantic-reviews.md) and
[local governance and exact-scope selection](semantic-rule-governance.md).

Existing case-store holdout protections remain in force for both schemas. The
inherited v1 case store also prohibits identical full-file source digests across
dataset splits. This is a conservative existing restriction, **not** a claim that
identical file bytes in independent temporal PRs inherently establish leakage.
Temporal/problem-lineage-aware assessment is still a separate missing capability.

## Verification boundaries

Tests cover semantic-only and multiple assets, scope boundaries, strict schemas,
digest sensitivity, immutable writes, parent lineage, exact source binding,
atomic rollback, heldout rejection, v1 compatibility, guarded legacy consumers,
concurrent conflicts, disk reopen, and separate CLI processes. The same store
implementation supports PostgreSQL and PGlite; this slice is tested with real
embedded PGlite, not a remote PostgreSQL server.

The canonical `npm test` command limits file workers to two for the local Git and
PGlite integration tests. Test timeouts and assertions are unchanged. See the
[verification record](verification.md) for the initial unrestricted-parallel
timeouts and the subsequent full-suite results.

No model calls, authentication changes, sandbox execution, k3s deployment, remote
uploads or repository publication are part of this slice.
