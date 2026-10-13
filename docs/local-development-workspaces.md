# Local development workspace lifecycle

The local adapter creates a fresh managed Git worktree at an exact existing commit,
exports an exact-selection prepared resolver configuration, records content-hashed
observations, and removes only its clean owned worktree. It is a development/test
facility for a dedicated trusted Git store, not a production sandbox or model
runner. No repository program is executed.

## Commands

Build with `npm run build`. Supply an explicit input JSON file:

```json
{
  "repoPath": "/absolute/path/to/dedicated/git-store",
  "selection": {
    "workspaceId": "development-review",
    "jobDigest": "<64 lowercase hexadecimal characters>",
    "repository": "<exact repository identity>",
    "kind": "semantic-review",
    "baseSha": "<existing full base commit SHA>",
    "headSha": "<existing full head commit SHA>",
    "expectedSha": "<same head commit SHA>"
  }
}
```

Use the actual application job selection; placeholders above are not executable.
Mining selects `baseSha`; semantic review and revision generation select `headSha`.
Evaluation exports are unsupported. Every creation uses a new generated identity;
callers cannot adopt a previous worktree by supplying its run/attempt ID.

```sh
node dist/cli.js workspace local create --file input.json --out receipt.json
node dist/cli.js workspace local status --file receipt.json
node dist/worker.js --check --local-development receipt.json
node dist/cli.js workspace local evidence --file receipt.json --digest <createdEvidenceDigest>
node dist/cli.js workspace local cleanup --file receipt.json
```

Keep the exact creation receipt. Status exports `preparedWorkspaces` only while
its manifest, identity, clean state and SHA still match. The exported
`createLocalDevelopmentResolver(receipt)` uses the existing resolver and reinspects
the worktree on resolution. Worker local preflight reports `localDevelopment:
ready` separately from `productionReady: false`. It does not claim a queued job.
`worker --local-development` without `--check` refuses execution. Passing both
local and production check options is an error.

Cleanup delegates to the existing workspace lifecycle. Active execution leases
block cleanup; dirty, ignored or untracked files are retained. Retained cleanup
returns exit code 2. Missing/altered ownership or evidence fails closed. Clean
cleanup removes the worktree; the source repository, attempt branch, commits,
manifest/history and evidence remain. Main source files and HEAD are unchanged,
but preparation adds Git/workspace metadata. Evidence remains readable after
cleanup, including in a new process. This is not secure erasure.

## Guarantees and boundaries

The receipt and owner marker are local bookkeeping, not credentials or an
independent authorization mechanism. Hashes detect content changes relative to
stored digests; they do not authenticate a malicious host or provide an externally
frozen immutable snapshot. The adapter assumes a trusted dedicated local store
and cooperative lifecycle users; it provides no isolation from concurrent host
processes. Failed preparation/evidence recording may retain resources for manual
inspection; it never force-removes them to conceal a failure.

Security isolation, arbitrary repository program execution, whole-runtime stop,
externally frozen evidence collection and independently verified physical resource
destruction are **unsupported**. The adapter does not implement
`OpenSandboxLifecycleAuthority` or fabricate successful Codex runtime receipts.
Production preflight continues to require that authority, even with a valid local
prepared resolver. No host security/network settings or persistent authorization
are changed.

## Verification

[Recorded acceptance](evidence/local-development-lifecycle-verification-2026-10-13.json)
uses real Git operations on a newly authored temporary fixture repository, not
upstream project input or model output. It exercises compiled CLI creation,
resolution, worker checks, cross-process evidence reads, clean removal and dirty
preservation. Source files and the main HEAD stay unchanged. The temporary
artifacts are retained at the path recorded in the report.

Reproduce with a **new, nonexistent** output directory:

```sh
npm run build
node scripts/smoke-local-development-lifecycle.mjs /tmp/flyrewheel-local-new-run
npm test -- tests/local-development-workspace.test.ts tests/prepared-workspace-resolver.test.ts
```

The focused tests additionally cover active leases, ignored files, altered
ownership, evidence tampering, exact selector mismatches and repeated cleanup.
There are no model calls, credential reads, sandbox allocations or W1 reads.
