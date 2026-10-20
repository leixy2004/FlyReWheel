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

## Durable attempt cancellation

```sh
node dist/cli.js workspace cancel --repo /path/to/trusted-store --run run-id --attempt attempt-id --reason 'Stop this attempt'
node dist/cli.js workspace inspect --repo /path/to/trusted-store --run run-id --attempt attempt-id
```

Cancellation permanently fences this attempt against new execution leases. It is
serialized with lease acquisition and cleanup; repeated requests preserve the
first reason and timestamp. Allocate a fresh attempt to run again. Inspection
reports `cancellation` and `executionLeaseActive`; these are observations, not a
reservation or proof that a runtime stopped. Cancellation never removes an active
lease. Cleanup still refuses active leases and preserves dirty worktrees, and a
clean cleanup retains the cancellation record. A crashed owner's lease needs
explicit recovery; no automatic expiry or PID-based takeover is provided.

This is a cooperative local lifecycle constraint, not a production sandbox.
The reproducible compiled CLI acceptance uses only a newly authored Git fixture:
`npm run build && node scripts/verify-workspace-cancellation.mjs`.

The Codex workspace runner observes durable cancellation before reserving a
runtime, polls every 100 ms during preparation/execution, and checks again before
accepting output. Polling is cooperative and depends on a responsive host event
loop; it is not a hard real-time stop guarantee. A request arriving after output
acceptance does not retroactively invalidate that result, but still fences future
leases. Cancellation during cleanup never skips stop/collect/destroy verification.
Unverified stop, evidence collection or destruction retains the recovery lease
and continues to block worktree cleanup. The cancellation record remains after a
successful release. Other callers of the lease API must observe
`isCancellationRequested()` themselves; cancellation does not kill arbitrary host
processes. Crashed runners are not automatically recovered.

`node scripts/verify-workspace-cancellation-runner.mjs` verifies actual compiled
CLI cancellation against a pending compiled runner with an injected authored
backend. This verifies lifecycle control, not real model execution or production
runtime stop/destruction. Both verified and unverified stop scenarios are covered.

## Residual lease diagnosis

```sh
node dist/cli.js workspace diagnose --repo /path/to/trusted-store --run run-id --attempt attempt-id
```

This read-only command reports lease presence, bounded owner metadata (commit and
creation time, never the ownership token), cancellation state, worktree
preservation conditions, repository operation locks and registry problems that
can block cleanup. Missing, malformed, oversized or symlinked owner records are
`unverifiable`; a damaged cancellation record is reported without hiding the
other diagnostics. Unknown attempts/invalid manifests fail rather than inventing
an identity. A completed diagnostic returns exit 0 even when blockers exist;
inspect `cleanup.blockedReasons` rather than interpreting exit 0 as permission to
clean up. Output is an unlocked observation, not an atomic snapshot or recovery
authorization. A no-blocker observation still requires fresh cleanup checks.

Lease liveness remains unknown even when its owning process has exited or its
creation time is old. The recovery section lists evidence still required: exact
owner/runtime association, independent stop and restart fencing, preserved
execution evidence, verified destruction, and ownership/worktree revalidation.
It neither obtains nor certifies that evidence. No automatic release, force
cleanup, PID-based takeover or production stop proof is provided. The existing
owner lifecycle remains responsible for verified release; abandoned leases need
operator investigation outside this diagnostic command. Hostile-host filesystem
races and production runtime recovery are not validated here.

Reproduce local acceptance with `npm run build && node
scripts/verify-workspace-diagnostics.mjs`. It uses a new authored Git fixture, a
separate process that exits holding a real local lease, and compiled CLI reads.
Malformed-record experiments affect only that disposable fixture. No model,
credential or production sandbox is involved.

## Repository inventory

```sh
node dist/cli.js workspace list --repo /path/to/trusted-store
```

No run/attempt IDs are required. Entries are sorted by managed directory name and
include the existing diagnosis: cancellation, lease metadata without owner tokens,
cleanup blockers and outstanding recovery evidence. Closed attempts remain listed.
A repository with no workspace metadata returns an empty inventory without
creating metadata. Invalid entries, missing/corrupt/mismatched manifests and
linked attempt directories appear with a fixed error code and null diagnosis;
healthy entries remain visible. Shared metadata directory corruption fails the
command rather than silently presenting an empty or complete inventory.

`summary.diagnosed` counts returned diagnostics, not healthy or recoverable
workspaces. Check each diagnosis's blockers and each entry's `error`.
A completed listing exits 0 even with damaged entries. Enumeration and diagnosis
are unlocked observations: concurrent changes can produce per-entry errors and
newly allocated entries may not be included. This is not an atomic snapshot,
recovery authorization, liveness determination or cleanup operation. It never
releases leases or edits manifests. Only managed attempts are enumerated; unrelated
Git worktrees are not adopted.

Reproduce compiled CLI acceptance with `npm run build && node
scripts/verify-workspace-list.mjs`. This uses a fresh authored Git fixture and a
separate process that exits holding a real local lease, without model calls or
production sandbox claims.

### Filter and page the inventory

