# Methods mapped to executable artifacts

This map audits source baseline `37d31a2e2ab360fbb99ef3a81b5e51b30e152ffa`
(PR #21/#22 integration) and separately reads PR #23 at frozen commit
`ce9b9fbfc3abf5d1d542652e0b19ca01fca8e4fc`. The latter was inspected with
`git show`, not executed or silently treated as part of the baseline. The later
PR #25 follow-up is separately pinned to `a7adb0ee4c86fd6e72f5a1327ff2ac0e0a8ec760`.
This mapping
adds no observations, labels, acquisitions or model calls and makes no aggregate
verification claim for its own tree.

The current empirical ledger is **0 completed real-model calls, 0 independent
human labels, and unknown W0 semantic eligibility**. PR #25 supplies one bounded
real Ruff before/after tool pair; documentation and external-action behavior
remain unknown. Model-capable CLI
initialization attempts are not completed inference. Three real source packages,
six complete committed-tree exports and an authored CLI closed loop establish
source availability or application mechanics; none supplies a research outcome.

## Hypotheses, comparators and entry points

| Research item | Current executable boundary | Inspectable artifact or missing result |
| --- | --- | --- |
| H1: conditional review knowledge transfers to independent future instances | The offline paired evaluator accepts frozen reviews and a separate annotation manifest: `node dist/cli.js evaluation score --dataset DATASET --annotations ANNOTATIONS --runs RUNS --out NEW_REPORT` | [Paired-evaluation contract](../docs/paired-review-evaluation.md). No independently annotated W2 roster or real-model output exists; H1 remains untested. |
| H2: hard restriction H improves the false-alarm/recall tradeoff relative to U under the same diagnosis | `npm run experiment:matched -- --fixture NEW_DIRECTORY` exercises the [matched runner](../experiments/matched-revision/README.md), common gate and entire future roster | `packet.json`, `future.json`, `report.json` are authored demonstration outputs, not W0/W1/W2 data. The demonstration uses identical U/H proposals and scripted predictions, so it does not manufacture an H win. |
| H versus competent memory M; frozen F reference | `runMatchedRevision` in [runner.ts](../experiments/matched-revision/runner.ts) renders the fixed rule for F, unrestricted structured state for U, constrained state for H, and scoped lesson/delta for M | M's replace/qualify/suppress interface is implemented, but competence of a real memory reviewer is unmeasured. Same gate and evidence do not prove actual live-model equivalence. |
| Provided O versus shared inferred I diagnosis | The [SDK-native diagnosis and study interfaces](../experiments/matched-revision/sdk-native-contracts.md) separate provided/inferred conditions and repeated-block scheduling | `runSdkNativeStudy` in [sdk-native-study.ts](../experiments/matched-revision/sdk-native-study.ts) is an import API with authored transport verification, not an empirical CLI launcher. A schedule seed randomizes assignment/order, not model generation. |
| Durable execution of the repeated-block protocol | The separate [real PostgreSQL record](../docs/real-postgres-verification.md) tests crash/reopen and block reuse with authored SDK outputs | [Server evidence](../docs/evidence/real-postgres-2026-10-03.json) establishes its stated infrastructure assertions only. It cannot count as independent study repetitions or semantic quality. |

The [selected study](discriminating-experiment.md) requires frozen W0 rules,
independently verified W1 feedback and independent later W2 cases. It does not
require discovering a naturally complete historical rule-update chain. It does
require truthful experimental provenance. The vLLM development cases and related
lineages remain excluded; same-PR before/after pairs are not future instances.

## PR #27 proposal: a distinct fixed-head evaluation scope

The [annotation/temporal proposal at frozen PR #27 `1f5c680`](https://github.com/leixy2004/FlyReWheel/blob/1f5c68025b124f50bf683ab5cef0c85886a855a5/experiments/temporal-pilot/w0-first-three/evaluation-preparation/ANNOTATION-TEMPORAL-PROTOCOL.md)
was read separately during this update at integration head
`d0aa35b134a392a5c79eeb8ca3cdfbe710e19219`. It is a retrospective design written
after W0 inspection, not preregistration, collected labels or an execution result.
Its proposed primary study must not silently replace the selected matched
restriction experiment above:

| Scope | Task / estimand | What must not be conflated |
| --- | --- | --- |
| Selected H2 restriction study | H−U and H−M future-case contrasts under shared diagnosis, evidence and gate; positive recall, legal-neighbor false alarms and resolution | The four-arm authored runner does not instantiate or validate PR #27's independent issue roster or frozen baseline. |
| PR #27 fixed proposed-head study | Paired difference in detection proportions over independently enumerated known-positive issues in eligible W2 PR × family units, using the existing exact-anchor matcher | A repaired merge-base issue absent from the proposed head is not head-positive. Deleted-only targets are excluded; surviving in-scope pre-existing violations may count, with origin unknown unless supported. |
| Current three-PR W0 feasibility pilot | Availability, packet/input integrity and preparation for PRs 3035/3031/3036 | Six before/after exports are three exposed development PRs, not six independent samples or independent future instances. Existing before-only drafts are calibration artifacts, not formal head-review examples. |

PR #27 proposes a census of the 19 W2 frame candidates and at most eight real
families, while retaining the 70-row frame flow and every excluded, unknown,
unassessed, failed and not-run unit. This is a proposed later evaluation scope,
not acquired W2 data. Family/rubric, baseline and matching rules must be frozen
before W2 access; an independent issue roster is then discovered from authorized
source inspection and locked before arm outputs. A real execution would need a
versioned decision selecting this scope or explicitly relating it to H2; no merged
estimand, shared success criterion or automatic protocol replacement is asserted.

The proposed maximum initial-rating estimate is
`19 PRs × 8 families × 2 raters × 30 minutes = 152 person-hours`, excluding
calibration/adjudication. It is not measured work, assigned capacity, or a minimum
entry requirement for the small three-W0 feasibility pilot. No people or time
resources are assigned. The small pilot can continue authorized preparation and
feasibility checks without pretending the largest annotation plan is staffed;
actual annotation still requires real rubrics, qualified independent humans and
controlled access. A revised formal budget must be frozen before W2, not after
viewing outcomes.

The [v0.2 staged-budget amendment, PR #27 `ea1d5e8`](https://github.com/leixy2004/FlyReWheel/blob/ea1d5e80a0e0f4bf1ef198012309defe87b27d5c/experiments/temporal-pilot/w0-first-three/evaluation-preparation/ANNOTATION-TEMPORAL-PROTOCOL.md) makes
smaller conditional work packages explicit without changing the frame or estimand:

| Proposed stage | Rating + adjudication + administration | Gate and scope |
| --- | --- | --- |
| A: 3 exposed W0 × 1 family × 2 raters × 15 minutes | 1.5 + 0.75 + 0.5 = **2.75 person-hours** | Real rubric/family, independent personnel and approved access first; calibration only, not holdout labels. |
| B: all 13 W1 × 1 family × 2 raters × 30 minutes | 13 + 3.25 + 1.75 = **18 person-hours** | Only after A's feasibility gate and separate acquisition/access authorization; development pilot, not current W1 release. |
| Optional descriptive W2: all 19 × 1 family × 2 raters × 30 minutes | 19 + 4.75 + 2.25 = **26 person-hours** | Only after earlier gates and frozen formal task settings; bounded descriptive holdout, not powered confirmation. |

All figures are proposal assumptions/caps, not completed annotations, measured
productivity or assigned resources. The conditional sum is 46.75 hours; stopping
after A caps this annotation/administration stage at 2.75. Substantive rule design,
acquisition, access/security implementation, contamination auditing and model costs
require separately visible budgets. The older 152-hour maximum covers initial
rating only; with proposed reserves the eight-family option totals 208 hours.
Neither maximum is the entry condition for A. No raters, labels, sampling changes
or new collection are created by adopting this map.

A needs a defensible family, at least two of three complete independent exercise
submissions and resolved blocking rubric ambiguities within its cap. Unknown can
be valid completed work but is not a positive signal. Zero observed positives does
not justify replacing samples; no demonstrated family means stop, and a proposed
W1 pilot without observed positives needs an explicit substantive rationale.
Later confirmatory sizing requires observed uncertainty, disagreement, coverage,
positive yield and PR/lineage dependence plus a prespecified worthwhile benefit.
Illustrative worst-case cluster counts in v0.2 are not adopted sample sizes or
confidence intervals for this deterministic frame. Without defensible precision,
keep W2 descriptive or stop. This staged spending proposal does not replace the
H−U/H−M estimand with the fixed-head study or create independent replication from
anchors, exports, repeated model runs or raters.

PR #27's primary visibility is **current-capture**: verified frozen static pairs,
explicit scope and contamination accounting, without a historical-review claim.
Missing historical public-availability evidence blocks only its optional as-of
subanalysis, not this correctly labeled primary design. Current-capture does not
waive lineage, source integrity or output-exposure gates. Exact Git objects and
merge dates never establish an as-of checkpoint; checkpoint/cutoff fields remain
null unless independently evidenced. The historical extension would additionally
need a contemporaneous archived event tying the exact visible head/base and all
included evidence to its declared review time.

Its primary issue-detection metric deduplicates issues with frozen identities and
exact anchors; finding-level useful-alert precision is a different quantity.
Missing positives make detection undefined; incomplete issue search limits the
claim to known issues. Unknown/disputed labels remain visible outside known-label
denominators, and failed/not-run arms miss established positives. All-alert
precision bounds require an exhaustive useful/non-useful/unresolved finding
partition; the current `uniqueAlerts` counter is not semantic issue deduplication.
PR-clustered descriptive comparisons, calibration/recognition records and independent
adjudication are proposed procedures, not outputs supplied by a schema or CLI demo.

Current substantive gaps are real reusable families/rubrics, independent raters and
adjudicator with confirmed resources, an annotation interface and access assignment,
and authorized acquisition/model budgets plus usable execution capabilities.
No label, synthetic human identity, packet sharing, W1/W2 access or new model call
is created by this mapping. See the frozen proposal for its precise annotation,
unknown, contamination and optional historical rules.

## Temporal cutoffs and source artifacts

| Stage | Fixed cutoff / denominator | Command and retained artifact | Present boundary |
| --- | --- | --- | --- |
| Complete metadata frame | GitHub `mergedAt`, UTC: W0 `[2024-01-01, 2024-04-01)`, W1 `[2024-04-01, 2024-07-01)`, W2 `[2024-07-01, 2024-10-01)`; 38/13/19, total 70 | Offline `node scripts/validate-temporal-frame.mjs`; [frame](../experiments/temporal-pilot/httpx-2024-frame.json), [validator contract](../docs/temporal-frame-validation.md) | Equality with the recorded API total is not an independent census. The original pre-acquisition-freeze flag is an author declaration, not external preregistration. W1/W2 membership is known as metadata; their source/labels are not study inputs. |
| W0 commit identities | All 38 W0 entries; same frozen selection | [Identity lookup artifact](../experiments/temporal-pilot/source-identity-verification.json) | Exact OID/tree/parent lookup consistency, not historical public availability or semantic eligibility. Its acquisition script is not an offline verifier and was not rerun here. |
| Initial bounded source tranche | First three chronological W0 PRs 3035, 3031, 3036; preserve order, failures and zero yield | [Plan and attempt history](../experiments/temporal-pilot/w0-first-three/README.md), [package audit](../experiments/temporal-pilot/w0-first-three/proxy-attempt-1/offline-validation.json) | Earlier capture failed with zero packets; later fixed attempt produced three real packages, cumulative 48/50 GETs. Three captured PRs are not three independently labeled maintenance episodes. |
| Offline mining preparation | Same three PRs, no W1/W2 material | `node --import tsx scripts/prepare-w0-mining.ts --db NEW_LOCAL_DB --out NEW_OUTPUT`; [ledger](../experiments/temporal-pilot/w0-first-three/mining-preparation/ledger.json) | 3 evidence objects, 3 requests, 8 unknown cases, 0 candidates/rules/feedback. Authorship timestamps are not evidence-availability cutoffs; templates with unresolved model/configuration are not executed jobs. |
| Complete repository context | Six exact source SHAs for before/after roles, with allowed-head export restrictions | [Result](../experiments/temporal-pilot/w0-first-three/full-context/result.json), [independent audit](../experiments/temporal-pilot/w0-first-three/full-context/independent-audit.json) | Six exports contain 114 committed files each; source access is not full-repository reasoning or a behavioral oracle. Derived probe repositories were removed; execution needs reviewed rederivation, not assumed live paths. |

`capture-temporal-frame`, `verify-temporal-source-identities`, source collectors
and `materialize-w0-context` perform external acquisition. Their existence is not
permission to rerun them as validation. This mapping only reads saved metadata
and W0 stage summaries. No W1/W2 content is opened. Merge/commit dates, capture
and edit times, public availability, construction freezes and annotation exposure
remain different clocks. The selected metadata interval alone establishes none
of the other clocks or independence between problem lineages.

## PR #23: preserve the negative behavior evidence

At exact commit `ce9b9fbfc3abf5d1d542652e0b19ca01fca8e4fc`, the
[behavior README](https://github.com/leixy2004/FlyReWheel/blob/ce9b9fbfc3abf5d1d542652e0b19ca01fca8e4fc/experiments/temporal-pilot/w0-first-three/behavior-validation/README.md)
and
[ledger](https://github.com/leixy2004/FlyReWheel/blob/ce9b9fbfc3abf5d1d542652e0b19ca01fca8e4fc/experiments/temporal-pilot/w0-first-three/behavior-validation/ledger.json)
record **zero effective paired behavior results**:

- PR 3035: the frozen wheel selector could not obtain `mkautodoc==0.2.0`; no docs build ran on either side.
- PR 3031: the corrected staging attempt reached Ruff launch but received `PermissionError 13` before Ruff execution. The after version was not executed. This is not a demonstrated noexec cause, tool incompatibility, defect or passing lint result.
- PR 3036: fixed workflow syntax and setup-python v4/v5 references validate; external action implementation behavior remains untested.

The retained original failure, declared staging-readability correction and second
failure are separate attempts. They must not be collapsed into successful tool
validation. Eight case expectations remain unknown; no samples were replaced.
The PR #23 offline command
`node --import tsx scripts/check-w0-behavior-inputs.ts NEW_OUTPUT.json` rederives
input templates and workflow references only. It does not run upstream behavior,
assign labels or turn infrastructure failure into a scientific zero effect.
This command belongs to the pinned PR #23 tree until that tree is integrated.

## PR #25: subsequent bounded Ruff success, without relabeling PR #23

The later [permission diagnosis and recheck](https://github.com/leixy2004/FlyReWheel/blob/a7adb0ee4c86fd6e72f5a1327ff2ac0e0a8ec760/experiments/temporal-pilot/w0-first-three/permission-diagnosis/README.md)
and [ledger](https://github.com/leixy2004/FlyReWheel/blob/a7adb0ee4c86fd6e72f5a1327ff2ac0e0a8ec760/experiments/temporal-pilot/w0-first-three/permission-diagnosis/ledger.json)
add one paired tool-behavior result for PR 3031. Ruff **0.1.6 before / 0.1.9 after**
each returned exit 0 for `ruff format httpx tests --diff` and
`ruff check httpx tests`. Each formatting check covered 60 files; 114 source files
were reported hash-checked before and after each side and unchanged. The saved
records omit the per-file manifest, and the retry script does not revalidate the
export Git identity. Independent integration review can verify the saved hashes
and identity fields but cannot reconstruct all 114 file-to-tree bindings from
this PR alone. This is
actual tool execution with fixed inputs, not model inference, a defect-repair
label, mining yield, or general CI compatibility.

A controlled reproduction observed `/tmp` mounted `noexec`, correct binary bytes
and mode, traversable parents and an accessible interpreter, supporting the
permission-failure explanation. It is not retroactive inspection of the removed
PR #23 container. Verified wheel binaries were copied into `/opt/ruff/before` and
`/opt/ruff/after` in a fixed derived image; `/tmp` remained noexec and the runtime
isolation settings were retained. The scripts and immutable image/command records
are finite-stage reproducers, not permission to retry or weaken isolation. This
mapping inspected them at the pinned SHA and did not run containers.

The separate mkautodoc 0.2.0 investigation found one 4,827-byte sdist and no wheel.
It inspected the hash-verified archive in memory only. Neither setup.py nor a
build/install was executed; backend and transitive dependencies remain unfrozen.
PR 3035 docs behavior is still unknown. PR 3036 retains only workflow syntax/ref
checks; external action behavior is unknown. Human labels and model calls remain
zero. PR #23's zero paired results remain its historical outcome; PR #25's one
bounded successful pair is the later availability result, not a rewritten old run.

## Subsequent evaluation provenance

PR #27 at `d778aba7c1abcd029bb90ce94d7f6f4e9f583cd8` adds a
[provenance and annotation-preparation audit](../experiments/temporal-pilot/w0-first-three/evaluation-preparation/PAPER-DATA-AUDIT.md):
three requests, eight source bindings and six contexts. Eligibility remains
unknown and effect metrics null. W1/W2 remain metadata only; private unassigned
drafts are not published annotations. The saved resolver probe shows the ordinary
resolver rejecting evaluation identities, not a successful authorized model job.
Subsequent PR #28 `ba319f64eafc06b816975ee159c510a8404e0644` supplies a
[separate evaluation-aware registry resolver](../docs/prepared-evaluation-workspace-resolver.md)
that preserves the full binding and re-verifies the exported workspace. Its
authored/local Git tests do not establish deployed authority or model execution.
The follow-up data snapshot `2cb82ef` records six real W0 export resolutions with
complete evaluation binding; diagnostic job digests make this a resolver contract
check, not persisted application or native-study execution. PR29 and CLI registration
`0299179` expose `evaluation workspace resolve`; an actual compiled-CLI authored Git
positive also preserves the full binding and refuses overwrite. These distinct
records do not jointly imply a real W0 model run.

## Product execution is a separate gate

The [offline reproducibility chain](../docs/offline-reproducibility.md) was
actually run with the compiled CLI at `4be3720`. It prepares the three frozen W0
inputs, exports jobs and inspects their blocked preflight/not-started state; a
separate authored evaluator example generates its own inputs before scoring.
It stops before the missing real execution and research gates.

[Application operations](../docs/application-operations.md) exposes
`application-jobs prepare-mining`, `preflight`, `bootstrap-check` and `recovery`.
Preparation exports a normalized job and persists its request, not a queued or
completed mining result. Preflight reports missing dependencies without invoking
a model/runtime. The PR #22 factory composes injected trusted capabilities; it
does not install them in the default executable. Default worker processing
remains `blocked/runtime_unavailable`. The deployment bootstrap belongs to its
separate implementation owner and is not assumed complete by this map.

`closed-loop demo --out-dir NEW_OUTPUT --db NEW_LOCAL_DB` demonstrates authored
mining/review/feedback/revision and persistence through the product interfaces.
Its fixture accept/reject, unknown human verdicts and zero activation cannot
substitute for operating the real W0 jobs. Neither a help screen, valid template,
queue completion nor a `context-ready` artifact is a mined rule or a model turn.

## Metrics mapped to code and missing denominators

| Planned quantity | Executable calculation | Required interpretation |
| --- | --- | --- |
| Future positive recall / effective miss rate | `scoreFuture` in [scoring.ts](../experiments/matched-revision/scoring.ts): supported detections / all labeled positives; missing, unresolved or excluded positives remain misses | Zero positive denominator gives `not_estimable`, not 0 recall. Current labels are authored fixtures only. |
| Legal-neighbor false alarms / strict resolution | Same scorer counts violation predictions on legal neighbors; strict resolution requires supported safe/not-applicable judgments | Silence is not successful resolution. Known-negative denominator must come from independent annotation. |
| Safe-applicable resolution, repeated-feedback false alarms | Separate safe-applicable and repeated-mechanism subsets in `scoreFuture` | Generic safe labels cannot replace the required subsets; no real such subsets currently exist. |
| Coverage, scope loss, unknown labels | Scheduled roster, supported determinate outputs, scope-excluded reasons, and unresolved reference rows remain in the report | Unknown/disputed reference labels are not negatives. Current scorer explicitly does not compute uncertainty bounds without frozen feasible-label constraints. |
| H−U and H−M comparisons | Matched runner emits paired descriptive differences on the same scheduled targets | Synthetic differences are functional assertions. No confidence interval, powered effect estimate or empirical advantage is supplied. |
| Issue-level TP/FP/FN and output matching | [Paired evaluator](../docs/paired-review-evaluation.md) uses exact issue anchors and PR × family roster bindings | Its descriptive metric denominator differs from the selected matched-case legal-neighbor protocol; do not interchange the two reports. |
| Cost and failure burden | SDK-native records retain byte/time/call counts, raw nullable token fields, failures and monetary-admission declarations | Authored calls are not provider calls. Unknown spend is null, not zero; no measured real-model cost or cost-dominance result exists. |
| Feasibility yield | Full 70-PR frame, 38 W0 entries, selected 3-PR tranche, 8 unknown source cases, zero rules, PR #23 zero paired behavior tests and PR #25 one bounded Ruff pair are distinct denominators | Availability failure is not zero mining efficacy. Keep unattempted, blocked, unknown, zero-yield and adjudicated samples separate. |

## Verification provenance and next evidence gate

The historical `3fdb63bb767622c9177a3f4d6283126496154277` full run retains
1571 passing / 2 failing tests and exit 1; focused passes did not erase it.
`0471c0b2e69c187c7907a9d1ade396b310cb6f3d` has its separately recorded local
and hosted 1658-pass checkpoint. The coordinator records hosted 1734 passes for
`0b476d9f6835fec63b3b924c0de3120d3c79922f`; that hosted status was not queried
again in this offline audit. These belong to their exact heads, not to
`37d31a2`, PR #23, PR #25, this document change or a later integration. See the historical
[integration record](../docs/integration-candidate-2026-10-03.md) and
[W0 integration record](../docs/integration-w0-candidate-2026-10-03.md).

The later intermediate PR24 head `4be3720` has a separately recorded hosted
109-file / 1762-test pass and an identical synthetic-merge tree in the
[context integration record](../docs/integration-context-composition-2026-10-03.md).
That result predates the PR26/27/28 additions and does not validate them.

Before claiming any empirical contrast, supply the missing trusted runtime/model
and spending configuration, freeze the W0 rule artifacts, assign independent
humans/adjudicator, audit lineage and the chosen visibility scope (historical proof only for as-of claims),
and release W1/W2 stages only
under their agreed exposure gates. Freeze matched settings, baseline behavior,
rosters, budgets and analysis before inspecting policy outcomes. These are
unmet requirements, not a claim that a study has been preregistered or run.
