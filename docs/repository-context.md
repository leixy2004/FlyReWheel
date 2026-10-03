# Selected repository context at an exact review head

`contexts` captures explicit Git paths that may be unchanged by a review. It
provides immutable source packages and typed citations for contracts, callers,
and tests. The opt-in context-aware semantic-review contract accepts these as
supporting evidence from a frozen exact-head selection. Legacy review contracts
remain snapshot-only. Seeing an unchanged file in the full workspace is not enough
to make it accepted evidence: its package must be selected before execution.

This is a bounded evidence-capture slice. It does not execute target code, run
models/tests, discover dependencies, infer labels, or establish full context.

## CLI

Use Linux, the installed Git client, and a trusted local repository whose complete
history/objects are already available. Supply the exact full lowercase 40-character
SHA-1 **review head**, never the currently checked-out branch name.

```sh
npm run build
node dist/cli.js contexts capture \
  --repo /absolute/path/to/repo --repository-id example/project \
  --head FULL_40_CHARACTER_REVIEW_HEAD_SHA \
  --path src/contracts.ts tests/contracts.test.ts \
  --snapshot-digest OPTIONAL_EXISTING_SNAPSHOT_DIGEST \
  --db .flyrewheel/context-db --out context.json
node dist/cli.js contexts show --digest CONTEXT_DIGEST \
  --db .flyrewheel/context-db --out context-from-store.json
node dist/cli.js contexts import --file context.json \
  --db .flyrewheel/another-context-db
node dist/cli.js contexts verify --digest CONTEXT_DIGEST \
  --repo /absolute/path/to/repo --db .flyrewheel/context-db
node dist/cli.js contexts cite --digest CONTEXT_DIGEST \
  --path src/contracts.ts --kind callee-contract --start 0 --end 20 \
  --snapshot-digest OPTIONAL_EXISTING_SNAPSHOT_DIGEST \
  --db .flyrewheel/context-db --out citation.json
node dist/cli.js contexts list --repository-id example/project \
  --head FULL_40_CHARACTER_REVIEW_HEAD_SHA --limit 20 \
  --db .flyrewheel/context-db
```

Omit the whole `--snapshot-digest` option when no snapshot binding is requested.
For a review, supplying it checks repository/head before capture and checks all
selected overlapping entries afterward. `cite` can repeat that binding check.
A capture/cite binding check is preflight, not a semantic decision or execution.

The capture CLI accepts repeated `--path` options or multiple values after one
`--path`. Paths are literal Git-tree paths; quote shell metacharacters. Directories
are recorded as excluded, never recursively selected. Wildcards and pathspec-like
strings do not expand. Selecting an absent or old renamed path records `missing`;
it never follows a rename or substitutes a path from another commit. Paths starting
with `--` can be supplied using the option's `--path=...` form.

All commands require local PGlite storage and support `--out`. Failures exit 1.
`list` emits bounded summaries without source bytes, ordered by digest, not time;
use `nextAfter` as `--after`. Default page size is 20, maximum 100. A last-page cursor
can yield an empty next page. `show` and `cite` work after the source repository is
removed. `verify` needs the exact original Git objects locally available again.
Output-file failure can follow a successful immutable database insert; `show` or
an idempotent retry recovers it, without overwriting the stored record.

## Immutable package and typed citations

`schemaVersion: 1`, `kind: git-repository-context` includes:

- Caller-supplied repository ID, explicitly unauthenticated, plus Git object format
- Exact `head` commit and `selection: explicit-paths-at-head`
- Strict byte/path limits and a canonical UTF-8-byte-ordered entry per selected path
- Captured regular-file mode, Git blob ID, byte length, SHA-256, and canonical base64
- Explicit missing/excluded entries and independently rederived coverage counters
- `scope: selected-paths-only` and `historicalAvailability: unproven`

The digest covers the complete canonical package content, including head,
repository declaration, selection policy and exclusions. Selection order does not
change it; duplicate paths are rejected, not silently deduplicated. Source bytes
preserve BOM, CRLF, Unicode, valid U+FFFD and empty files. Invalid UTF-8 or NUL bytes
are explicitly excluded. A future commit with identical selected file bytes still
has a different context identity and cannot bind to an earlier review head.

`RepositoryContextAnchor` carries `kind: repository-context`, context digest,
repository ID, exact head, path, Git object ID, file mode, source SHA-256 and exact
span. Like snapshot anchors, spans use zero-based UTF-16 offsets, one-based
line/column coordinates and an exclusive end; they must be nonempty and match
recomputed positions. `RepositoryContextEvidence` adds an ID over role/anchor/excerpt
and retains the exact excerpt. Context roles such as `callee-contract` or `test`
are caller declarations, not independently verified semantic facts. Empty,
missing, excluded and unselected sources cannot supply a nonempty citation.

Public API in `src/repository-context.ts`:

