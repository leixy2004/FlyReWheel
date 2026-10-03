# FlyReWheel claim and evidence checklist

Audit date: 2026-10-02. The original audit inspected `e0e6c380d710434f4d0541b1a238784045130db8`; subsequent sections cover the diagnosis-operator extension on `000c50d670ac2bbd007eca2bdecde0bf53093c84` and the mixed-anchor working-tree extension on `92b375e62f141127214188a70b9024eec5ae7c27`, each with a separate verification record. This checklist accompanies [the methods draft](method-draft.md). A checked item means the stated narrow implementation claim has supporting source and recorded verification. It does not indicate semantic efficacy. Each run retains its own scope; older test counts do not verify newer behavior. All operator and mixed-anchor verification uses authored fixtures, with no live model experiment.

## Executable artifact mapping

The [current methods-to-artifacts map](executable-artifact-map.md) binds hypotheses,
baselines, temporal cutoffs and metric denominators to their actual commands and
saved evidence at `37d31a2`, with PR #23 separately pinned to `ce9b9fb` and its
PR #25 follow-up pinned to `a7adb0e`. It preserves the original negative attempts
and distinguishes the later successful Ruff before/after lint/format pair from
research effectiveness. Real-model calls and independent human labels remain zero;
W0 semantic eligibility, docs behavior and external-action behavior remain unknown. Source capture, full committed
repository context, authored demos and old CI passes do not establish an empirical
result or validate a newer tree.

## Real PostgreSQL infrastructure evidence: 2026-10-03

The [server-backed record](../docs/real-postgres-verification.md) and
[raw-result archive](../docs/evidence/real-postgres-2026-10-03.json) extend storage
and recovery evidence at baseline `237056acaaa3c21684fd63772eaca119e2af5f3a`.

- [x] **Actual PostgreSQL migrations and coordination.** PostgreSQL 17.11 applied 15 migrations with four concurrent pools; application and study claims each had one winner among four claimants, and stale owners were rejected.
- [x] **Bounded recovery and upgrade checks.** An actual pg-boss claimant process was killed and the job completed on retry; database KILL/start preserved asserted records and queue deduplication. A separate 014→015 upgrade rolled back deliberately failing SQL, retained history/data, and applied only 015 on corrected retry.
- [x] **Compiled worker-service process lifecycle.** Localhost health/readiness returned 200, an offline replay produced six observations and zero errors, and SIGTERM exited zero. The application runtime was blocked and model execution was not run.
- [ ] **Production isolation or deployment.** A temporary PostgreSQL container is not evidence of an OpenSandbox lifecycle authority, gateway isolation, S3 or k3s deployment, or production database role separation.
- [ ] **Scientific effectiveness.** These authored infrastructure scenarios do not evaluate diagnosis quality, future-review improvement, or the selected three-window study. Independent labels, frozen study inputs, matched models/evidence/budgets and actual outcomes are still required. Current working-tree aggregate tests are pending.

## Supported implementation statements

