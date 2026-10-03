# Sandcastle workspace lifecycle

This is the single FlyReWheel implementation. The earlier sibling `workspace-proof/`
directory is archival research only; application code and maintained tests live here.
`@ai-hero/sandcastle` is exactly pinned to **0.12.0** in the dependency lock.

## What exists

`src/workspace/index.ts` exports `prepareWorkspace`, `inspectWorkspace`, and
`cleanupWorkspace`. The normal FlyReWheel CLI exposes the same three commands.
The allocator adds identity, evidence and lifecycle checks around the real public
Sandcastle `createWorktree` / `Worktree.close()` APIs. It does not implement its own
checkout, worktree removal or branch manager.

This layer is for a **dedicated, trusted Linux repository store**, with its full
local Git history already available. It does not download a repository, fetch
refs, execute repository code, invoke a model, launch a sandbox, or connect to
OpenSandbox. Worktrees share the object database and are not a security boundary.

## CLI

From this checkout, with Node and Git installed:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run cli -- workspace prepare \
  --repo /absolute/path/to/trusted-repo --run pilot-001 --attempt try-001 \
  --base FULL_40_CHARACTER_BASE_SHA --head FULL_40_CHARACTER_COMPARISON_SHA
npm run cli -- workspace inspect \
  --repo /absolute/path/to/trusted-repo --run pilot-001 --attempt try-001
npm run cli -- workspace cleanup \
  --repo /absolute/path/to/trusted-repo --run pilot-001 --attempt try-001
