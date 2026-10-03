# Frozen local Git changes

This slice freezes bounded evidence for later PR-history mining. It does not
ingest a provider, discover bugs, assign labels, run a model, execute repository
code, or perform review/feedback evolution. No snapshot constitutes a clean review.
The separate [local v2 review flow](semantic-reviews.md) can consume an exact stored
snapshot while retaining all of these coverage and provenance limits.

Unchanged contracts/tests can be frozen separately using [selected repository
context](repository-context.md), pinned to the exact review head. That package is
not yet accepted by the semantic-review evidence contract.

## CLI

Use a trusted local repository with complete commit history already available:

```sh
npm run cli -- snapshots capture \
  --repo /absolute/path/to/repository --repository-id example/project \
  --base-tip FULL_40_CHARACTER_BASE_TIP_SHA --head FULL_40_CHARACTER_HEAD_SHA \
  --db .flyrewheel/snapshot-db --out snapshot.json
npm run cli -- snapshots show --digest DIGEST_FROM_CAPTURE \
  --db .flyrewheel/snapshot-db --out frozen-input.json
npm run cli -- snapshots list --repository-id example/project \
  --db .flyrewheel/snapshot-db --limit 20
npm run cli -- snapshots import --file snapshot.json \
  --db .flyrewheel/another-snapshot-db
```

The production build exposes the same commands through `node dist/cli.js`.
Every command requires persistent local PGlite storage and supports `--out`.
Successful commands emit JSON; failures exit 1. List returns summaries, ordered
by digest, with `nextAfter` usable as `--after`. It is not chronological. A cursor
on the last page may yield an empty next page; the cursor is not a promise that
more records exist. Default page size is 20, maximum 100.

`--repository-id` is a literal caller-supplied logical identifier, not an
authenticated owner/repository or a remote URL lookup. Capture never reads remote
URLs or authenticates to GitHub. Optional `--pr-metadata metadata.json` accepts:

```json
{
  "verification": "caller-supplied-unverified",
  "provider": "github",
  "repository": "example/project",
  "number": 123,
  "url": "https://github.com/example/project/pull/123",
  "declaredVisibleAt": "2026-09-01T12:00:00Z"
}
```

The URL and timestamp are optional declarations. They do not establish ownership,
PR existence, authorship, review-time visibility, chronology or a verified history.
No PR discussion, provider event or issue claim is inferred from commit messages.

## Commit relationships and exact bytes

- Inputs must be exact lowercase 40-character SHA-1 commit IDs. Branch names,
  abbreviated IDs, missing objects and other Git object formats are rejected
- `baseTip` is the supplied base-branch tip, `head` is the supplied change head,
  and `mergeBase` is computed with installed Git's `merge-base --all`. No common
  ancestor or multiple best ancestors fails closed
- Changed entries are the complete bounded raw diff **from merge base to head**.
  Base-tip-only changes do not become before-content. The checked-out branch and
  uncommitted files are never used as source evidence
- Exact-content rename detection is explicitly enabled; modified renames can be
  represented by additions/deletions. Git's result is preserved, not relabeled.
  Adds, deletes, modifications, type changes and exact renames retain both sides
  with separate old/new paths and modes. Mode-only changes remain visible
- Entries have deterministic bytewise order by destination path (source for a
  deletion), then status, old path and new path. Each side's paths are unique;
  deletion and rename can share a destination/source sort prefix
- Captured regular UTF-8 text retains **exact committed bytes**, including BOM,
  CRLF, valid U+FFFD and a missing final newline, as canonical base64. Each side
  records byte length, SHA-256 and Git blob SHA-1. Reading and importing recompute
  these digests; one object ID cannot carry contradictory size/content claims
- Invalid UTF-8 filenames, non-normalized paths and backslash-containing names
  fail rather than being reinterpreted. Spaces, colons, tabs, newlines and Unicode
  filenames are preserved. No path is materialized or passed to a blob-spec parser

Capture rejects shallow/partial/promisor repositories and nonempty ancestry
grafts. Object replacements, ambient credentials, hooks, external transports and
lazy fetch are disabled by the shared Git subprocess policy. Raw diff explicitly
disables external diff/text conversion and includes submodule changes. No checkout
or worktree is created; existing workspace cleanup guards remain in effect.
This is a trusted local-store workflow, not a defense against a concurrently
malicious repository owner changing Git configuration or deleting objects.

