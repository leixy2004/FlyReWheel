# FlyReWheel methods and evidence boundaries

Status: research methods draft, 2026-10-02. The earlier workflow audit inspected `e0e6c380d710434f4d0541b1a238784045130db8`; the diagnosis-operator sections now describe the working-tree extension on `000c50d670ac2bbd007eca2bdecde0bf53093c84`, with its own [source hashes and authored-fixture verification](../docs/evidence/revision-operators-verification-2026-10-02.txt). The mixed-anchor review extension has a separate [verification record](../docs/evidence/mixed-anchor-review-verification-2026-10-02.txt) and [compiled mocked-SDK smoke](../docs/evidence/compiled-mixed-anchor-review-smoke-2026-10-02.json). This document separates structural implementation support and authored-fixture evidence from the untested empirical hypotheses. It reports no new empirical experiment or model-quality result. The [claim and evidence checklist](claim-evidence-checklist.md) is the companion audit; the [three-window protocol](discriminating-experiment.md) is the selected pilot route, while the [Phase 0 protocol](phase0-protocol.md) remains deferred design history.

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

## Research question and scope

FlyReWheel studies whether repository-specific review knowledge can remain useful as code, assumptions, and interfaces change. A historical repair may support a conditional constraint without supporting a universal rule. Subsequent rejection of a finding may reveal an incorrect judgment, missing context, an omitted exception, or a changed repository contract. These explanations imply different maintenance actions. The research hypothesis is that choosing an update from an evidence-supported diagnosis reduces repeated review errors while preserving valid detections, compared with retaining the same history and feedback in general reviewer memory.

The present system makes this hypothesis testable through immutable rule versions, anchored observations, bounded proposal interfaces, and paired comparisons. It does not yet establish the hypothesis. In particular, asking a model to output a diagnosis and a rewritten rule is not, by itself, a validated cause-aware algorithm. The new implementation adds a conservative diagnosis-to-operator policy to schema and provenance validation. It constrains permitted fields and no-change outcomes, but does not verify the causal explanation, semantic suitability of an edit, or empirical benefit of the intervention.

The intended unit of scientific evaluation is an independent issue instance in a later PR, conditional on a rule family learned from earlier evidence. A detector match, saved rule version, accepted fixture proposal, or completed worker process is not such an instance. Engineering properties and semantic quality therefore have separate evidence requirements throughout this draft.

## Conditional repository rules

We represent a versioned rule as

`R_v = (M, I, A, X, C, S, D, P, G, parent)`.

Here `M` describes the failure mechanism; `I` is the invariant; `A` records applicability conditions; `X` records exceptions; `C` specifies required context; `S` is repository and path scope; `D` contains optional detection assets; `P` binds source cases and authored provenance; `G` names regression cases and their intended roles; and `parent` links an exact preceding version. The implementation also stores a title, testable expected behavior, version label, author declaration, timestamp, and rationale. The digest covers the full authored record, and conflicting content under the same logical rule/version is rejected. Version labels alone do not define chronology or an active version. See [the semantic schema](../src/core/semantic-rule.ts) and [its persistence contract](../docs/semantic-rules.md).

For conceptual interpretation, a rule prohibits `not I(x)` when `A(x)` holds and no exception in `X(x)` applies. This is a specification of the intended judgment, not an implemented logical solver: the current applicability, exception, invariant, and context fields are natural-language strings. Their presence does not demonstrate that the model interpreted them correctly or that they define a consistent predicate.

Repository and path scope admits candidate targets. It does not establish semantic applicability. Likewise, an AST pattern can find a direct worker call without establishing that the call occurs in a remote backend. A repair can change a dominating condition while leaving the matched statement intact. Static recall and semantic adjudication must therefore be reported separately. The existing [vLLM seed replay](../experiments/vllm/RESULTS.md) demonstrates the limited structural observation that some repaired files retain matches; it does not establish correct semantic rejection or future generalization.

The conceptual reviewer returns `violation`, `safe`, or `unknown` for a target and, independently, for exact source anchors, each with its own reason, evidence and context gaps. Target coverage and execution status are separate from anchor decisions: an unexamined, excluded, unsupported, failed, or out-of-scope target is not silently mapped to `safe`, and a supported local decision does not establish whole-file safety. The paper's annotation vocabulary further separates safe applicable cases from legal neighbors and changed contracts. Those research labels are not all separate runtime judgment states.

