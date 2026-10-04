# Context and composition integration candidate

This candidate starts from main `e79954c888f5bffb2cf99283e76d3a90e46bd46c`
(the user-approved PR16 merge). PR20 stays frozen at
`0b476d9f6835fec63b3b924c0de3120d3c79922f`. PR24's first published checkpoint
was `37d31a2e2ab360fbb99ef3a81b5e51b30e152ffa`; tests against that checkpoint
must not be attributed to later heads. Main is not merged by this integration.

## Fixed inputs

| Input | Commit | Boundary |
| --- | --- | --- |
| PR20 W0 preparation | `0b476d9f6835fec63b3b924c0de3120d3c79922f` | Historical hosted 104 files / 1734 tests; same-tree synthetic merge `ed18074c33eb96721a69aaf6782ae56f8a0777a4`. No new-main-base rerun was observed at reconciliation. |
| PR21 full committed context | `dfee04c00674371551153c71c02473b2205a44de` | Six exact-SHA exports, 114 committed files each. Source availability is not model or historical-visibility evidence. |
| PR22 application operations | `1bc2afffdd28c5ebde64f81e39944d816fdca8f7` | Offline operations and injected composition; no default deployment authority. |
| PR23 behavior failures | `ce9b9fbfc3abf5d1d542652e0b19ca01fca8e4fc` | Original missing docs wheel and Ruff launch failures retained; zero effective paired behavior results at this head. |
| PR25 Ruff retry | `a7adb0ee4c86fd6e72f5a1327ff2ac0e0a8ec760` | One subsequent bounded before/after lint+format pair passes. No effectiveness or defect label. |
| PR26 corrected recovery/resolver | `6a1a8ac1d56f659f2e7d96b000739025f9755672` | Late-EOF result acceptance corrected; authored protocol/local Git verification only. |
| PR28 evaluation-aware resolver | `ba319f64eafc06b816975ee159c510a8404e0644` | Explicit offline-study registry, complete binding retained; no deployment authority. |
| Runtime tooling follow-up | `036e64ae1182348491d6587d028a156d17f0f8be` | Persisted single-allocation/deadline and bounded cleanup diagnostics; no new real trial. |
| PR30 deployment contract | `6c2185c7eb47e3856fd86f5aeb56d8ba7f3aed5f` + fix `066c69a` | Secret-free structural validation, documented S3/concurrency scope; real rendering skips retained. |
| Staged annotation protocol | `ea1d5e80a0e0f4bf1ef198012309defe87b27d5c` | Proposed budgets and gates; no actual annotations/resources or sampling changes. |
| PR29 registry inspection CLI | `8f26428d6723dd8792d8733301a4098c57138b06` + registration `0299179` | Actual compiled CLI verified on an authored local Git export. |
| PR27 hardened drafts / real resolver record | `2cb82efbefc764f2b0b04f5ec64da3601da0ef64` | Six real W0 diagnostic resolver successes; no persisted job or mining run. |
| PR27 evaluation provenance | `d778aba7c1abcd029bb90ce94d7f6f4e9f583cd8` | 3 requests, 8 source bindings, 6 contexts; no annotation or effectiveness result. |
| Offline CLI reproduction | `084eb9c` | 13 actual offline commands; blocked real jobs and separate authored evaluator. |
| Preparation cleanup | `a5784fc` | Local PGlite failure injection verifies primary-error preservation and single close of released handles. |
| Paper method/artifact map | `6afdf2b` | Hypotheses, comparators, cutoffs and denominators mapped to implementation and missing evidence. |

## Cleanup correction and verification

`QualEvoStore.initialize` already closes its database when migration fails. An
earlier concern that initialization before try/finally itself caused a leak was
not established. The actual defect was a failed reopen leaving the old closed
store in finally, with a second close potentially masking the primary error.
Cleanup could also mask an import error. The correction explicitly releases
ownership before close/reopen and preserves an already-thrown operation error.
A cleanup-only error still fails the operation and prevents a completion ledger.

Two regression tests failed before the fix (2 failed / 2 passed), then passed.
The final focused suite passed 5/5 locally in 12.16 seconds and independently in
13.21 seconds. These run a real local PGlite database with authored failure
injection. They do not test real PostgreSQL or prove that a close failing before
resource release cannot leak. The adapter's waitReady path was not changed.
Typecheck/build passed with the final cleanup-only test included; full candidate
validation must still be recorded against its exact head.

## W0 evidence boundary

PR25 saved-artifact review verified 11 manifest entries, identity fields, binary
hash consistency and six successful commands. Source mutation guards are reported
by the saved run, but the per-file 114-entry manifest was not retained and the retry
script does not revalidate export Git identity. Independent review cannot
reconstruct every source-file-to-tree binding from PR25 alone. This non-blocking
reproducibility limitation remains; no new acquisition or retry was performed here.