```

Use the main non-bare repository root, not a subdirectory or another worktree.
Shallow/partial clones, checkout filters, configuration includes, symlinked
management directories and worktree-specific Git configuration are refused.
Each run/attempt ID is 1–40 lowercase letters/digits with optional single hyphens.
Every retry requires a new attempt ID, even after failure or clean removal.

`--base` and optional `--head` must be exact, locally present SHA-1 commits.
`--head` defaults to base. The checkout starts at base; the comparison head is
recorded, not checked out. The manifest also records the actual merge base and
initial checkout HEAD. Unrelated histories and unsupported SHA formats fail closed.

All successful commands print JSON. Exit 0 means the requested operation completed;
cleanup returns exit 2 with `preserved-dirty` when dirty or ignored untracked bytes
remain, or index flags prevent verifying tracked-file cleanliness. Errors return
exit 1. `inspect` reports observed identity separately from
persisted status; consumers must check `observation.identityValid` and existence.
There is intentionally no arbitrary shell/agent execution subcommand.

After `npm run build`, the same commands work with `node dist/cli.js workspace …`.
The source runner uses the installed `tsx` loader; the build uses ordinary JS.
The package's inherited Node floor is >=22; this checkpoint was tested on Node
24.19.0 only. Windows support and image/cluster validation are not claimed.

## Identity, retention and bounded work

- Branch: `attempt/<run-id>--<attempt-id>`; the double separator cannot appear in
  either ID. Allocation requires a fresh branch and fresh lease directory
- Worktree: `.sandcastle/worktrees/attempt-<run-id>--<attempt-id>`
- Durable attempt data: `.sandcastle/flyrewheel-attempts/attempt-<run-id>--<attempt-id>/`
  holds `manifest.json`, append-only `history.jsonl`, and distinct cleanup snapshots
- A repository operation lock serializes Sandcastle pruning/creation/cleanup. Two
  different attempts can be prepared concurrently and run independently afterward;
  an atomic per-attempt lease admits exactly one caller for a given identity
- Existing worktrees are never used for a new prepare. Upstream alone can reuse a
  dirty branch and ignore a newly supplied base, so FlyReWheel rejects it first
- Unregistered directories under Sandcastle's worktree root are preserved and block
  operations rather than allowing upstream orphan pruning to delete evidence
- The lifecycle subprocess strips ambient credentials and user Git configuration,
  disables hooks, signing, external Git transports and lazy fetch, and supplies no
  Sandcastle lifecycle hooks. Git subprocesses force case-sensitive path handling
  so a local `core.ignoreCase=true` cannot hide distinct untracked Linux paths;
  the stored repository configuration is not changed. Reopening a clean worktree
  in upstream attempts an origin refresh; the bridge prohibits all Git transports
  so this cannot fetch
- Each external process has a 30-second bound; lifecycle output is limited to 1 MB
  and Git output to 8 MB. Oversize or timed-out operations fail explicitly. This
  bounds coordination, not execution of arbitrary code in a sandbox

The store must be exclusively managed through this layer while operations run.
The guards are not an adversarial multi-tenant filesystem or distributed lock
service. A process crash can leave a lock or an `allocating` lease. Do not recycle
that identity or delete its directory automatically; inspect active processes,
Git registration and evidence before authorized manual recovery.

## Cleanup policy

Cleanup captures status, a binary-capable tracked-file patch, an untracked-path
inventory, index-flag paths and observed identity into a new evidence directory
before removal.
Untracked bytes, including binary and ignored files, remain in the retained
worktree. They are **not** copied into the patch or independently backed up.

Dirty worktrees are preserved. After an operator intentionally commits or otherwise
handles those bytes, another explicit cleanup can remove a now-clean worktree.

Git's `assume-unchanged` and `skip-worktree` flags can hide modified tracked files
from both status and diff. Any such entries conservatively prevent removal,
even when their bytes are unchanged. `observation.dirty` still reports only the
status/untracked result; `cleanlinessVerified: false`, `preservationReasons` and
`indexFlags` explain why cleanup retains an apparently clean worktree. The exact
flagged paths are saved in `index-flags.json` and `observation.json`; their hidden
bytes may be absent from `changes.patch` and remain only in the retained worktree.
The bridge repeats this check immediately before calling Sandcastle's close API.
FlyReWheel never clears index flags itself. An operator must deliberately inspect
the files, restore index visibility and handle changes before retrying cleanup.

FlyReWheel does not offer force-discard or branch deletion. Clean cleanup uses
Sandcastle, then independently verifies that the directory disappeared and the
named branch still points at the recorded final commit. Named branches, output
commits, manifests and earlier cleanup evidence survive. A repeated successful
clean cleanup returns the retained result. Failed or ambiguous cleanup requires
explicit recovery rather than being called successful.

Callers must quiesce writers before cleanup. A trusted external process writing
after the final check is outside this local lifecycle protocol.

## Tests and evidence

`tests/workspace.test.ts` tests the production allocator and real multi-process CLI.
`tests/sandcastle-contract.test.ts` tests the installed public provider APIs with
authored Git fixtures and a bounded local transport **test double**. That transport
is not used by the production CLI and provides no execution isolation.

The tests cover distinct-commit concurrency, full available history, immutable
identity, refusal to reuse branches, dirty/ignored evidence retention, clean branch
retention, pre-abort, complete-history Git bundle transfer, live lines/stdin/nonzero
exit, cancellation/process termination, reuse after cancellation, and failure
evidence. See [verification](verification.md) for actual checkpoint counts.

## OpenSandbox and research boundaries

The selected future direction is Sandcastle for workspaces and OpenSandbox for
execution isolation. There is no OpenSandbox implementation, running service,
Docker/k3s deployment or Temporal layer here. The existing official OpenAI Codex
SDK adapter remains unchanged and is not wired to these workspaces.

The proven `createIsolatedSandboxProvider` contract needs a real backend that
implements binary-safe transfer, live bounded command output, stdin, exact exit
status, cancellation and verified remote termination. Sandcastle cancellation did
not promise sync-out of remote uncommitted files: capture remote diagnostics before
destroying storage. `close()` on a future SDK client is not proof that a remote
sandbox was killed. Running Codex SDK separately also does not automatically invoke
Sandcastle's agent lifecycle or sync-back. No bundled Sandcastle CLI agent adapter
is substituted for the official SDK.

Full-history visibility is deliberate for this workspace capability. Sandcastle's
tested isolated flow bundles **all refs**, potentially exposing later fixes and
other attempts. A checkout at an old SHA is therefore **not time-isolated historical
evaluation input**. A future research evidence view needs an explicit permitted
ref/commit-graph manifest and leakage checks. These workspace tests do not validate
heldout quality, scientific generalization or full-repository Codex execution.

Upstream provenance: [Sandcastle 0.12.0 source](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427).

## Optional evaluation-only export

The normal `all-local-refs-v1` transfer policy is unchanged and does not enforce a
historical cutoff. For experiments, [exact-head evaluation checkout export](evaluation-checkouts.md)
creates an independent, standalone repository with a verified caller-selected
object closure and full committed source/test tree. It is an immutable local
baseline, not another worktree manager or an automatic production-mode switch.
Historical public availability remains unproven; timestamps alone are not proof.

Explicit [evaluation workspace execution](evaluation-workspaces.md) now derives a
separate mutable repository from that baseline and carries a path-free export
binding through existing Sandcastle execution and application receipts. The option
is never inferred from a date, repo path, or default production policy.