## Evidence and historical visibility

### Immutable packages and unknown source labels

Mining starts from a frozen PR evidence package and an explicitly selected request. Selected source sides bind repository identity, full commit, path, Git blob identity, byte length, and source digest. In the current comparison capture, the before side binds the merge base and the after side binds the head. The before side must not be described as an arbitrary earlier review checkpoint. Selected discussion records retain exact identifiers and content digests. These bindings support later integrity checks but do not authenticate every provider claim or prove the truth of a statement.

Imported mining source cases have `expected: unknown` and no human reviewer. An approval, merge, resolved thread, or author statement that code is fixed supplies evidence to investigate; it does not create a correctness label. Current generation fixes rule identity and provenance in application code and initializes mined regression cases as empty rather than inventing labels from source sides. See [mining requests](../docs/pr-mining.md) and [the generation boundary](../docs/pr-mining-model-boundary.md).

### A temporal evaluation requires a separate construction

For a review at time `t`, the scientific protocol requires an input package `E(t)` containing only code, discussion versions, and rules demonstrably available before the relevant decision. A source's `available_at`, an event's timestamp, and the later capture time have different meanings. An edited comment cannot be supplied at its original creation time with its present body. A commit timestamp alone does not prove that a PR head was publicly reviewable at that time.

The proposed [Phase 0 protocol](phase0-protocol.md) separates historical learning material, an as-of target checkpoint, and later material used only for annotation. This is a methodological requirement, not a current capture guarantee. The implemented GitHub discovery operates on bounded current creation-time search results; it does not enumerate the protocol's first-ready-for-review sampling frame or reconstruct all discussion versions. A bounded merged-PR development query cannot serve as the protocol's probability sample, which must retain unmerged PRs and other potentially zero-opportunity cases.

The workspace history policy is currently `all-local-refs-v1`. A checkout at an old head can still expose later reachable objects through other refs or history. Consequently, exact-head verification does not establish a temporally isolated evaluation. The proposed full-repository experiment needs a separate export containing only an audited, as-of object/ref set, with caches, retrieval indexes, online access, and cross-case memory controlled as well. Content hashes alone cannot certify historical visibility. See [the runner boundary](../docs/codex-workspace-runner.md) and [checkout verification](../src/workspace/runtime-checkout.ts).

The local source-split registry provides a narrower safeguard. Revision preparation reserves consumed source identities and rejects registered heldout content; later aliasing of the same consumed bytes into holdout is also rejected. This is useful integrity protection, but exact-byte matching does not identify every near-duplicate, backport, semantic lineage, future object, or pretraining exposure. Full-file equality is also not a statistical definition of dependence. Temporal and problem-lineage audits remain necessary.

## Implemented review and revision workflow

### Historical candidate construction

The mining interface accepts selected evidence and either a bounded candidate response or an insufficient-evidence response. A candidate can propose semantic text, literal path scope, and a bounded set of detector drafts. Application code supplies rule identity, source provenance, and other protected fields. A supplied or fixture response cannot declare that a model ran. The supervised workspace API adds execution receipts only after the configured worker and lifecycle satisfy their acceptance checks.

Mining supports both selected-evidence input and an explicitly configured full-repository workspace path. Its recorded integration tests use authored transports or executables. A typed response received through the official SDK is still fixture output when that executable is authored. No live mining effectiveness has been established.

### Current review

The supervised semantic review API pins a stored rule and change snapshot, checks the supplied snapshot against local Git, and requests a workspace at the exact head. New `semantic-review-v2` responses retain one coverage judgment per captured in-scope after-side target and add independent `anchorJudgments`. Each anchor binds the exact snapshot, side, path, source digest and span; evidence excerpts are validated against captured bytes. Each target and anchor uses only its own evidence references and missing-context declaration: unmet required context or a declared gap forces that judgment to `Unknown`, and a decisive judgment requires evidence. An unknown target may retain supported safe and violating anchors. A safe target cannot declare a violating or unknown anchor; a violation target requires a declared violation anchor. After context gating, target safety becomes unknown if any selected safe anchor is unknown, and target violation becomes unknown if all its violating anchors are unknown. Anchors never inherit target state or evidence. CLI snapshot review remains structural or offline-fixture based; new fixtures use `schemaVersion: 2`. See [the workspace review contract](../docs/semantic-review-model-boundary.md).