```sh
node dist/cli.js workspace list --repo /path/to/trusted-store --filter leased --limit 20 --offset 0
node dist/cli.js workspace list --repo /path/to/trusted-store --filter cancelled
node dist/cli.js workspace list --repo /path/to/trusted-store --filter attention
```

`--filter` defaults to `all`. `leased` selects present leases, `cancelled` selects
cancellation requests, and `attention` selects either plus cleanup blockers
(including dirty worktrees and repository operation locks). Errors and unverifiable
records remain included in **every** filter, even when their lease or cancellation
state cannot be determined. Such entries occupy ordinary page positions: follow
all pages to see every damaged record.

Entries are sorted by directory name in ascending JavaScript code-unit order,
then filtered, then paged. `--limit` defaults to 100 and accepts 1–1000;
`--offset` is a nonnegative safe integer and defaults to 0. `pagination.matched`
counts all filtered entries, `returned` counts this page, and `nextOffset` is null
at the end. An offset beyond the end returns an empty page. `summary` continues to
count the entire inventory before filtering. Invalid options fail the command.
The implementation still inspects the complete inventory to preserve damaged
records; pagination limits output, not scan cost. Ordering is deterministic for
an unchanged store, but concurrent additions/removals/state changes can shift
pages. No cursor snapshot or cross-call consistency is claimed.

## Real local process cancellation verification

`boundedProcessBytes` accepts an optional final `AbortSignal`. A pre-aborted
signal prevents spawning. Aborting an owned running command requests SIGKILL on
its Linux process group by default, and rejects after the child's close event;
with `detached=false` only the direct child is targeted. Abort listeners are
removed when the child closes or spawn fails. Existing callers without a signal
retain their timeout/output-bound behavior. This does not add an arbitrary
program execution CLI or automatic abandoned-lease recovery.

Run `npm run build && node scripts/verify-workspace-real-process-cancellation.mjs`
to exercise compiled CLI cancellation while a real owned Node child and same-group
descendant are running. The authored adapter passes the runner's AbortSignal to
the process helper. The check observes both processes running before cancellation,
then waits for helper completion and verifies both are absent or terminated
zombies in Linux `/proc`. A zombie awaits the host reaper; PID existence alone
is not proof of a running process. No signals target pre-existing processes.
The success case releases the lease only after the adapter's stop check. A second
case actually terminates the processes but deliberately refuses a verified stop
receipt, demonstrating that the lease and cleanup block remain.

The child code is an authored fixture, not upstream repository code or model
output. Prepare/collect/destroy callbacks remain authored test adapters; no
production runtime destruction is being verified. Process groups do not contain
descendants that escape with a new session/group, and this check does not test
hostile programs, sandbox isolation, crash takeover, PID reuse or production
recovery authority. A local child close does not authorize recovery of another
attempt. Temporary diagnostic artifacts and the intentionally retained lease
remain available; terminated zombies may await the environment's PID 1 reaper.

## Persistent evidence for a fixed owned local child

```sh
node dist/cli.js workspace process-evidence probe --directory /tmp/new-probe-evidence
node dist/cli.js workspace process-evidence inspect --directory /tmp/new-probe-evidence --identity-digest <digest-from-probe>
```

`probe` requires a new absolute directory. It starts only an embedded Node probe,
not repository code or a supplied command. The fixed program creates no descendants
and exits when asked by its original creator or when its IPC owner disconnects.
Before stopping it, the creator persists a UUID, Linux boot ID, PID, `/proc`
start ticks and fixed-program digest. Only the original in-memory child handle
can request stop. A three-second fallback requests SIGKILL on that same handle;
this is not a promise of bounded kernel termination. No reopen/kill-by-PID API is
provided. `probe` records actual child `close` evidence before returning.

`inspect` can run in a new process. It requires the expected identity digest,
validates bounded non-symlink evidence files, boot identity, current birth identity
if the PID is present, and the creator-close evidence binding. It returns exit 2
when stop evidence is insufficient (including a missing creator record even if
the process is absent or zombie); malformed/mismatched evidence fails with exit 1.
It returns exit 0 only for verified **fixed-child** exit. Checksums protect content
integrity relative to the caller's digest, not against a malicious local writer.
The caller should retain that digest separately. Inspection is an unlocked
observation, does not signal a process, and never authorizes lease release.

This deliberately does not bind or adopt any existing workspace attempt/runtime.
`automaticRecovery` and `leaseReleaseAuthorized` are always false. A creator crash
can leave only identity evidence. Even though this cooperative probe exits on IPC
disconnection, absence is not used to invent the missing creator-close receipt.
Production containment, escaped descendants, arbitrary crashed workloads and
recovery ownership remain unsupported. A kernel/host crash can also lose buffered
writes; incomplete evidence fails closed rather than authorizing takeover.

Run `npm run build && node scripts/verify-local-process-evidence.mjs` for actual
compiled CLI verification across process restart, identity mismatch, insufficient
and corrupt evidence, normal child exit, and a separately launched owner exiting
without recording stop. These are local owned processes, not a production sandbox.