- [x] **Conditional semantic rules are represented independently of a mandatory detector.** The v2 schema stores mechanism, invariant, applicability, exceptions, context, scope, optional assets, provenance, regression roles, and an exact parent digest. Conditions are prose, not executable logic. [Schema](../src/core/semantic-rule.ts); [tests](../tests/semantic-rules.test.ts); [contract](../docs/semantic-rules.md)
- [x] **Rule versions and selected evidence are immutable and content-bound.** Mining rederives exact selected source/discussion bindings; locally imported cases remain unknown. Authored metadata does not authenticate people or historical visibility. [Mining contract](../docs/pr-mining.md); [mining tests](../tests/pr-mining.test.ts)
- [x] **Mining has supplied, authored-test, and supervised workspace interfaces.** Full-repository context can be requested through the workspace route, but the recorded successful executions are authored fixtures. [Adapter](../src/adapters/pr-mining-model.ts); [workspace tests](../tests/pr-mining-workspace-model.test.ts); [recorded verification](../docs/evidence/pr-mining-execution-verification-2026-10-02.txt)
- [x] **Supervised semantic review validates exact target and evidence bindings.** The historical API verification covers head/local snapshot checks, typed results and missing-context gates. Accepted anchors and coverage remain captured changed entries. Independent per-anchor behavior has its own checklist below. [Review boundary](../docs/semantic-review-model-boundary.md); [historical verification](../docs/evidence/semantic-review-workspace-verification-2026-10-02.txt)
- [x] **Feedback refers to exact versions and finding anchors.** Fixture or locally declared human sources remain distinct; an FP anchor is not a safe-file label, and note/resolve/merge is not ground truth. [Feedback schema](../src/core/semantic-review.ts); [local review contract](../docs/semantic-reviews.md)
- [x] **Revision generation freezes inputs and proposes explicit diagnoses.** Every selected feedback record requires one diagnosis and its own citation. Later feedback and comparison/evaluation outputs are excluded. Diagnoses remain proposals. [Schema](../src/core/revision-model.ts); [input and response validation](../src/revision-generation.ts); [tests](../tests/revision-generation.test.ts)
- [x] **A generated revision preserves base provenance and regression declarations.** Application code supplies protected identity/parent fields and retains cases and roles. This is record preservation, not observed behavioral preservation. [Candidate construction](../src/revision-generation.ts); [generation contract](../docs/rule-revision-generation.md)
- [x] **Historical v1 generation can return insufficient evidence without a candidate.** The recorded v1 workflow returned diagnoses/receipt without a rule candidate. New generation instead uses separately persisted `no_rule_change` outcomes under the policy below; the old run does not verify that extension. Invalid output and failed cleanup withhold acceptance. [Earlier recorded checks](../docs/evidence/revision-generation-verification-2026-10-02.txt); [generation contract](../docs/rule-revision-generation.md)
- [x] **Local source-use guards reject known holdout consumption and later byte aliases.** Preparation reserves consumed source identities; it does not establish historical or semantic independence. [Recorded generation checks](../docs/evidence/revision-generation-verification-2026-10-02.txt)
- [x] **Paired comparisons preserve exact selected cases and feedback.** Known observations yield preserved/corrected/regressed/still-failing; missing support is inconclusive. Historical `explicit-semantic-v2` verification covers detectorless target judgments with complete required context and declared scans. Current `per-anchor-semantic-v3` has separate checks below. [Comparator](../src/revision-comparison.ts); [comparison contract](../docs/local-revision-comparisons.md); [historical verification](../docs/evidence/detectorless-comparison-verification-2026-10-02.txt)
- [x] **Historical detectorless scoring distinguishes file cases from explicit feedback anchors.** Its `findingAnchors` path requires the exact selected snapshot/side/path/source/span and a validated known finding; citations or target-only safety do not establish anchor safety. That checkpoint still shared one target decision. New independent mixed-site decisions are covered separately below. [Historical verification](../docs/evidence/detectorless-comparison-verification-2026-10-02.txt)
- [x] **Local accept is gated and never activates a rule.** Only compatible comparisons can be accepted; decisions are explicit append-only declarations. They do not create an active version or certify correctness. [Decision schema](../src/core/revision-comparison.ts); [comparison verification](../docs/evidence/revision-comparison-verification-2026-10-01.txt)
- [x] **The local closed-loop fixture connects the stages and rejects a losing candidate.** Two selected feedback anchors produce the predefined preservation/correction and lost-positive outcomes; 28 records reopen and 33 artifacts are inventoried. All judgments and feedback are authored, with no model run or activation. [Recorded run](../docs/evidence/local-closed-loop-verification-2026-10-02.txt); [compiled report](../docs/evidence/local-closed-loop-compiled-2026-10-02.json)
- [x] **Prior source checkpoints have recorded suite and compiled checks.** The query-fix record and later detectorless-comparison record each state their own scope. They remain historical runs; the diagnosis-operator extension has its own record below. [Query checkpoint](../docs/evidence/github-pr-history-range-live-2026-10-02.json); [comparator checkpoint](../docs/evidence/detectorless-comparison-verification-2026-10-02.txt)