New execution receipts bind `judgmentContract: "per-anchor-v3"` to the prompt/schema and worker contract. Historical schema-version-1 fixtures and older receipts retain their original bytes, identities and rederivation, including explicit `target-and-anchors-v2` and unmarked contracts. They are not silently upgraded or retroactively given per-anchor guarantees.

Three scopes must remain distinct:

1. **Accessible context:** the workspace API permits full-repository inspection through its configured tool policy
2. **Accepted evidence:** the current result validator accepts anchors only in captured changed entries, including captured before-side context
3. **Reported coverage:** stored reviews remain `changed-entries-only`, with incomplete repository context

A model's ability to read an unchanged helper does not make that helper an admissible, independently captured evidence anchor. If the judgment needs such a fact and it cannot be represented in accepted evidence, the result must retain the gap. Full-repository access therefore cannot yet support a claim of repository-wide evidence coverage. Findings also retain unverified introduction and notification eligibility; a finding in an after file is not proof that the PR introduced it.

### Feedback and a frozen revision request

A feedback record refers to an exact review, rule digest/version, finding, and after-side source anchor. Its source is explicit: fixture or locally declared human feedback. The latter is not authenticated identity. An FP label concerns the selected finding; it is not a declaration that the whole file is safe. Unknown, disputed, note, merge, and resolve records do not acquire a correctness expectation merely because they exist.

A revision request freezes selected feedback IDs and digests together with the exact base version and requested candidate version. Later feedback is not automatically added. Generation rederives the selected graph and excludes comparison results, decisions, and evaluation outputs. Timestamp consistency is checked against authored fields, but those checks are not independent proof of an as-of cutoff.

### Diagnosis-constrained proposals and no-change outcomes

New generation uses the fixed worker contract `rule-revision-v2` and policy `diagnosis-operators-v1`. Its diagnosis vocabulary is `judgment`, `context`, `boundary`, `contract`, `mixed`, and `insufficient_evidence`. Exactly one diagnosis is required for each selected feedback record; it must cite that feedback. Insufficient-evidence diagnoses must name missing evidence. A candidate must cite the base rule and every selected feedback/finding. All references must be unique and supplied, and all diagnoses carry an explicit proposal status. See [the diagnosis schema](../src/core/revision-model.ts) and `validateRevisionModelResponse` in [the generator](../src/revision-generation.ts).

Generation currently uses `selected-evidence-no-tools`: the prompt contains the frozen base, source/regression cases, selected findings, and their cited captured excerpts. Unselected file contents are not included. The workspace is lifecycle infrastructure; trusted worker configuration disables repository tools for this contract and rejects observed tool or command events. This is not full-repository revision reasoning, and it is not an independent isolation attestation. Extending revision to repository exploration requires a new, explicit evidence and temporal-exposure design.

The validator derives a permitted operator from the selected labels and proposed diagnoses. All selected feedback must use decisive TP/FP label values without a conflicting pair on the same finding; these remain declarations, not established correctness. Non-label, Unknown, or Disputed feedback, multiple diagnosis categories, or a `mixed` or `insufficient_evidence` diagnosis require abstention. Next, uniform context diagnoses allow `request_context`, including when context is missing. For all other categories, declared missing evidence requires abstention. With no such gap, uniform judgment diagnoses allow `retain_rule`, uniform boundary diagnoses allow `boundary_update`, and uniform contract diagnoses allow `contract_replacement`. Voluntary `abstain` is always allowed. This is an executable structural policy over declarations, not an independently validated diagnosis classifier.

`boundary_update` requires an actual change confined to applicability, exceptions, or literal paths. Title, mechanism, invariant, required context, expected behavior, and detection assets must remain exact; no replacement declaration is allowed. These restrictions do not establish that an edit logically narrows the rule, is minimal, or is correct.

