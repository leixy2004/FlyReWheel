# Converged application checkpoint: 2026-10-04

This task branch combines the verified `a05af56c4427859a2e003e7581f129c75aafb73b`
application/research tree with missing GitHub branch changes. It does not merge
main, activate a production worker, provision a sandbox or run a model. Merge
history retains the original commits; historical synthetic merge refs are not
replayed as separate features.

## Convergence inventory

| Source tip | Incorporated change | Evidence boundary |
| --- | --- | --- |
| `82bdad9efc09912f7200959fcda7750fcee67c80` (PR33/34) | Literal POSIX-quoted continuation paths; executable aliases resolve by real path; corrected offline instructions | Offline/authored execution only; imports remain inert |
| `eefd35c3814684e22046022df248429789bccb33` (PR36/37) | Reject future-dated base/feedback before storing revision requests; authored shadow-governance loop; finalize exact committed outcomes and workspace cleanup on replay | Authored feedback remains Unknown; no production activation or general crash recovery |
| `8dc8070d22b26291d978aa58a4fd59a375a350df` (PR35) | Explicit Node executable, scoped descendant reaping, full Docker IDs, named/redacted inspection checks, cleanup-only recovery independent of Node | Trial/supervisor code is integrated; no new live trial |
| `d5f0b49db7da7cb53c5c8528433c8b3fc295651f` (PR32) | Pinned official Kubernetes schema validator, lock/pins, negative tests and historical rendered evidence | No cluster deployment; executable/schema cache is not bundled |
| `1565fade76e4fe640bcfc810415e491d7ac6e13b` (PR27 follow-up) | Six-export native bridge and blocked-reopen evidence | Existing captured data only; no new data acquisition or eligible empirical episode |
| `54a2f4dfebc9a3a5e7c03930ac9997b19db8d96e` | Historical offline CLI smoke report | Dated results are not current-tree test results |

The existing PostgreSQL recovery, workspace resolver/composition, evaluation
registry, read-only revision preflight and measured PGlite setup fixes were
already inherited. So were the paper source audit, matched contract and native
macro reporting. These implementations are not applied twice. No dependency,
queue topology, worker enablement or credential configuration is changed here.

## Usable local paths

Start with the [offline guide](offline-reproducibility.md), then the
[authored governance loop](local-governance-loop.md). The latter exercises
feedback attribution, revision decisions, explicit local-shadow selection,
stale-plan refusal, a persisted review, verified workspace finalization and
fresh-process replay. Both source and compiled CLIs use the same domain path.
Use a new output directory; retained failed directories are evidence, not
permission to remove execution markers or promote an uncommitted outcome.

The [native macro report](../experiments/matched-revision/native-macro-report.md)
replays canonical authored schedules and receipts. Unknown costs and references,
missing/interrupted results, declared clusters and withheld intervals remain
explicit. Numeric fixture summaries are not empirical model effectiveness.

## Current runtime and deployment limits

PR35's retained [trial](evidence/opensandbox-retry-2026-10-04/README.md) observed
verified-TLS SDK readiness and allocation, then failed inspection before commands,
status or pause. Its overall result remains failed and `cleanup-unverified`; an
inert historical zombie was retained in the cleanup evidence. Later inspection
and supervisor corrections were verified offline, not by another live trial.
This supersedes older narratives saying that retry still awaits authorization;
it does not establish complete lifecycle or production readiness.

PR32's [render/schema evidence](evidence/kubernetes-offline-2026-10-04/README.md)
is now incorporated, while its original checkpoint receipts stay unchanged.
It verifies pinned offline artifacts, not admission, storage, network enforcement,
server defaults or actual cluster deployment. Missing renderer/schema dependencies
must be reported as skipped/not run; old successful tool runs do not close current
environment gaps. The default application worker remains blocked until explicit
trusted runtime composition and lifecycle authority are supplied.

## Verification discipline

Run `npm run typecheck`, `npm run build`, the relevant focused tests, and the
unchanged default `npm test` (two workers) on one fixed candidate. In addition,
verify the Python supervisor's fake-process tests, source/compiled governance
first-run and replay, and stored-render contract checks. Actual cluster/model or
sandbox provisioning is not part of these checks. Preserve old failed aggregates
and record the new candidate SHA, terminal exit codes and log hashes separately;
no result from an input branch is inherited as a current-tree pass.