- `captureRepositoryContext({ repositoryPath, repositoryId, head, paths, limits? })`
- `validateRepositoryContext(context)` and `RepositoryContextPackageSchema`
- `readRepositoryContextPackage(file)` with a hard bounded read
- `verifyRepositoryContext(storedContext, repositoryPath)` for fresh local checks
- `repositoryContextSource(storedContext, path)` from captured bytes only
- `makeRepositoryContextAnchor`, `validateRepositoryContextAnchor`
- `makeRepositoryContextEvidence`, `validateRepositoryContextEvidence`
- `validateRepositoryContextForSnapshot(storedContext, storedSnapshot)` for exact
  repository/head and overlapping head-entry consistency; renamed/deleted paths
  are checked against the snapshot's final head paths

`QualEvoStore.importRepositoryContext`, `getRepositoryContext` and
`listRepositoryContexts` use the existing PostgreSQL/PGlite persistence layer.
Migration 013 creates append-only `qe_repository_contexts`; no new dependency,
artifact backend, credentials, queue or service is introduced. Reads revalidate
content, digest and repository/head index bindings; duplicate imports are
idempotent. UPDATE/DELETE use the existing immutable-evidence trigger. Only local
PGlite operation is verified by this slice, not external PostgreSQL durability.

## Local checks versus imported integrity

Capture returns a separate `local-git-check` receipt. `verify` actually repeats
exact-path capture at the declared head under the same limits and compares the
whole digest before issuing a fresh receipt. These are local observations,
not authenticated attestations of repository ownership or a provider PR.

Receipts are excluded from the content digest and never saved as authority.
`import`, `show`, `cite` and `list` return `package-integrity-only`, even if an input
package includes a copied or fabricated local-check receipt. Import recomputes
captured-byte hashes, Git blob IDs, encoding, canonical digest and cross-field
consistency. It cannot prove tree membership, excluded bytes, true absence of a
missing path, completeness beyond the selected paths, or ownership. An internally
consistent fabricated head/path declaration can pass import but fail fresh local
verification. Changing only the claimed repository ID cannot be authenticated by
Git content either; it remains explicitly caller supplied.

Exact commit/tree membership also does not prove when that commit, repository,
contract or test was publicly available. Historical availability remains unproven;
this slice does not establish a review-time checkpoint or historical evaluation.

## Bounds and Git safety

Hard ceilings/defaults: 128 explicit paths, 256 KiB per blob and 2 MiB retained
text bytes. Smaller limits are available through the API or `--max-paths`,
`--max-blob-bytes`, `--max-total-bytes`. The retained-byte budget is applied in
canonical path order, counts repeated content at each path, and can record
`total-byte-limit` exclusions. Binary bytes do not consume retained-text budget;
budget-excluded blobs are not read to determine whether they are binary.

A separate 8 MiB bound counts all returned blob bodies, including repeated/binary
reads. Compact context JSON is capped at 4 MB, import/export packages at 5 MB.
Each Git subprocess has at most 30 seconds and 1.5 MB combined output; an aggregate
120-second Git-work deadline caps capture. Exceeding count/read/time/encoded-size
bounds fails the whole operation, never returns a silently truncated package.
These are application/output limits, not limits on Git's internal object
traversal/decompression, physical disk I/O or stalled-host filesystem latency.

Shared snapshot plumbing disables ambient credentials/config, hooks, fsmonitor,
object replacements, external Git transports and lazy fetch. Capture rejects
shallow/partial/promisor repositories, nonempty ancestry grafts, missing required
blobs, non-SHA-1 repositories and unresolved/non-commit IDs. Source content comes
only from installed Git `ls-tree` and `cat-file` using a full commit then validated
blob IDs. There are no worktree source reads, checkout, recursive repository crawl,
LFS downloads, textconv, filters, hooks, submodule traversal, or target-code
execution. An LFS pointer is only its committed UTF-8 pointer text.

Exclusions retain coverage explicitly:

- `binary`: object/mode/size/computed SHA-256; no retained bytes
- `oversize`, `total-byte-limit`: object/mode/known size; SHA-256 null
- `symlink`: link blob identity/size; no target traversal or link bytes
- `submodule`: gitlink ID/mode; size/SHA-256 null, linked commit need not exist
- `directory`: tree ID/mode; size/SHA-256 null, no descendants selected
- `unsupported-mode`: available identity/mode/size; no retained bytes

Paths must be normalized, relative, strict UTF-8, at most 4096 bytes, without empty
components, `.`/`..`, NUL or backslashes. Spaces, colons, tabs, newlines, Unicode and
literal metacharacters are preserved. Unselected invalid-UTF-8 filenames do not
force traversal or normalization. This assumes a trusted, exclusively accessed
local Git store; it is not protection against a concurrently malicious owner
replacing Git metadata/configuration or objects.

## Opt-in semantic-review integration

Register the context packages in the same store as the rule and snapshot. Select
one or more exact digests before review; the set is canonical, unique and frozen:

```sh
node dist/cli.js reviews run --rule-digest RULE_DIGEST \
  --snapshot-digest SNAPSHOT_DIGEST \
  --repository-context-digest CONTEXT_DIGEST \
  --offline-fixtures context-fixtures.json --db .flyrewheel/context-db
```