`contract_replacement` requires an actual rule edit and an explicit replacement declaration binding the exact prior-rule digest, distinct old/new contract texts, the supplied base-rule and every selected finding reference, and distinct old/new applicability descriptions. Its retirement status is `proposed_requires_review`, with activation explicitly not performed. The declaration does not verify a historical contract change or timeline and does not execute version routing, activation, or retirement.

For either candidate operator, application code preserves all base source references and regression cases/roles, assigns the exact direct parent and requested version, and validates the reconstructed rule. It cannot relabel old cases, remove regression references, rewrite feedback, certify a rule, or activate it. The non-mutation operators use a strict `no_rule_change` result with diagnoses, reasoning, missing evidence, and a concrete next step. They are persisted with the execution receipt in a separate immutable outcome table, without manufacturing a new rule version or changing a finding. Retaining a rule does not repair its review, and requesting context does not acquire it. The [application entrypoint](../src/rule-revision.ts) connects preparation, bounded generation, and atomic persistence.

Historical v1 receipts and candidates remain readable through their original prompt and schema rederivation. Their validation claim stays schema-and-provenance-only; the new policy does not apply retroactively. The [operator verification](../docs/evidence/revision-operators-verification-2026-10-02.txt) tests enforcement, persistence, rejection behavior, and legacy reading with authored fixtures. It does not establish diagnosis truth, correct contract routing, or improvement on future PRs.

### Regression comparison and local decisions

The comparison stage pairs reviews of the exact base and candidate rules on the same frozen snapshots. It includes the union of declared regression cases plus the request's selected feedback, preserving exact source identities and anchors. Known case expectations must agree with declared roles. A missing binding or unknown expectation stays inconclusive. Notes and unresolved opinions cannot certify a correction.

For a known expectation and known observations on both sides, the derived outcomes are:

| Base matches the expectation | Candidate matches the expectation | Outcome |
| --- | --- | --- |
| Yes | Yes | Preserved |
| No | Yes | Corrected |
| Yes | No | Regressed |
| No | No | Still failing |

All other comparisons are inconclusive. Current `per-anchor-semantic-v3` scoring accepts explicit, validated judgments with their own required context complete, without a detector or with zero hits. A declared file-level regression case is scored by its exact target judgment; selected feedback uses the exact anchor judgment. Every declared asset must still have successful scan coverage. Incomplete scans, missing context, unknown judgments at the scored scope, and unexecuted semantics remain inconclusive. Removing a detector or producing no matches never establishes safety by itself, and the union of base/candidate regressions prevents a dropped positive case from disappearing from the comparison.

Selected feedback has a narrower scope than a file case. Both safe and violation observations require the exact selected snapshot/side/path/source/span anchor in new `anchorJudgments` or legacy explicit `findingAnchors`, plus a validated known finding at that anchor. An evidence citation, target-only safe judgment, or adjudication at another site does not score the selected FP. A separately supported anchor can score while target coverage is unknown; a missing or unknown anchor remains inconclusive despite known target coverage. Independent decisions can therefore preserve a violating site and a legitimate safe exception in one file without dropping the positive or inventing whole-file safety. The file-level case still requires a known target judgment. Safe anchors can exist without detector occurrences. The [mixed-anchor record](../docs/evidence/mixed-anchor-review-verification-2026-10-02.txt) and [compiled mocked SDK/worker/store/comparison smoke](../docs/evidence/compiled-mixed-anchor-review-smoke-2026-10-02.json) concern authored implementation checks, not model correctness or empirical benefit.

Historical unversioned comparison reports retain legacy detector-gated scoring on read, including historical whole-target safety behavior. Reports marked `explicit-semantic-v2` retain that scorer's target-gated explicit-anchor behavior. Existing decisions remain readable historical declarations. New comparisons use `per-anchor-semantic-v3`; a new accept against either older scorer is blocked until a newly identified current-scorer comparison is created. Stored reports and receipts are not rewritten or retroactively certified by the newer gate.

