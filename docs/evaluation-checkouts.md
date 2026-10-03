# Optional exact-head evaluation checkout

This local, opt-in export closes an important **Git visibility** gap: the production
Sandcastle transport intentionally transfers `all-local-refs-v1`, so its normal
worktree/clone is not a historical cutoff. That production policy is unchanged.
`evaluation checkout export` creates a separate, standalone repository containing
only the union of objects reachable from explicitly allowed full commit SHAs.
It does not implement another worktree manager or execute repository code.

**Development-fixture verification only:** the included tests and compiled smoke
use authored histories. Their success is not an empirical paper result, a model
quality claim, or proof of historical public availability.

## CLI and input

Create a visibility JSON file; replace the SHA placeholders with full lowercase
40-character SHA-1 commit IDs. The selected checkout must be one of the allowed
heads. Neither branch names, tag object IDs, abbreviated SHAs nor revision
expressions are accepted.

```json
{
  "schemaVersion": 1,
  "repositoryId": "development-fixture/example",
  "classification": "development-fixture",
  "allowedHeads": ["FULL_40_CHARACTER_ALLOWED_COMMIT_SHA"],
  "checkoutSha": "FULL_40_CHARACTER_ALLOWED_COMMIT_SHA",
  "visibility": {
    "basis": "caller-declared-exact-heads",
    "declaredAsOf": "2026-01-01T00:00:00Z",
    "evidenceDigests": []
  }
}
```

For real, still-unverified evaluation inputs use classification
`unverified-evaluation-input`. `declaredAsOf` can be null. Evidence digests are
caller-provided references; this exporter does not authenticate or retrieve them.

```sh
npm run build
node dist/cli.js evaluation checkout export \
  --repo /absolute/trusted/source-repo \
  --store /absolute/independent/evaluation-exports \
  --manifest /absolute/visibility.json
node dist/cli.js evaluation checkout inspect \
  --store /absolute/independent/evaluation-exports \
  --manifest /absolute/visibility.json
```

The source runner supports the same commands via `npm run cli --`. Successful
commands emit JSON containing `repoPath`, `manifestPath`, `requestDigest`,
`recordDigest`, and fresh verification observations. Errors exit 1. There is no
model, execution, upload, fetch, or timestamp-based pruning command.

The source and store must be canonical absolute paths. The store must be outside
all existing repositories and independent of the source, with an existing real
parent directory. Its leaf directory can be created by export. Inputs must use a
dedicated, trusted full main repository; linked worktrees and bare repositories
are not supported. Worktree/untracked source bytes are not imported: only the
selected committed tree and allowed object closure are exported.

## Git contract

1. Refuse incomplete or indirect source storage: shallow markers, promisor/partial
   clones, alternates, grafts, replace refs, shared directories, symlinked/hardlinked
   object files, configuration includes, checkout filters and unsupported config
2. Verify each exact SHA is a commit, then enumerate its complete ancestor/tree/blob
   closure using `rev-list --objects --no-object-names`; disable commit-graph caches
   and replacement objects
3. Feed only those explicit object IDs to Git `pack-objects`; use no `--all`, tag
   inclusion, thin packs, object copying, object/delta reuse, or source ref changes
4. Initialize fresh standalone Git storage with an empty template, import via
   `index-pack --strict`, create only `refs/heads/allowed-<sha>`, and detach HEAD at
   the selected allowed head; no remotes, alternates or hardlinks are introduced
5. Independently recompute destination reachability and compare it to the complete
   destination `cat-file --batch-all-objects` inventory, including unreachable
   objects, and the recorded source closure; run full strict `fsck`
6. Verify exact refs, detached HEAD, clean index without hidden index flags, and
   every filesystem entry against the selected tree. Compare committed file bytes
   directly with blob SHA-1s and verify executable bits. Symlinks and submodules in
   the selected tree are refused; checkout transformations such as CRLF or ident
   expansion fail closed rather than claiming exact committed bytes

Git control/object files are independently SHA-256-bound in the manifest.
Unexpected metadata files/directories, comments added to config, future loose
objects, nested `.git` files, special files, ignored/untracked bytes and changed
file contents all invalidate reinspection. No auto-repair, deletion, reset, or
replacement is performed.

The implementation reuses the existing sanitized, process-group-bounded workspace
Git helper and SHA/path guards. Optional bounded stdin supports Git plumbing; all
exporter Git calls use `/usr/bin/git`. Ambient authentication, external transports,
hooks, lazy fetching, system/global attributes and optional index-refresh writes
are disabled. No new dependency or deployment configuration is introduced.

## Identity, retries and limits