## Offline paired-evaluation structural verification

The separate [offline paired-evaluation harness](../docs/paired-review-evaluation.md) is verified by authored counting/binding tests and a [compiled CLI replay](../docs/evidence/compiled-paired-evaluation-smoke-2026-10-02.json), with commands and exact source hashes in its [verification record](../docs/evidence/paired-evaluation-verification-2026-10-02.txt). This is not an empirical evaluation dataset or result.

- [x] **Frozen outputs and separate annotation manifests have exact bindings.** Dataset, protocol, rubric, policy, model/version/configuration, information, total budget, rules and semantic reviews remain content-bound. Source/annotator/runtime attestation is not acquired by import
- [x] **Issue-level counts expose both gains and losses.** Exact anchors and a full PR × family roster prevent silent fuzzy matching, duplicate useful-instance inflation and overlap-only comparisons. Unknown, disputed, excluded and unmatched labels/predictions remain distinct; missed known positives include abstention and execution gaps
- [x] **Only declaration-matched descriptive deltas are emitted.** Missing units, mismatched model/information/budget declarations or known budget overruns withhold paired deltas. Receipt/manifest contradictions are rejected without treating imported receipts as authentic
- [ ] **The harness has evaluated efficacy on independently annotated future cases.** It has not. Its oracle and predicted outputs are deliberately co-authored synthetic fixtures; no live model call, real annotation, sampling estimate, confidence interval or significance test is reported

## Mixed-anchor structural verification

The extension uses review fixture `schemaVersion: 2`, worker contract `semantic-review-v2`, receipt marker `per-anchor-v3`, and comparison scorer `per-anchor-semantic-v3`. Its [verification record](../docs/evidence/mixed-anchor-review-verification-2026-10-02.txt) and [compiled mocked SDK → worker → store → comparison smoke](../docs/evidence/compiled-mixed-anchor-review-smoke-2026-10-02.json) are the evidence for this increment. The final record reports 722 passing tests across 48 files with two workers, plus typecheck, build, three compiled smokes and static deployment validation; no older pass count is attributed to this extension. Authored outputs can establish structural behavior only, without live model/backend or empirical benefit claims.