A compatible summary requires all selected entries to be preserved or corrected. Any regressed or still-failing entry blocks compatibility; otherwise any inconclusive entry does so. Explicit local acceptance is allowed only for compatibility. Reject and defer remain available. Counts describe selected entries, which can overlap in their underlying example, not independent defects. A local accept does not mutate an active-rule catalog, activate the candidate, authenticate a human decision, or certify future behavior. See [the comparison implementation](../src/revision-comparison.ts) and [local decision contract](../docs/local-revision-comparisons.md).

## Offline descriptive evaluation of frozen outputs

The separate `exact-anchor-issue-paired-v1` harness consumes a frozen dataset, separately supplied annotations and two or more frozen semantic-review arms. It validates the existing v2 rule/snapshot/review contracts without model or scanner execution, and binds the report to exact manifest, policy, model/version/configuration, information and construction/maintenance/review-budget identities. The fixed PR × family roster includes zero-instance and incomplete-execution units. Exact source anchors match annotated issue instances; repeated anchors within an issue cannot inflate useful-instance counts. Known positives without alerts remain misses, while unknown/disputed/excluded labels and unmatched findings stay outside negative labels. Target coverage and exact-anchor observations remain distinct. Per-PR, per-family, split-specific counts and gained/lost-positive transitions expose suppression tradeoffs.

Paired deltas are descriptive and require equal declared model/information/budget conditions and a complete roster; absent unit records or mismatched conditions withhold deltas. Explicit failed/not-run units remain in denominators. Imported receipts are internally revalidated, and contradictory context/history or understated reported token/call usage is rejected. This establishes local consistency, not source, model, annotator, cost or temporal attestation. Label origins remain synthetic, locally human-declared or adjudicated declarations. There is no automatic conversion from comments/merge to labels, no significance test, and no promotion or efficacy certificate.

The authored demonstration is an implementation counting oracle, not a heldout experiment: candidate predictions remove one false-alert instance, lose one known positive and gain a different positive. Both arms detect two of five authored positive issues and miss three. Independent real annotations, temporally isolated outputs and matched empirical baselines remain absent. The [contract and commands](../docs/paired-review-evaluation.md) and [verification record](../docs/evidence/paired-evaluation-verification-2026-10-02.txt) define this extension's scope; they do not establish either research hypothesis or complete Phase 0.

## Diagnosis-driven research design beyond structural controls

The structural policy above implements a bounded part of the following research design. The distinguishing hypothesis concerns whether an evidence-supported intervention improves later review. Enforcing an operator selected from unverified diagnoses does not establish that benefit.

Given an old rule `R_v`, an anchored observation `o`, and available feedback evidence `f`, a diagnosis stage should produce `d` together with supporting and conflicting evidence and unresolved prerequisites. The implemented policy constrains retention, context requests, boundary proposals, contract-replacement proposals, and abstention. Actual repair of a review procedure, evidence acquisition, and contract retirement remain separate work. An executable retirement action would require a validated applicability timeline or routing policy beyond the currently stored prose declarations. Independent evaluation is still needed for both diagnosis quality and intervention effects.

The intended choices are:

- **Judgment error:** the rule's applicable constraint is supported, but the finding misread the code or evidence. Correct or rerun the finding; do not weaken the rule merely to agree with rejection
- **Context failure:** a decision depends on unavailable or incorrectly bound context. Acquire allowed evidence or abstain, and test any change to context requirements or the review procedure
- **Boundary error:** the invariant is valid within a narrower domain or has a supported exception. Propose a localized applicability/exception revision and retain cases from the still-valid domain
- **Contract change:** establish that an earlier contract genuinely held and later changed. Propose a replacement or retirement with explicit context/time routing; preserve the old version's meaning on historical cases
- **Insufficient evidence:** keep uncertainty and request the missing discriminator instead of forcing a rule change

One episode can support several explanations. The one-category-per-feedback schema remains an operational simplification, not proof that the categories are mutually exclusive. The current policy allows an explicit `mixed` diagnosis and conservatively abstains for mixed categories, conflicting selected labels, or insufficient evidence instead of choosing a primary mutation. Whether this conservatism loses useful interventions must be measured alongside errors. Accuracy against an adjudicated taxonomy and the usefulness of the resulting intervention must be measured separately.

