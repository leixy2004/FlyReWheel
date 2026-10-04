# Executable entrypoint identity audit

Audited first-party Node/TypeScript entrypoint guards at frozen baseline
`9d98197fa6183f98e5da15d5c207167f8d3dbcb2` across `src`, `scripts`, `deploy`
and `experiments`. This follow-up changes when an existing main body is entered;
it does not change that body's validation, permission gates or execution policy.

## Defect and shared comparison

Ten guards compared lexical paths. Node normally resolves the module URL through
a symlink while `process.argv[1]` can retain the alias. Launching the script through
that alias silently exited 0 without running main. The reproduced preparation
case failed to reject missing `--db`/`--out`, and would not prepare valid inputs.

`scripts/lib/is-main.mjs` compares native `realpath(argvPath)` with
`realpath(fileURLToPath(moduleUrl))`. Absent, unavailable or different executable
paths return false, preserving import-only behavior. No manual URL decoding, case
normalization, slash rewriting, cwd fallback, argv mutation or environment override
is introduced. This detects executable identity; it never authorizes a data path.

| Guarded module | Resolution |
| --- | --- |
| `scripts/prepare-w0-mining.ts` | Replace lexical guard with shared helper |
| `scripts/capture-w0-first-three.ts` | Replace lexical guard with shared helper |
| `scripts/materialize-w0-context.ts` | Replace lexical guard with shared helper |
| `scripts/check-w0-behavior-inputs.ts` | Replace lexical guard with shared helper |
| `scripts/run-w0-proxy-attempt.ts` | Replace lexical guard with shared helper |
| `scripts/prepare-w0-evaluation-inputs.ts` | Replace lexical guard with shared helper |
| `scripts/diagnose-w0-first-read.ts` | Replace lexical guard with shared helper |
| `scripts/verify-worker-container.mjs` | Replace lexical guard with shared helper |
| `scripts/validate-temporal-frame.mjs` | Replace lexical guard with shared helper |
| `scripts/check-opensandbox-local-plan.mjs` | Reuse helper for its already-correct comparison |
| `deploy/validate.mjs` | Reuse helper for its already-correct comparison |
| `deploy/workspace-worker/prepare-image.mjs` | Fix locally; Docker copies this file alone before source/dependencies |
| `src/workspace-worker-entrypoint.ts` | Keep existing correct comparison and all security checks unchanged |

The helper has no dependencies outside Node built-ins. Its `.d.mts` declaration
provides types to source scripts without requiring plain Node tools to load
TypeScript. The two self-contained entrypoints deliberately retain the same small
comparison: neither deployed worker nor standalone image staging depends on
repository scripts. Both Dockerfiles, their allowlists and runtime assets are
unchanged.

The scan found no other pathname-based first-party main guards. Existing directly
executed programs (CLI/worker, Sandcastle child processes, replay, capture, verifier
and smoke scripts) retain their top-level execution semantics; they are not made
import-safe by this change. The two Python entrypoints use `__name__ == '__main__'`
and need no pathname fix. Vendored upstream evidence and historical receipts are
not edited.

## Checks and remaining limits

- The regression first reproduced the preparation alias returning empty output
  and success instead of the direct path's argument error.
- The invocation matrix checks all ten repaired scripts using absolute direct and
  file-symlink launches, rejecting invalid arguments before acquisition, allocation
  or staging. Preparation additionally covers relative direct/alias paths and a
  symlinked parent directory. Paths include spaces, quotes, `#` and `%`.
- All 13 guarded modules are imported with absent, unrelated and nonexistent
  `argv[1]` without entering main. A copied-alone `prepare-image.mjs` still runs its
  validation without a helper, source checkout or installed dependencies.
- A valid preparation through a symlink imports the existing frozen W0 inputs into
  local PGlite, verifies close/reopen, writes ten artifacts, retains zero models/
  labels/candidates and rejects reuse without changing the ledger.
- Helper checks cover decoded URL characters, both symlink directions and Node's
  `--preserve-symlinks-main` identity behavior. That flag can separately change
  relative import resolution; arbitrary relocated aliases still need their
  dependencies available. No loader or packaging workaround is provided.
- Existing source and freshly compiled worker tests retain production blocking and
  authored fixture behavior; container recipe and W0 validation tests remain
  separate from actual Docker builds or source capture.

All execution in this audit is Linux Node, local filesystem/Git/PGlite and authored
fixtures. Native Windows/macOS behavior is not exercised; no emulated path strings
are presented as platform verification. Symlink recognition does not certify
workspace ownership, isolation, model access or deployment readiness. No actual
model, upstream acquisition, container build/allocation or cluster operation ran.

PR24 `9f51467` and PR33 `9d98197` stay frozen. This candidate requires its own
review and verification; it does not inherit either parent's full-suite result.