The application API is `runSemanticReview({ ruleDigest, snapshotDigest,
repositoryContextDigests, fixtures? })`. The pure builder and workspace adapter
accept `repositoryContexts: StoredRepositoryContext[]`; optional capture receipts
are discarded. Persisting a result requires every package to be registered under
its exact digest in the same store, including selected but uncited packages.
The reference-only `semantic-review` application job accepts the optional canonical
`repositoryContextDigests` set and checks the persisted outcome against it.

Version boundaries are explicit:

- Fixture `schemaVersion: 3`: required `repositoryContextDigests`, existing independent
  target/anchor judgments, and a union of snapshot or repository-context evidence
- Review runtime `semantic-snapshot-review-v3`: frozen digest set in config and
  embedded immutable `{digest, context}` packages in `repositoryContexts`
- Workspace judgment contract `per-anchor-context-v4`, worker output
  `semantic-review-v3`: the response must repeat exactly the frozen digest set;
  execution receipts bind that set, generation/prompt/request/output hashes and
  `repositoryContextCheck: exact-local-git-recapture-matched`
- Comparison scorer `per-anchor-context-v4`: exact base/candidate context sets are
  equal and explicit in report bindings. Context-aware paired evaluation also
  binds context sets and marks unlike evidence selections incomparable

Legacy fixtures 1/2, snapshot anchors/evidence, review identities, worker outputs
v1/v2, prompts and old report rederivation retain their original contracts and
bytes. Context evidence is rejected under those historical schemas. Omission of
contexts keeps the old behavior; explicitly empty selections are rejected.

### Evidence and coverage rules

All selected packages must match the snapshot's literal repository ID and exact
head, including matching overlapping head entries. Future commits with identical
source bytes do not qualify. Selection is bounded to 8 packages, 128 aggregate
selected entries, 1 MiB aggregate captured bytes and 2 MB package JSON; repeated
entries count toward limits. Conflicting overlapping entries, impossible parent/child paths and contradictory
Git object declarations across packages or the snapshot head fail closed. Existing
2 MB generation/fixture ceilings and 4 MB review-result ceiling still apply, and
configured model input limits may be smaller. No successful result is truncated.

A context citation must identify a selected captured entry and exactly match its
package/head/repository/path/object/mode/source hash, excerpt and UTF-16 span.
Missing, excluded, unselected, substituted or tampered citations fail before
adjudication. A model cannot expand the context set through its response.

Context remains supporting evidence. Every finding and anchor judgment stays on
an exact in-scope captured changed after-side `SnapshotAnchor`. A decisive target
or anchor declaration also cites after-side snapshot evidence from its own target.
Unchanged files cannot become findings through this contract. Each judgment must
supply its own cited required-context kinds; another anchor's citations do not
fill its gap. Missing required/reported context yields Unknown. Valid support can
allow an authored/model declaration to survive that gate, but matching kind labels,
unrelated excerpts, or tests merely being present do not establish semantic truth.

### Local execution versus offline integrity

Before allocating a runtime, the workspace adapter recaptures the snapshot and
**every selected context package**, including uncited packages, from local Git at
the exact snapshot head. Importing an internally consistent fabricated package
cannot bypass this check or borrow another package's verification. Git still does
not authenticate caller-supplied repository ownership. The runtime receipt records
application provenance, not a cryptographic attestation.

Pure/offline fixture validation and database reopens use embedded captured bytes
and package integrity only. They neither read source paths nor re-run Git, scanners
or models. Reviews survive source-repository removal; store reads revalidate the
registered packages and exact review/fixture/receipt bindings. The independent
coverage fields still say changed-entries-only, incomplete repository context,
unverified introduction/notification eligibility and unproven historical
availability. A successful declaration never creates a human label.

### Downstream limits

Context-aware comparison carries exact review and context identities, preserves
independent same-anchor scoring, and retains fixture labels as unverified. Known
holdout source hashes in selected captured/binary context entries block revision
comparison even if the entry was never cited. This is a known-source contamination
check, not proof of historical isolation or absence of unknown holdouts.

Feedback-driven revision generation now uses explicit `rule-revision-v3` /
`selected-context-evidence-v1` for context-enabled source reviews. It carries the
exact frozen review/package identities and only each selected finding's cited
excerpts into a no-tools prompt, receipt, and candidate/no-mutation record. It
reserves only consumed context source hashes; uncited package bytes are not exposed
to generation. Comparison retains its broader selected-package holdout gate above.
Historical revision v1/v2 contracts reject context rather than silently remove it;
old records remain readable under their original schemas/prompts. Missing context
and model diagnoses do not establish labels or authorize activation. See
[revision generation](rule-revision-generation.md) for the versioned contract and
`node scripts/smoke-revision-generation.mjs --context` for the offline compiled
SDK generation → comparison → source-gone reopen exercise. Context-aware paired
reports preserve the existing truth and certification limits.

See [semantic reviews](semantic-reviews.md), [workspace execution](semantic-review-model-boundary.md),
[verification](verification.md), and the
[compiled authored SDK/store/comparison smoke](../scripts/smoke-context-semantic-review.mjs).