A non-regression objective is also conditional. A contract replacement should preserve correct historical decisions under the historical contract, not force the old constraint on new architecture. This requires either a conditional rule covering both contexts or version selection keyed to validated context. The current parent link is provenance, not such a selector, and current generation keeps existing regression expectations fixed. A test that simply changes old labels to make a replacement pass would destroy the preservation claim.

The proposed refinement loop is: freeze the evidence available for an episode; diagnose with explicit uncertainty; choose and constrain the permitted intervention; generate a bounded proposal or abstain; compare on the available development regression set; record the decision; and evaluate the resulting state on an independent future PR. The implementation supplies data/execution steps and structural operator constraints. No diagnosis-specific controller has been empirically validated, and no candidate-search strategy, calibrated confidence rule, or executable temporal retirement policy is established. No theorem of convergence, minimum edit, completeness, or semantic soundness is claimed.

## Evaluation design and ablations

### Establish that the task exists at a useful scale

The selected [three-window route](discriminating-experiment.md) first generates and freezes experimental W0 rules from earlier real PRs, human-verifies actual W1 reviewer findings as experimental feedback, and evaluates F/U/H/M on independent W2 PRs with matched models/evidence/budgets/gates and separate provided/inferred diagnosis conditions. The route is chosen but its execution configuration is not frozen or preregistered. Natural old-rule histories are optional, not an entry gate. The earlier Phase 0 natural-opportunity design below is retained as deferred protocol history; its proposed numerical thresholds do not apply to the selected pilot. It asks whether independent future reuse opportunities and supported boundary/contract episodes exist in its proposed sampling frame. It distinguishes opportunity, observed human reuse, feedback-associated code correction, actual rule correction, and improved later review. None implies the next. Natural review comments are incomplete labels, and a code change following advice is not evidence that an explicit review rule was revised.

The deferred Phase 0 protocol was never frozen: repositories, complete frames, independent annotators, and budget were not supplied. Its proposed 90 historical and 180 target PRs, thresholds, and observation windows remain historical design choices, not collected data or active pilot requirements. The five vLLM seeds and PR #8568 are development material. Independent human judgments and arbitration, or mechanism-discriminating executable evidence, must precede quality claims. The selected study is explicitly a controlled generated-rule task, not a measurement of widespread natural rule updating. Freeze W0 rules before W1 content/label exposure, retain all-PR and PR × family denominators including zero-yield/unknown cases, and keep independent W2 lineages out of construction/feedback/gate inputs. Actual recurrence and valid experimental feedback remain unestablished; earlier natural-episode scarcity no longer blocks this route.

### Compare matched alternatives

H1 remains a separate conditional-transfer question. The selected H2 pilot compares hard restrictions H with unrestricted editing U under the identical frozen diagnosis, plus competent scoped incremental memory M and frozen state F. M may revise, qualify or suppress its scoped lesson within the same persistent-state cap; it is not a passive transcript baseline. All updating arms share the gate, evidence, reviewer/revision models, retrieval and resource ceilings, one proposal slot and non-mutation options. Expert-provided O and shared model-inferred I diagnoses define separate conditions, both still conditional on human-verified experimental feedback. Construction, retrieval, diagnosis, revisions, rejections, gate replay and future review all count toward cost.

The following broader ablation menu is retained for later studies, not added to the selected first-pilot run list. Any extension needs its own pre-output freeze:

1. Remove applicability conditions, remove exceptions, and compare with length-matched summaries to isolate representation from prompt length
2. Remove diagnosis labels while retaining the same feedback and evidence; compare diagnosis-plus-unrestricted-rewrite with diagnosis-constrained interventions to test whether the proposed controller matters
3. Remove the regression gate and compare with rule suppression; report whether fewer false alarms merely reflect lost detections or greater abstention
4. Match full-repository access across methods; separately vary diff-only, captured changed-file, and full-repository evidence access
5. Compare selected-evidence revision with a temporally isolated full-repository extension only after that extension and its evidence boundary exist
6. Remove the target feedback while holding prior state fixed; compare with oracle diagnosis to separate feedback availability, diagnosis quality, and update quality
7. Compare detector-assisted and detectorless review under the same explicit-semantic scoring and exact-anchor requirements, so changes in candidate coverage do not masquerade as improved semantics