## Coverage and limits

Every changed side is `absent`, `captured`, or `excluded`. Exclusions remain in the
manifest and coverage counts:

| Reason | Evidence retained |
| --- | --- |
| `binary` | Object ID, mode, size, computed SHA-256; bytes omitted |
| `oversize` | Object ID, mode, size; SHA-256 null because bytes were not read |
| `total-byte-limit` | Object ID, mode, size; SHA-256 null |
| `symlink` | Link blob ID, mode and link-blob size; no target traversal or bytes |
| `submodule` | Gitlink commit ID/mode; blob size and SHA-256 null |
| `unsupported-mode` | Available object ID/mode/size; bytes omitted |

Here “binary” means a NUL-containing or invalid-UTF-8 regular blob. It is not
Git's attributes-based binary classification. Symlinks are excluded even when
their link text is UTF-8; submodule target commits need not exist in the parent
repository. Missing required regular/symlink blob objects fail the capture.

Defaults and hard ceilings are 500 changed entries, 256 KiB per retained blob,
and 2 MiB total **retained text bytes**, counting each before/after occurrence,
including repeated blobs. Smaller limits can be supplied to the capture API.
The byte budget is applied in canonical entry order, before then after; binary
bytes are omitted and do not consume retained-text budget. Budget-excluded files
are not inspected to discover whether they are binary. There is separately an
8 MiB ceiling for blob bodies returned by `cat-file`, including binary/repeated bytes; hitting
that ceiling fails the whole capture. Size/type metadata reads are separate. This
is not a bound on physical disk I/O or Git's internal object decompression/rename work.

Each Git subprocess has at most 30 seconds and 1.5 MB combined output. The capture
has a 120-second aggregate Git-work deadline; each subprocess receives the smaller
remaining time budget. Compact content is limited to 4 MB; the input/export JSON
package allows 5 MB for formatting and the bounded receipt. Exceeding inventory,
read, time or encoded-size bounds produces an error, never a truncated successful
manifest. This does not promise timing guarantees for a stalled host filesystem.

## Integrity, receipts and persistence

The canonical content digest includes logical repository identity, exact commit
roles, capture policy, exclusions and optional unverified PR metadata. It excludes
local filesystem paths and capture time. Recapturing unchanged commits with the
same identity/metadata/policy produces the same digest and one stored record.

Capture returns a separate `local-git-check` receipt with check time and observed
repository/common-Git-directory paths. That receipt describes checks performed
by that invocation. It is **not persisted as an authenticated attestation** and a
receipt copied into a file is not trusted. Import/show return
`package-integrity-only`; they never inherit a supplied local-verification claim.
To locally verify again, recapture from the actual repository and compare digests.

Import checks strict schema, canonical package digest, captured bytes and available
cross-field consistency. It cannot establish Git ancestry, tree membership,
inventory completeness, excluded bytes or repository ownership. In particular,
internally consistent caller-supplied commits remain claims. A full 40-character
SHA and matching byte digests alone are not proof that a real PR contained them.

`QualEvoStore.importChangeSnapshot` validates before an atomic single-row insert
into `qe_change_snapshots`. Exact reimports are idempotent; database UPDATE/DELETE
are blocked by the existing immutable-evidence trigger function. Reads revalidate
schema, repository identity and content digest. Bounded bytes live in the existing
database, so no new artifact backend or cross-store commit protocol is needed.
The v1/v2 rule tables and legacy consumers are unchanged. Snapshot persistence is
available through the common PostgreSQL/PGlite store; only local PGlite is tested.

Output-file failure can occur after a successful database insert. Retry/show with
the same digest recovers the record; filesystem output is not a database
transaction. No automatic deletion or recovery over existing data is performed.

## Verification boundary

Tests use authored real Git repositories and real PGlite: pinned commits despite
branch movement/dirty checkout; divergent base tips; exact source bytes; additions,
deletions, renames, modes, types, binary/large files, symlinks and missing submodule
targets; missing objects, malformed paths, ambiguous/unrelated/shallow/partial
history, grafts and resource bounds; import tampering, immutable SQL enforcement,
reopen, separate CLI processes and verification-claim downgrade on import.

No live model, provider API, authentication change, deployment, external upload,
repository publication, scientific-effectiveness claim or full PR workflow is
part of this checkpoint. [Verification results](verification.md) record the checks
actually run.