The sorted allowed-head/evidence sets plus the complete declaration are canonical
JSON-hashed. The store allocates `export-<requestDigest>/` once, with `request.json`,
`repo/`, and finally `manifest.json`. The completion manifest is written only after
verification. The original caller declaration is required for inspect, rather than
trusting an arbitrary self-declared directory manifest.

An identical retry verifies and returns the existing export unchanged. A failed or
interrupted attempt remains in place without a success manifest and cannot be
silently recycled. Changed visibility declarations produce a distinct identity.
Concurrent same-identity allocation may fail; retry after the successful allocator
finishes. Both source and destination must be protected from concurrent writers.

`requestDigest` and logical object `inventory.digest` are independent of local
paths. `recordDigest` also covers instance-specific Git metadata, including the
index, and can differ across fresh exports of identical history. Neither hash is
a signature or authenticated provenance. Keep the completion record alongside the
original input and verification report; do not edit an exported baseline in place.
Normal Git commands that rewrite its index/metadata can intentionally invalidate
its strict reinspection contract. Use the separate evaluation workspace preparation
API when a mutable attempt is needed; never allocate a worktree in this baseline.

Conservative fixed bounds: 64 allowed heads, 100,000 objects/files, 64 MB per
expanded object and compressed pack output, 256 MB total expanded object bytes
and selected-tree bytes, 8 MB Git textual output, 100 KB input/record JSON, and
128 MB total exported Git files. Each export/inspection Git phase has a 120-second
aggregate command deadline and process-group termination. Filesystem checks are
byte/entry bounded, not a guaranteed whole-operation wall-clock deadline. The
trusted store still needs OS-enforced disk/process quotas; this is not a resource
sandbox. Oversized input is rejected, never partially admitted. Linux and SHA-1
are the currently supported execution/format boundary.

## What this proves, and what it does not

The receipt verifies **exact caller-selected Git object closure and selected-tree
bytes**, not historical truth. Every receipt says
`historicalPublicAvailability: unproven` and
`timestampsEstablishVisibility: false`. Commit author/committer timestamps can be
backdated; provider timestamps and caller cutoffs alone do not prove which commits
or information were publicly available. Selecting a head includes *all* its
ancestors, regardless of their dates. If an allowed ancestor already contains an
answer, that answer correctly remains in the closure. The caller must separately
justify the allowed set with independently defensible visibility evidence.

This repository export is **not an execution sandbox**. It cannot restrict an
agent that can access the original source store, other host paths, network,
retrieval services, or model training knowledge. Mount/transfer only the admitted
export into a separately restricted evaluator. The existing workspace/transport path is not automatically switched. Explicit
[evaluation workspace execution](evaluation-workspaces.md) now derives an independent
repository and binds this export through the existing supervised runner. Ordinary
production runs retain all-local-refs and acquire no temporal-isolation claims.

The export is an immutable local baseline. If a downstream executor needs a mutable
attempt/worktree, it must create that separately using mature Git/Sandcastle tools;
mutating the baseline invalidates this inspect contract. The opt-in integration verifies end-to-end Git transfer admission with authored
fixtures. Production isolation provisioning, public historical visibility, model
performance, empirical datasets and authenticated human labels remain separate work.

## Verification

The focused suite contains 48 authored development-fixture tests across the export
and CLI files. It exercises packed future branches/tags/notes, a reflog-only future
commit, a dangling future blob, exact multi-head unions, unchanged source refs,
full source/tests, canonical request identities, same-directory retries,
unsupported storage, incomplete attempts, transformed trees, metadata/hidden-file
and FIFO tampering, and compressed/repeated-blob size bounds.

The [compiled smoke result](evidence/compiled-evaluation-checkout-smoke-2026-10-02.json)
and [reproducible smoke script](../scripts/smoke-evaluation-checkout.mjs) test the
compiled API and a separate compiled CLI process without executing target code.
The smoke deliberately gives the future answer the same old Git timestamp as the
allowed head, demonstrating SHA selection rather than misleading date filtering.
See the [aggregate verification record](evidence/evaluation-checkout-verification-2026-10-02.txt)
for exact full-suite/typecheck/build status.

### Primary Git references

- [rev-list](https://git-scm.com/docs/git-rev-list): reachability and object enumeration
- [pack-objects](https://git-scm.com/docs/git-pack-objects): explicit object-list input and self-contained packs
- [index-pack](https://git-scm.com/docs/git-index-pack): strict pack ingestion
- [cat-file](https://git-scm.com/docs/git-cat-file): inventory of all available objects
- [fsck](https://git-scm.com/docs/git-fsck): full integrity versus connectivity-only checks
- [gitattributes](https://git-scm.com/docs/gitattributes): checkout transformations