The historical and future sets must be split by visibility and problem lineage, not merely by PR number or commit date. Multiple candidate revisions tuned on the same regression set are development attempts and consume budget; that set cannot later certify generalization. Seed before/after pairs and small semantic-preserving mutations are useful checks but not independent future instances.

### Outcomes and interpretation

Report issue-level precision and recall where a defensible oracle exists, recall at a fixed false-alarm budget, legal-neighbor false positives, repeated errors after feedback, preservation of still-valid old detections, and behavior after verified contract changes. Report unknown/abstention, uncovered targets, execution failures, cost, and annotation uncertainty alongside quality. An unavailable denominator must be stated; naturally unreviewed code is not a negative label. Phase 0 itself does not estimate system precision/recall.

Use paired comparisons on the same future PRs, preserve family/PR dependence in uncertainty analysis, and report per-repository counts and repeated-run variation. Diagnosis accuracy, developer agreement, semantic correctness, and local gate compatibility are different outcomes. A future controlled experiment can identify the effect of a specified update operation under its experimental conditions; it does not automatically identify the causal effect of naturally occurring developer feedback.

The main hypothesis is weakened if memory baselines match the proposed method, diagnosis errors dominate, gains disappear under matched context and cost, or reduced false alarms are explained by rule suppression or abstention. Such findings should narrow the claim rather than be hidden behind increased rule counts or a completed workflow.

## Present evidence and epistemic limits

The 2026-10-03 [real PostgreSQL verification](../docs/real-postgres-verification.md)
adds server-backed infrastructure evidence at baseline
`237056acaaa3c21684fd63772eaca119e2af5f3a`: concurrent migrations and claims,
fencing, retry after a killed worker process, database restart persistence,
014→015 upgrade rollback/preservation, and compiled service health/shutdown.
The payloads are authored fixtures; model execution is `not_run` and the
application runtime remains blocked. These checks support recovery and storage
claims only. They do not supply independent W0/W1/W2 cases, human labels, matched
live-model outcomes, or evidence of improved future review. The selected
three-window pilot and its freeze, lineage, equal-budget and annotation gates
remain prerequisites for any efficacy comparison.

The recorded local closed-loop demonstration uses three real but synthetic Git commits, real ast-grep scanning, embedded PostgreSQL through PGlite, and an authored executable through the installed Codex SDK. Its two predefined candidate scenarios verify that one selected positive is preserved while one selected negative is corrected, and that losing the positive blocks acceptance in the other scenario. It reopens 28 persisted records and inventories 33 artifacts. Proposals, semantic judgments, TP/FP feedback, and decisions are authored fixtures; the source labels stay unknown, `modelExecution` is `not_run`, isolation is unverified, and activation is not performed. These are functional assertions, not measured learning gains. See the [recorded verification](../docs/evidence/local-closed-loop-verification-2026-10-02.txt) and [compiled report](../docs/evidence/local-closed-loop-compiled-2026-10-02.json).

The [operator verification record](../docs/evidence/revision-operators-verification-2026-10-02.txt) reports final frozen-source typecheck/build and 663 passing tests across 46 files with two workers. Its [compiled v2 smoke](../docs/evidence/compiled-revision-operators-smoke-2026-10-02.json) persists a boundary candidate, compares it, records local acceptance, blocks regression acceptance, and persists/reopens the three no-rule-change operators; it also rejects selected mutation mismatches and a protected-field edit. Diagnoses, labels, judgments, and model outputs are authored fixtures, with model execution not run and no activation. The earlier [query verification record](../docs/evidence/github-pr-history-range-live-2026-10-02.json) and [detectorless comparison record](../docs/evidence/detectorless-comparison-verification-2026-10-02.txt) remain separate checkpoints. These tests establish the asserted implementation behaviors, not semantic correctness, production isolation, scientific novelty, or empirical review improvement.