- [x] **Independent mixed-site judgments with exact validation.** Each `anchorJudgments` entry carries its own decision, reasoning, evidence references and context gaps, bound to the exact snapshot/side/path/source/span. A target may retain a violating anchor and a safe exception. Duplicate/conflicting anchors and contradictory safe targets fail. [Schema](../src/core/semantic-review-evidence.ts); [review contract](../docs/semantic-reviews.md)
- [x] **Context gates remain local and uncertainty survives.** Targets and anchors use only their own references and gaps. An unknown target may retain supported anchors, while missing evidence/context at another anchor stays unknown. Local decisions cannot promote unknown target coverage to whole-file safety. [Model boundary](../docs/semantic-review-model-boundary.md)
- [x] **Exact-feedback comparison is independent of target unknown.** The current scorer accepts new `anchorJudgments` or legacy explicit `findingAnchors`, with a validated known finding at the exact selected anchor. File cases still require target judgments; missing anchors, citations and detector absence cannot establish safety. Declared scans must complete and dropped positives remain in the union. [Comparison guide](../docs/local-revision-comparisons.md)
- [x] **Historical contracts remain immutable and readable.** Old fixture/schema-1 payloads, prompt/schema bytes, receipts and scorer outputs rederive under their original contracts. New acceptance requires a compatible current-scorer report; historical accepts remain readable without new certification. [Receipt boundary](../docs/semantic-review-model-boundary.md); [scorer compatibility](../docs/local-revision-comparisons.md#immutable-scorer-compatibility)

## Diagnosis-operator structural verification

The [operator verification record](../docs/evidence/revision-operators-verification-2026-10-02.txt) reports final frozen-source typecheck/build, 663 passing tests in 46 files with two workers, and a passing [compiled v2 smoke](../docs/evidence/compiled-revision-operators-smoke-2026-10-02.json). This evidence supports the asserted structural enforcement and persistence behavior, not diagnosis truth or empirical improvement.

- [x] **Versioned, enforced operator selection.** New `rule-revision-v2` generation declares `diagnosis-operators-v1`. Selected non-label/Unknown/Disputed feedback, conflicting TP/FP labels on one finding, mixed categories, or a `mixed`/`insufficient_evidence` diagnosis require abstention. Next, uniform context diagnoses allow `request_context` despite missing context; every other category with declared missing evidence abstains. Otherwise judgment retains, boundary permits a boundary update, and contract permits a replacement. Voluntary abstention is allowed. [Policy derivation and validation](../src/revision-generation.ts); [tests](../tests/revision-operators.test.ts)
- [x] **No-change outcomes are first-class records.** `retain_rule`, `request_context`, and `abstain` require `no_rule_change`, reasoning, a concrete next step, and diagnoses. A separate immutable table retains these and the receipt without creating a rule version or changing a finding. Neither repair nor context acquisition is executed. [Outcome schema](../src/core/revision-generation.ts); [storage tests](../tests/revision-no-mutation.storage.test.ts); [migration](../src/storage/migrations/010_revision_outcomes.sql)
- [x] **Boundary updates preserve protected fields exactly.** An actual applicability/exception/path edit is required; title, mechanism, invariant, required context, expected behavior, and detection assets stay exact. `replacement` must be null. This does not prove logical narrowing, minimality, or correctness. [Validator](../src/revision-generation.ts); [tests](../tests/revision-operators.test.ts)
- [x] **Contract replacements require an explicit, unverified transition declaration.** An actual edit accompanies the exact prior digest, distinct old/new contract texts, supplied base and every selected finding reference, and distinct old/new applicability declarations marked `proposed_requires_review` with activation not performed. These declarations are neither verified chronology nor executable retirement/routing. Source and regression declarations remain exact. [Response schema](../src/core/revision-model.ts); [tests](../tests/revision-operators.test.ts)
- [x] **Legacy records retain their original claim.** Historical v1 receipts/candidates use original schema and prompt rederivation, with schema-and-provenance-only validation. A pre-change authored v1 fixture rederives its original digest and reopens through the store. It does not acquire the v2 policy claim retroactively. [Record schemas](../src/core/revision-generation.ts); [tests](../tests/revision-operators.test.ts); [generation contract](../docs/rule-revision-generation.md)

## Real source acquisition and its limits

- [x] **October 1 captured PR #8568 through read-only provider calls.** The record reports two changed paths, three captured sides, 23 GETs, and unknown source correctness. It is a current, non-atomic capture, not the earlier review state. [Capture record](../docs/evidence/github-pr8568-capture-2026-10-01.json)
- [x] **The October 2 corrected range preview succeeded.** One unauthenticated GET returned HTTP 200 and selected #8568 in the bounded creation window. This verifies that query's observed behavior, not a complete frame or capture. [Range verification](../docs/evidence/github-pr-history-range-live-2026-10-02.json)
- [ ] **A fresh batch capture after the corrected preview succeeded.** It did not: the capture record reports one attempt/GET, HTTP 403, exit 2, zero accepted bytes and no fresh receipt. The classification is `forbidden-or-rate-limited`; the reason is unresolved. Reopening and zero-GET skipping of that failed item verify failure persistence, not completed-capture reuse. Do not call this a verified rate-limit incident or a successful batch. [Batch failure record](../docs/evidence/github-pr-history-batch-live-2026-10-02.json)
- [ ] **The current discovery is the Phase 0 sample frame.** It is a bounded current creation-time search, whereas the proposed protocol requires first-ready-for-review events, complete enumeration, declared inclusion probabilities, and cases regardless of later merge/comment outcome. [Discovery contract](../docs/github-pr-history.md); [Phase 0 protocol](phase0-protocol.md)
- [ ] **Real captured comments establish ground truth or actual rule revision.** They do not. No independent annotation or explicit old/new rule evidence has been established for the development capture. Counts of reviews or comments are not counts of validated feedback episodes

## Claims that must remain hypotheses or unfinished capabilities

- [ ] **A validated cause-aware update algorithm.** The working-tree policy now constrains operators from proposed diagnoses and selected evidence. Structural enforcement does not validate the diagnoses or establish that the chosen interventions improve future review; evaluate those separately
- [ ] **Minimal boundary refinement.** No edit objective, minimality checker, candidate search/ranking policy, or evidence of smallest sufficient revision has been validated
- [ ] **Executed judgment repair without rule weakening.** The new judgment route retains the rule or abstains, but only records a next step. It does not repair a finding or review procedure; that separate action and its effects remain unverified
- [ ] **Contract replacement and retirement with correct temporal routing.** The new operator requires reviewable old/new contract and applicability declarations. It does not verify the transition or execute retirement/routing; immutable parentage does not select the right version for a context/time
- [ ] **Full-repository revision reasoning.** Current revision uses selected-evidence-no-tools. Workspace lifecycle infrastructure must not be described as autonomous revision exploration. [Revision boundary](../docs/rule-revision-generation.md)
- [ ] **Repository-wide evidence support in semantic review.** Full-repository inspection is available at the API boundary, but admissible evidence and reported coverage remain changed entries. Unchanged-file evidence capture remains unfinished
- [ ] **Historically isolated evaluation.** `all-local-refs-v1` can expose future history. Frozen selected prompt bytes, exact-head checks, and source-split reservations are insufficient to establish as-of visibility. [Runner limits](../docs/codex-workspace-runner.md)
- [ ] **Live model quality, reliable isolation, or deployed service operation.** Authored SDK executors and trusted application receipts establish neither. Production backend/gateway/authentication behavior and independent containment remain unverified
- [ ] **Future semantic generalization, fewer repeated false alarms, or preserved recall.** No independent future evaluation with a defensible oracle and matched baselines has produced these results
- [ ] **Adequate experimental feedback and independent recurrence for H2.** The selected three-window route generates W0 rules, freezes them before W1 exposure, and human-verifies actual W1 findings as experimental feedback before W2 evaluation. Required yield and later positives/legal neighbors remain unknown. Naturally complete maintenance histories are optional separate-origin evidence, not a prerequisite; code-fix feedback alone still cannot demonstrate natural rule revision
- [ ] **Novelty or priority.** Existing related-work review shows substantial overlap. The structural selective-maintenance policy is now specified, but its diagnosis validity, intervention benefit, and scientific distinction remain to be demonstrated. No first-of-its-kind claim is warranted

## Selected study route and interpretation

At checkout `250a242`, the [discriminating protocol](discriminating-experiment.md) and [manuscript](manuscript-draft.md#6-evaluation-protocol) select a one-repository W0/W1/W2 generated-rule pilot. F/U/H/M share evidence, models, budgets and gate semantics; provided/oracle and inferred diagnoses are separate conditions. The protocol is not yet frozen or preregistered, no new cases/labels/model outputs exist, and all previously inspected vLLM cases remain development-only. All-PR selection/recurrence denominators, rule-before-feedback locks and independent later lineages are required. Earlier 90/180, 10/20 and eight-family sketches are not simultaneous active sampling requirements.

## Required discriminating ablations

These are a retained broader menu of planned comparisons, not a required first-pilot run list or executed experiments. The selected immediate contrast is same-diagnosis H versus U, with competent M and frozen F, under the same gate; other ablations must be separately chosen/frozen before heldout outcomes.

- [ ] Conditional rules versus raw history, ordinary summaries, and length-matched summaries
- [ ] Applicability removed; exceptions removed; same context and retrieval budget retained
- [ ] Frozen rules versus raw-feedback memory versus generic reflection and rewrite
- [ ] Diagnosis removed versus diagnosis attached to unrestricted rewrite versus an executable diagnosis-specific update policy
- [ ] Predicted diagnosis versus independent expert/oracle diagnosis, reported as different arms
- [ ] Regression gate removed versus retained; compare with conservative suppression and report lost positives/abstention
- [ ] Same feedback versus target feedback removed, separating feedback availability from maintenance strategy
- [ ] Diff-only, changed-file, and full-repository access matched across methods; no asymmetric access advantage
- [ ] Selected-evidence revision versus a future verified full-repository revision extension
- [ ] Detector-assisted versus detectorless review under matched explicit-semantic scoring and exact-anchor requirements

## Before an empirical claim enters the paper

- [ ] Freeze the target population, complete PR frame, protocol, source manifest, annotation rubric, and budget; keep development lineages out
- [ ] Reconstruct first-review checkpoints, discussion versions, object/ref allowlists, and event-time availability; retain missing/unknown cases in accounting
- [ ] Obtain independent labels and arbitration or mechanism-specific executable evidence; separate developer statements, model judgments, and adjudicated correctness
- [ ] Establish enough independent later reuse and boundary/contract episodes under Phase 0, or narrow the research question
- [ ] Preserve negative and uncertain examples and report the denominator; deduplicate issue lineages and repeated anchors
- [ ] Use identical visible information, models, tools, and cost limits for alternatives; count construction and maintenance cost
- [ ] Measure recall, false alarms, abstention, coverage, failures, old-case preservation, later independent performance, and uncertainty together
- [ ] Update this checklist at the evaluated commit and archive exact runtime/model configuration without claiming provider attestation

## Safe manuscript wording

Supported now: “We implement an evidence-bound workflow for proposing and locally comparing versioned repository review rules. Authored integration scenarios verify provenance preservation, explicit uncertainty, and rejection of a candidate that loses a selected positive.”

Supported structural extension: “A conservative policy constrains diagnosis-specific proposal operators and records non-mutation outcomes separately. Authored fixtures verify the asserted enforcement and persistence behavior; they do not establish diagnosis truth, minimal refinement, or a valid contract transition.”

Mixed-anchor extension scope: “The result contract separately represents source-anchored decisions and target coverage, allowing mixed decisions within one file without inferring whole-file safety. Authored fixture and mocked-SDK checks concern exact binding, context gating, persistence and scoring; they do not establish live-model accuracy or an empirical reduction in false alarms.”

Hypothesis: “We hypothesize that evidence-supported diagnosis and selective updates improve subsequent review over matched feedback memory and generic reflection.”

Unsupported now: “FlyReWheel learns correct rules, identifies feedback causes, and continuously improves repository review without regressions.”

### Scope-revision applicability contract

- [x] **Explicit selected-finding non-applicability is a separate versioned comparison claim.** Opt-in v5 binds exact base finding, feedback, both rule/review versions, snapshot/head and equal selected context; required and reported context remain local to the claim. Normal review still refuses excluded targets. [Validator](../src/comparison-applicability.ts); [contract](../docs/local-revision-comparisons.md#explicit-applicability-for-literal-path-revisions)
- [x] **Path exclusions cannot hide established positive obligations.** V5 separately counts coverage and rejects lost positives, including contradictory NOT_APPLICABLE claims; omitted bindings remain inconclusive. This is local selected-evidence behavior, not a guarantee over unseen positives. [Scorer](../src/revision-comparison.ts); [tests](../tests/comparison-applicability.test.ts)
- [ ] **General whole-file applicability and semantic correctness.** The implemented claim applies only to selected finding anchors. Excluded negative/fixed file regression cases remain inconclusive. Context-kind names, fixture/model claims and receipts do not establish truth, logical narrowing, historical routing, or empirical accuracy.