The mkautodoc 0.2.0 sdist received hash/static inspection only. Documentation and
external-action behavior remain unknown. Model results and independent human
labels remain zero. The fixed API acquisition ledger remains 48/50; separate Git,
image and package traffic must not be counted as those API requests. One passing
Ruff pair does not establish rule yield, semantic eligibility or scientific effect.

## Separately pinned runtime experiment

The external runtime lane's [fixed experiment record](https://github.com/leixy2004/FlyReWheel/blob/9d79a9f610af7e9c5a18986d3dd6dd280d85a810/docs/evidence/opensandbox-live-2026-10-03/README.md)
reports HTTPS health/401 checks and one actual worker create/start, followed by
SDK readiness timeout before command or pause. Cleanup was independently checked;
the retrospective total live window was 265.819 seconds. No model call occurred.
Complete lifecycle, frozen reads, fencing and production authority remain unproven.
That record remains unchanged. The later fixed tooling snapshot `036e64a` is now
included after independent review; importing its code does not authorize another
allocation or change the failed live-trial outcome.

The default worker still needs explicitly configured trusted capabilities. The
separate deployment-bootstrap owner retains that implementation. No credentials,
model execution, security relaxation or main merge is part of this candidate.

## PR26 review history and correction

At intermediate head `4be3720`, PR26
`9b6789fcf746e25bd0bc98476ba75cb58975dd40` was deliberately not integrated.
Independent authored-runtime tests passed 44/44, but an additional EOF-delay probe
showed execute accepting output after stop/collect/destroy had verified completion.
The [owner handoff](https://github.com/leixy2004/FlyReWheel/pull/26#issuecomment-5974726590)
contains the reproducer and requests a final active-state check. This is an adapter
boundary finding; no actual dispatcher persistence or real-model effect is proven.
The subsequently corrected `6a1a8ac` independently passed 53 tests/typecheck and
the original external EOF scenario now rejects output after verified destruction.
The [follow-up review](https://github.com/leixy2004/FlyReWheel/pull/26#issuecomment-5974808952)
closes that P2; the corrected snapshot is included here. These checks are authored
protocol/local Git verification, not deployed authority. The pre-PR26 local checkpoint `ea094e4a64e792ece0738d2f568fe45143e112b9`
passed typecheck/build and 30 targeted tests across six files. These are authored
fixtures/local PGlite and local Git checks, not real PostgreSQL or model execution.

## Evaluation provenance and remaining execution gap

PR27 independently passed three focused tests and ten saved-artifact hash checks.
The 3-request / 8-binding / 6-context ledger preserves unknown eligibility and null
effect estimates. W1/W2 are still only the frozen 13/19 metadata rows. Unassigned
private annotation drafts were not published and are not human labels. Six actual
export inspections were saved by the data environment; this integration did not
repeat them. The resolver probe intentionally exercises early rejection with a
dummy job digest, not positive authorization or an end-to-end job.

The concrete PR26 resolver supports ordinary prepared workspaces, explicitly not
evaluation exports. PR28 now adds a separate explicitly selected offline-study
evaluation-aware resolver; 27 related authored/local Git tests and typecheck passed
independently, and the external late-EOF probe still rejects. The later data
snapshot `2cb82ef` records six real W0 positive resolutions with complete bindings.
Those used diagnostic job digests; they did not persist/enqueue/execute mining jobs
and are distinct from the local authored fixtures. An actual configured worker entrypoint remains separately owned work.
The default worker still does not call
`startConfiguredWorkerService`; runtime lifecycle authority is not proven. The
[offline CLI chain](offline-reproducibility.md) executes available preparation and
inspection honestly, and stops at those missing dependencies.

After merging both corrected inputs, source checkpoint
`3457f279a65c7da694974718c875f332e4d22360` passed typecheck/build and 56 targeted
tests across five files in 6.19 seconds. The subsequent changes only reconcile
this record and the paper map. Full hosted validation of the later published head
must be recorded separately; focused passes do not replace it.

## Frozen intermediate full-suite result

PR24 head `4be3720f55dc3ac054f7b701ae6ff681fded68a6` completed
[hosted run 37163076893](https://github.com/leixy2004/FlyReWheel/actions/runs/37163076893)
successfully: typecheck/build and **109 files / 1762 tests**, test duration
1117.16 seconds. The log's actual checkout is synthetic merge
`fe625ec618294484bc702617dd56dd20daec14bd`, parents main `e79954c` and
`4be3720`; its tree `c7e74132c472f5e299329e841d6cef7c15936bef` exactly equals
the tested head tree. Saved full-log SHA256:
`7429769049c133515358c9d56c734279341cf0cd7aac34bba1ca894e6cfd77a0`.

The earlier `37d31a2` run 37162283942 was cancelled by the subsequent push, not a
pass. The 1762-pass checkpoint predates PR26/27/28 and the executable CLI guide;
none of those later changes inherit that full-suite result. The next published
head requires its own aggregate run. Hosted tests are authored fixtures/local
PGlite/local Git checks, not a fresh real PostgreSQL/model/deployment experiment.

## Later CLI, data and runtime follow-ups

PR29's module is registered in the shared CLI by `0299179` (two registration lines
and a real subprocess authorization regression). Typecheck/build and eight targeted
checks passed. Independent actual compiled-CLI verification used an authored local
Git export, preserved complete selection/evaluation binding and rejected an existing
output without changing bytes. The six real W0 resolver checks in `2cb82ef` are a
separate data-environment diagnostic; combining these records does not establish an
actual W0 CLI-to-model or native-study run. Native evaluation-aware request/study/checkpoint bridging was still pending at
that earlier checkpoint; the next section records its subsequent integration.

The runtime `036e64a` review ran 25 pure Python mock/archive tests and 14 authored
TypeScript guard tests. Three control-plane Python cases requiring a real local
socket, an inert subprocess supervisor or upstream schema dependencies were excluded
from that independent subset. No new Docker/service/model trial ran. The merge kept
the earlier realpath entrypoint fix and its six CLI regression cases. The old plan
checker preserves historical `resolve_internal=false`; current trial configuration
uses `true`. The deployment README and checker header now explicitly distinguish
them, without altering runtime routing or the historical proposal.

After these integrations, source checkpoint `12e7618` plus the documentation/header
clarification passed typecheck/build and 40 targeted tests across seven files
(4.25 seconds). These include authored/local Git and local loopback fixture checks,
not actual deployment. Each later aggregate still requires its own full CI result.

## Second frozen aggregate full-suite result

PR24 `b3cb77a70ddc406eba2d521eda68a43016ab5100` passed hosted
[run 37164190621](https://github.com/leixy2004/FlyReWheel/actions/runs/37164190621):
typecheck/build and **114 files / 1803 tests**, 1211.95 seconds. Logged checkout
`86655ad150c108710742fe7e5e518d6d2d23ee61` has parents main `e79954c` and
`b3cb77a`, with tree `c16b48d2ff89807d672c8f8dd53c415687115549` identical to
the head tree. Full-log SHA256:
`49059718d6c687951b0f5250358537ee0b079c2fa05b0c359f3963cc85be666c`.
This predates the later runtime/data/CLI/deployment/protocol follow-ups above.

## Deployment entrypoint regression and annotation scope

PR30 independently passed 12 structural contract checks; two actual-renderer
cases were skipped for missing kubectl/Kustomize. Main independently reproduced a
new file-symlink entrypoint bug: invalid input silently exited 0 instead of executing
validation. The regression first recorded one failure/two passes. Fix `066c69a`
canonicalizes both launch/module paths and preserves import-only safety; combined
checks then passed 15 with the same two explicit renderer skips, independently
confirmed. No cluster/API schema/admission/deployment result follows from these
project-contract checks; official-tool rendering is separately assigned work.

The staged annotation proposal at `ea1d5e8` passed all 17 saved-artifact hashes.
Its W0 2.75 / conditional W1 18 / optional W2 descriptive 26 person-hour figures
are assumptions with stage gates and excluded costs, not assigned people or actual
labels. The largest formal plan's initial 152 hours is not a prerequisite for the
three-W0 feasibility pilot. Confirmatory sizing needs observed uncertainty and
dependence; fixed-head issue detection remains distinct from H−U/H−M future-case
comparisons. See the aligned paper map for the separate estimands and missing real
rules/rubrics, controlled access, human resources and execution authorization.

## Frozen functional candidate: native evaluation bridge

PR31 `498e704dd91c76dd846fb64183df3ed20b887ec0` is the final functional
input for this candidate. Independent review passed 99 tests across five files,
typecheck and build, with no P0/P1/P2 finding. The bridge carries complete binding
through requests, study identity, checkpoint and reopen while preserving legacy
identities when evaluation context is absent.

At integrated source `b71ac155592fe4992137f789957db8e8ef55007e`, seven actual
default-CLI commands passed: authored initialization/run/new-process reopen, W0
initialization/run/new-process reopen, and compiled-entrypoint rejection. Authored
results were byte-identical across processes; independent regressions verify no
repeat SDK dispatch. The W0 result retained all six bindings and four explicit
semantic blockers; no local registry was supplied, so workspace verification was
`not_run-no-local-registry`. The compiled bridge requires source checkout plus tsx.
Command-log SHA256: `623122bd12792e076a61a8c93bd329433a87527720de4fbf7b2884af1b8b096f`.
These are authored Git/PGlite/simulated SDK and frozen W0 metadata checks, with
zero model calls, zero human labels and no runtime allocation or deployment.

The separate data-environment result at PR27 `1565fade76e4fe640bcfc810415e491d7ac6e13b`
is queued external evidence, not merged into this candidate. Later optional evidence
will not move the frozen functional head. The candidate's own full CI remains required.