The original October 1 capture of [vLLM PR #8568](https://github.com/vllm-project/vllm/pull/8568) remains available and records two changed paths, three captured sides, and current discussions. The October 2 corrected range preview received HTTP 200 and selected #8568. A subsequent batch capture attempt stopped on its first PR GET with HTTP 403, zero accepted evidence bytes, and no fresh capture receipt. The saved classification is `forbidden-or-rate-limited`; rate limiting has not been established as the cause. Local reopening preserved the failure, and skipping the failed item without explicit retry made zero GETs; this is failure-persistence verification, not completed-capture reuse. Preview success and the older capture do not turn the failed new batch into a successful capture. None of these observations supplies an independently labeled feedback episode or historical review checkpoint. See the [original capture](../docs/evidence/github-pr8568-capture-2026-10-01.json), [corrected preview](../docs/evidence/github-pr-history-range-live-2026-10-02.json), and [batch failure record](../docs/evidence/github-pr-history-batch-live-2026-10-02.json).

The most important remaining limits are empirical and methodological. There is no independently labeled heldout sequence demonstrating correct diagnosis and successful later reuse; no measured advantage over matched memory or reflection; no verified full-repository revision reasoning; no certified as-of workspace export; and no evidence that the available natural feedback contains enough actual rule-maintenance episodes. Execution receipts bind accepted bytes and observed lifecycle events within a trusted application boundary. They do not attest provider identity, model identity, historical truth, semantic truth, or containment against a malicious backend.

## Novelty boundary and defensible contribution

The [existing narrative review](narrative-draft.md) identifies close overlap with RhoSynth's example-driven rule synthesis/refinement, Archer's historical semantic obligations and agentic repository review, AutoCommenter's feedback and outdated-practice handling, and Learning to Commit's repository memory from historical changes. Those prior-art notes and their primary-source links are retained; this drafting pass did not conduct a new literature search or establish priority.

Accordingly, historical fixes, rules, feedback, versioning, repository access, or a closed loop should not be claimed individually as novel. The unresolved methodological contribution is an operational, evidence-supported distinction between judgment/context failures, boundary errors, and contract changes, coupled to selective interventions that improve future review beyond matched memory and generic reflection. The structural controller makes some choices explicit and testable; its scientific value still requires independent labels and empirical evidence. If the evidence supports only conditional transfer, the maintenance claim should be removed. If the principal result remains reliable orchestration and provenance, the work should be presented as a system prototype or tool with clearly bounded verification.

## 中文提纲

- 已有实现：精确来源和版本绑定、反馈选择冻结、候选修订、同快照对照、本地决策，以及 fixture 闭环；本轮诊断算子约束、独立保存的无修改结果及旧版读取已通过 authored fixture 验证
- 尚不能声称：诊断正确、边界修改最小或逻辑收窄、契约变化已证实、退役和路由已执行、全仓修订推理、时间隔离评测或真实反馈带来的持续改善
- 核心区分：全仓可访问不等于全仓证据已捕获；版本父子关系不等于契约的时间适用策略；保留回归记录不等于保留实际检出能力
- 下一步研究门槛：确认独立复用和边界／契约更新机会，获得可靠标签，再与同信息量、同上下文、同成本的 memory 和通用反思做未来案例对照

### Bounded applicability adjudication for path revisions

An opt-in `scope-applicability-v5` comparison contract now provides a dedicated
selected-finding applicability channel. It does not change ordinary rule-scoped
review: excluded targets remain out of scope and unreviewed. A separate explicit
NOT_APPLICABLE claim binds the exact request, rule versions, reviews, snapshot/head,
base finding and feedback, with matching frozen repository-context selection and
independently cited required context. Missing, skipped or unknown work never counts
as correction. Fixture declarations and typed no-tools execution receipts are
unverified claims; byte identity and declared context kinds do not prove semantic
non-applicability. Literal path changes are not logical proof of rule narrowing.

The new comparison reports scope coverage separately and rejects a candidate that
loses an established positive regression or selected TP through exclusion. Old
scorers and hashes retain their historical meaning. The bounded contract can
correct a selected FP-only anchor while preserving other regression cases, but
cannot promote that anchor into a whole-file negative/fixed case result. Such an
excluded file-level case remains inconclusive. The offline fixture checks establish
application semantics only, not independently measured accuracy or live runtime
readiness. See the [comparison contract](../docs/local-revision-comparisons.md#explicit-applicability-for-literal-path-revisions).
