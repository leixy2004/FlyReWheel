# FlyReWheel Maintaining Repository Review Rules with Diagnosis Constrained Updates

**DRAFT — NO EFFICACY RESULTS.** Research manuscript draft, 2026-10-02. Implementation scope remains anchored to FlyReWheel commit `fa601ee`; the study-route revision was made at checkout `250a242`. The paper describes an implemented proposal-and-comparison mechanism and a selected, unexecuted study route whose operational protocol is not yet frozen or preregistered. The motivating example includes executed, source-bound function-body checks; no reviewer-model comparison, independent future-case evaluation, or measured maintenance benefit has been completed.

## Abstract

Historical repairs can inform code review, but a repair usually supports a constraint under particular assumptions. Later feedback may expose a mistaken judgment, missing context, an omitted exception, or a changed contract. Treating every rejection as a reason to rewrite a rule conflates these cases. We present FlyReWheel, a prototype that binds review findings to rule versions and source evidence, requires explicit proposed diagnoses, constrains the permitted update operators, and compares candidates against preserved regression obligations. Retention, requests for context, and abstention are recorded without manufacturing a new rule version. A developmental analysis of a vLLM repair illustrates why a rule about deriving a default must distinguish implicit and explicit inputs, and why accepted review advice does not itself establish a corrected defect. Our selected next study uses three chronological windows in one repository: generate and freeze experimental rules from earlier real PRs, obtain independently human-verified experimental feedback on middle-window PRs, and compare frozen rules, unrestricted edits, constrained edits and scoped memory on independent later PRs under matched evidence, models, budgets and regression gates. Whether diagnosis-constrained updates improve later review remains an open empirical question.

## 1 Introduction

A repository's repair history contains more than patches. It can identify assumptions about interfaces, defaults, lifecycle ordering, or configurations that matter in later reviews. The difficulty is deciding how far each lesson extends. An invariant learned from one backend may not apply to another; a formerly correct interface constraint may become obsolete. Conversely, a rejected finding may simply have misread valid code. Weakening its rule could discard useful knowledge without fixing the review process.

Existing work already learns analysis rules from fixes and counterexamples, extracts semantic obligations from historical repairs, and uses repository memory for later development tasks. Archer even proposes revising obligations from failures and checking the revisions on a regression benchmark. Accordingly, neither historical learning nor a feedback loop is a sufficient novelty claim. The question studied here is narrower: **given the same history, feedback, repository access, and budget, does an explicit distinction between judgment, context, boundary, and contract failures help maintain review knowledge better than general memory or unrestricted rewriting?** [1–4]

FlyReWheel implements a conservative intervention policy. A proposed boundary error permits edits to applicability, exceptions, or path scope while preserving the invariant. A proposed contract change requires an explicit old/new contract declaration. Judgment and context failures produce no-rule-change outcomes. Conflicting or insufficient evidence can force abstention. Candidates are evaluated against the same selected evidence and retained regression obligations before a separate local decision. These controls make interventions inspectable; they do not prove the diagnoses or the semantic correctness of a revision.

The contributions of this draft are limited to **an implemented, evidence-bound rule-maintenance mechanism** and **a falsifiable study design that separates reuse, diagnosis, and intervention effects**. The source-bound vLLM example provides development evidence for the problem formulation. We do not claim a validated diagnosis algorithm, minimum rule edits, improved review quality, or priority over existing approaches. The scientific contribution depends on the future comparison: if equally informed memory performs as well, the selective policy has not earned its additional complexity.

## 2 Motivating example

In [vLLM PR #8568](https://github.com/vllm-project/vllm/pull/8568), the captured `ChatCompletionRequest.check_tool_usage` repair changes the condition for supplying an automatic tool choice. The base version tests whether the input contains a `tools` key; the final head tests the truth value of its value:

```python
# Base condition
if "tool_choice" not in data and "tools" in data:
    data["tool_choice"] = "auto"

# Final-head condition
if "tool_choice" not in data and data.get("tools"):
    data["tool_choice"] = "auto"
```

The compared source commits are base `72fc97a0f100b92f1ff6c6a16e27d12f1c7569aa` and head `eae161c33f47a0b760701769f56fc249563f8ed0`. The captured field declaration gives `tool_choice` a default of `"none"`, but a separate branch validates choices explicitly present in the input. That distinction matters. “Automatic tool choice requires nonempty tools” is too broad a description of the observed function. The repair concerns *deriving* a default when the choice is absent; an explicit `"auto"` with `tools=[]` still returns without an error in this function. [Source analysis](developmental-case-vllm-8568.md)

### 2.1 Executed local behavior

An offline [reproduction script](reproduce-vllm-8568.py) checks the captured source hashes, verifies its adapted functions against the captured text and ASTs, and executes only the function bodies. It removes the decorators and class indentation, supplies `None` for the unused `cls`, and does not import vLLM. Its 35 ordinary dictionary inputs combine five tool-list forms with seven choice forms. Selected observations are:

| Input choice | Input tools | Base function | Head function |
| --- | --- | --- | --- |
| Absent | `None` | Inserts `auto`, then raises `ValueError` | Returns with choice still absent |
| Absent | `[]` | Inserts `auto` and returns | Returns with choice still absent |
| Absent | Valid nonempty list | Inserts `auto` and returns | Same |
| Explicit `"auto"` | `[]` | Returns unchanged | Same |
| Explicit `"none"` | `[]` | Raises `ValueError` | Same |

Thus null and empty lists do not have identical pre-fix effects, and omission is not interchangeable with an explicit `"none"`. Returning an absent key does not mean the reproduction applied the field default. Full Pydantic validation, other validators, the HTTP interface, and upstream tests were not executed. The [saved output](vllm-8568-behavior-results.json) and [behavior report](vllm-8568-behavior-findings.md) preserve this boundary.

### 2.2 What accepted feedback does not establish

The captured review discussion asks the author to retain two sequential `if` statements instead of using `elif`, and the author indicates acceptance. Sequential conditions allow the newly inserted choice to enter the validation branch. However, observing that path difference is insufficient to establish an output defect.

The reproduction also executes two explicitly counterfactual variants: a final-head function with a flat `elif`, and the early review hunk's nested prefix combined with the final-head suffix. Neither is the recovered complete early historical function. Both match the final head's return values, exceptions, input mutations, and return identity on the 35 inputs, while skipping validation for the two tested nonempty-list defaulting inputs. This is finite agreement under stated assumptions, not a general equivalence proof or execution of the actual early commit.

Across base, head, and those two variants, all 140 calls satisfy the author-written expectation table. **These are 35 inputs times four variants of one developmental case, not 140 independent cases, a benchmark, upstream test passes, or a model comparison.** No explicit historical review rule or subsequent independent reuse is present. The example therefore motivates preserving applicability boundaries and uncertain feedback interpretations; it does not demonstrate successful rule maintenance. It also supplies an adverse alternative explanation: a short, accurate summary of this repair might be sufficient, without the proposed machinery.

## 3 Problem definition

A rule family represents a recurring failure mechanism and constraint. A version is

`R_v = (M, I, A, X, C, S, P, G, parent)`

where `M` describes the mechanism, `I` the invariant, `A` applicability conditions, `X` exceptions, `C` required context, `S` repository/path scope, `P` source provenance, and `G` regression obligations. An exact parent digest links versions. Optional detection assets locate candidate sites. The semantic fields are natural-language specifications; they are not executable predicates or a verified logic.

Conceptually, an instance violates a rule when its applicability holds, no exception applies, and the invariant fails. Operationally, the reviewer reports `violation`, `safe`, or `unknown` at an exact source anchor, separately from target coverage. Missing execution, an excluded path, or lack of a detector match cannot establish safety. A legal neighbor is an apparently similar instance outside the intended condition or within an exception; it is distinguished from a safe applicable instance in the research labels.

At review time `t`, an input package must contain only code, discussion versions, and rule evidence available then. A finding binds a rule version, snapshot, source span, cited evidence, and unresolved context. A feedback episode groups responses concerning the same finding or rule and issue. The maintenance task is to choose a permitted intervention using that episode, then assess the resulting state on later independent PRs. A source repair's before/after pair, a backport, and another location in the same issue lineage are not independent future instances.

The objective has two parts: reduce repeated erroneous findings after feedback, and retain detections where the earlier constraint remains valid. Abstention, lost coverage, newly missed issues, and total maintenance cost must remain visible. For genuine contract changes, preserving the old rule's historical meaning also requires selecting the correct rule for each context; immutable parentage alone does not solve that problem.

## 4 Method

### 4.1 Freeze evidence before proposing a change

Historical mining proposes a conditional rule from selected repairs and discussion. Source sides begin with unknown correctness labels; merge status, approvals, and comments do not automatically create positive or negative examples. Current review binds the rule to a captured snapshot and, optionally, explicitly selected repository-context files at the exact head. Individual judgments must cite their own supporting evidence and retain missing context.

A revision request freezes the base rule and the exact feedback, findings, source cases, and regression obligations selected for the episode. Generation receives this graph and supplied evidence excerpts. The current revision contract is `selected-evidence-no-tools`, including when selected excerpts come from unchanged repository files. It does not autonomously explore the repository during revision. This bounded input makes exposure auditable but may prevent useful diagnoses when the necessary discriminator was not captured.

### 4.2 Constrain interventions by proposed diagnosis

Each selected feedback item receives one proposed category and evidence references. The controller first requires decisive, nonconflicting TP/FP declarations. Non-label feedback, unresolved labels, mixed categories, or insufficient evidence force abstention. Uniform context diagnoses permit a context request; otherwise declared missing evidence blocks mutation. Context-aware inputs additionally prevent unresolved selected findings from authorizing a mutation. Passing these gates does not authenticate feedback or validate the diagnosis.

The prototype does not turn arbitrary review discussion into trustworthy TP/FP labels. A study must identify how those inputs become available. Adjudicator-supplied feedback is shared experimental supervision, must be given equally to all arms, and cannot use later heldout outcomes. Results under that supervision would not establish an autonomous natural-feedback pipeline.

| Proposed diagnosis | Permitted intervention | Enforced boundary |
| --- | --- | --- |
| Judgment error | Retain rule | Record a repair next step; do not modify the finding or rule |
| Context failure | Request context | Record what is needed; do not claim acquisition occurred |
| Boundary error | Boundary update | Change only applicability, exceptions, or literal path scope |
| Contract change | Replacement proposal | Bind the prior rule and explicit old/new contract and applicability declarations |
| Mixed or insufficient evidence | Abstain | Preserve the unresolved state without a new rule version |

Voluntary abstention is always permitted. Boundary updates preserve the mechanism, invariant, required context, expected behavior, title, and detection assets. Replacement proposals must describe distinct old/new contracts and retain a review-required transition declaration. Both mutation operators require an actual edit and preserve source references, regression roles, and exact parentage. Non-mutation outcomes have separate records with reasons and a concrete next step. The policy is implemented in [revision generation](../src/revision-generation.ts) and specified in its [contract](../docs/rule-revision-generation.md).

The substantive hypothesis concerns this selection of interventions, not the presence of diagnosis text in a prompt. Structural restrictions neither prove logical narrowing nor select the smallest sufficient edit. The contract-change path is particularly limited: storing proposed applicability descriptions does not verify when an old contract ceased to hold or automatically route historical and current instances.

### 4.3 Compare without erasing obligations

Base and candidate reviews are paired on identical snapshots and selected context. Comparisons retain the union of declared regression cases and selected feedback. For known expectations and observations they classify each obligation as preserved, corrected, regressed, or still failing; missing support remains inconclusive. A file-level regression requires a file-level judgment, while selected feedback requires its exact source anchor. Multiple anchors in one issue do not become multiple independent successes.

Compatibility requires every selected obligation to be preserved or corrected. Regressed, still-failing, or inconclusive obligations block acceptance. Path exclusion alone cannot correct a false positive. An opt-in applicability channel requires an explicit, source-bound, context-complete `NOT_APPLICABLE` judgment for the selected finding; losing an established positive through exclusion blocks acceptance. That local declaration cannot certify a whole file. [Comparison contract](../docs/local-revision-comparisons.md#explicit-applicability-for-literal-path-revisions)

The comparison gate concerns available development obligations. It does not establish generalization to future code, and repeated tuning on the gate's cases can overfit them. Local acceptance remains a separate recorded decision, not proof of correctness or automatic selection for subsequent reviews.

## 5 Implementation and present evidence

FlyReWheel implements immutable evidence, rule, review, feedback, proposal, and comparison records in TypeScript with PostgreSQL/PGlite storage. Optional ast-grep assets support candidate localization; supervised model-capable APIs provide mining, review, and revision boundaries. The scientific mechanism is the constrained proposal and comparison path, rather than the particular SDK, queue, or storage product. The repository does not yet demonstrate an operational, non-fixture semantic-v2 inference loop through its normal executable worker. Trusted runtime composition and backend setup remain separate requirements. [Runtime boundary](../docs/runtime-readiness.md)

Three implemented capabilities require precise qualification at this checkpoint. First, [selected exact-head repository context](../docs/repository-context.md) can supply cited unchanged-file evidence; findings and reported review coverage remain tied to captured changed entries, and repository context remains incomplete. Second, [evaluation exports and workspace admission](../docs/evaluation-workspaces.md) can restrict Git inputs to declared allowed-head object closures; the default remains `all-local-refs-v1`, and neither mode proves historical public availability. Third, [local governance](../docs/semantic-rule-governance.md) and [governed review execution](../docs/governed-semantic-reviews.md) implement explicit experimental selection, suspension, retirement, and supersession. These operations do not infer a semantically correct contract timeline or perform production activation.

Recorded authored-fixture checks cover [operator restrictions](../docs/evidence/revision-operators-verification-2026-10-02.txt), [context-bound revision](../docs/evidence/context-revision-generation-verification-2026-10-02.txt), [evaluation workspace admission](../docs/evidence/evaluation-workspace-verification-2026-10-02.txt), and [selected-finding applicability](../docs/evidence/scope-applicability-verification-2026-10-02.txt). These records belong to their stated source checkpoints. Authored model outputs and labels test enforcement and accounting, not model quality; their passing counts are not scientific sample sizes. The [offline paired scorer](../docs/paired-review-evaluation.md) can compare frozen outputs against separate annotations, but its demonstration is also synthetic. The executed function checks in Section 2 establish a different, narrow fact: behavior of source-bound adapted functions on enumerated inputs. None establishes efficacy of FlyReWheel.

## 6 Evaluation protocol

### 6.1 Selected one-repository three-window pilot

The immediate route is a controlled generated-rule experiment on real PRs, as specified in the [discriminating protocol](discriminating-experiment.md). It does not require a naturally complete old-rule–feedback–update–future record. A reuse opportunity, observed human reuse, feedback-associated code correction, natural rule revision and improved later review remain separate outcomes. Generating rules and feedback in an experiment cannot establish the prevalence or causal effect of historical human rule maintenance.

Select one non-vLLM repository using access, reconstructability and available human expertise, without conditioning on known favorable cases. Freeze a complete PR frame, three chronological windows W0/W1/W2, selection rule, seed where needed, acquisition/annotation budget and stopping condition. The route is selected; repository, dates, counts, people and budget are not yet filled or preregistered. The earlier three-repository 90/180 [Phase 0](phase0-protocol.md) is deferred, and the former one-repository 10/20 two-window sketch is superseded as the immediate design. Neither supplies a completed benchmark or an active numeric gate for this pilot.

In **W0**, generate conditional rules from earlier real repairs using only evidence visible by its cutoff. Freeze the construction procedure, all candidate/failure records, supported rule roster, exact rule bytes and development obligations **before W1 content enters rule construction and before W1 labels are made available**. Rules are generated experimentally, not alleged to have existed in the repository's history.

In **W1**, apply the frozen rules to the middle-window real PR checkpoints using a fixed common reviewer and captured original-input traces. Two independent humans verify the findings, uncertainty and diagnostic cause, with arbitration as needed. Their source-supported TP/FP/unknown records are **experimental feedback** given identically to all updating arms; natural comments are optional evidence, never automatic truth. Freeze feedback, diagnosis and gate obligations before updates, using no W2 information. Retain no-finding and unresolved reviews rather than manufacturing failures.

In **W2**, compare effective post-gate states on separate later real PR checkpoints, with independently frozen issue labels and lineages. At least one still-valid positive and one legal neighbor in independent later lineages are needed for a paired recall/false-alarm comparison. The extraction repair, feedback repair, fixed side, backport and duplicate issue cannot supply these independent targets. Whether enough recurrence exists is still unknown; absent opportunities or denominators are feasibility results, not evidence of zero error.

Enumerate all in-frame PRs and retain all sampled W1/W2 PR × frozen-family pairs, including zero opportunity, no finding, missing checkpoint, unknown, failed and not-run records. Independent inspection cannot be limited to detector/retrieval hits. Report rule yield, feedback yield, recurrence and paired-cohort eligibility against their explicit all-PR/conditional denominators, plus actual annotation cost. Any selected positive/negative stress cohort is conditional and cannot estimate natural all-PR precision. Keep all four developmental vLLM cases and the already-inspected #14352 lineage out of the formal benchmark. Natural maintenance episodes are an optional separate-origin supplement; their absence does not block this route.

### 6.2 Separate history from answers

Targets require a verifiable review-time head and discussion versions available at that time. The final PR head cannot substitute for its first review checkpoint. An edited comment's current body cannot be inserted at its original creation timestamp, and a pending review is not public before submission. Hashes establish byte integrity, not when content was visible.

Keep source chronology and experimental order distinct: the W0 rule-lock time must precede exposure to W1 content/labels, W1 feedback must use evidence available before W2 starts at C1, and W2 labels cannot tune construction, updates or the gate. Record actual construction/lock/exposure times rather than backdating experimental rules. Use isolated code exports with audited allowed heads, disjoint label packages, controlled retrieval and caches, and no online or cross-case answer access. Audit backports, duplicate fixes, and related PRs separately from exact-byte checks. The implemented exporter supplies an input-control mechanism; the researcher still must establish the validity of the allowed-head and event-time declarations. Public-history exposure during model pretraining remains a separate threat.

### 6.3 Falsifiable comparisons

**H1, conditional transfer, retained as a separate future comparison rather than extra arms in the selected H2 pilot.** On independent later instances, explicit applicability and exceptions reduce legal-neighbor false alarms while retaining true-violation detections relative to matched historical memory. Compare no-history review, raw-history retrieval, ordinary summaries, and frozen conditional rules with the same model, visible information, tools, context access, and total budget. Remove applicability and exceptions separately, and include length-matched summaries. H1 is unsupported if its apparent gain vanishes under these controls or is explained by missed positives and increased abstention.

**H2, selective maintenance.** The selected primary paired contrast is H, hard diagnosis-conditioned restrictions, versus U, unrestricted editing under the **same frozen diagnosis**. Both use the same rule representation. M, competent scoped incremental memory, is a required practical baseline with the same initial content, feedback, diagnosis, retrieval envelope and total persistent-state cap; it may retain, revise, qualify or suppress a lesson. F retains the exact initial state. All arms share the reviewer/model configuration, target evidence, resource ceilings and regression obligations; all updating arms share the same gate and one proposal slot, may abstain or request context, and are not forced to mutate. M must not be reduced to passive transcript appending or deprived of context and revision capacity.

Run expert-provided diagnosis O and a shared model-inferred diagnosis I as **separate conditions**, not a pooled end-to-end headline. O tests restrictions under privileged diagnostic supervision. I exposes the common diagnosis-error distribution but still uses human-verified experimental feedback. An unrestricted no-diagnosis arm and a matched H/U no-gate ablation are secondary, separately identified comparisons; neither can replace the same-diagnosis, same-gate primary contrast.

Evaluate every effective state after the gate, including unchanged states resulting from rejection, invalid output, retention, abstention or unfulfilled context requests. Do not discard unsuccessful updates. If H matches an equally informed U or M, it has no demonstrated advantage. If gains come from suppression of still-valid positives or unsupported silence, they do not establish selective maintenance success.

The first claim excludes contract-drift efficacy without verified transitions and executable temporal routing. Obtain judgment-error, missing-original-context and boundary-error strata where supported. Missing strata do not halt feasibility work, but all three are necessary for a broad claim about diagnosis-conditioned action selection. A boundary-only realized cohort supports at most a boundary-field restriction comparison. The current implementation records context requests and retention without executing acquisition or review repair; the experiment must not give it those unimplemented abilities.

### 6.4 Outcomes and decision rules

Report issue-level positive recall, legal-neighbor false alarms, supported negative resolution, repeated feedback-mechanism errors, retained old positives, missed future positives, coverage and scope loss on the frozen roster. Issue precision on a selected adjudicated roster is descriptive, not full-PR precision. Use `not_estimable` for missing positive/negative denominators; never treat unknown or unreviewed code as safe. Report abstention, unsupported targets, execution failures, annotation disagreement, and construction/retrieval/revision/regression/review costs. Separate diagnosis agreement from intervention quality. Keep failed and not-run units in the roster; zero alerts do not establish success. The current exact-anchor scorer can provide descriptive counts, but defensible labels and appropriate uncertainty analysis remain study work.

Choose operating points, cost ceilings, and the acceptable recall-loss margin before examining heldout results. A confirmatory H2 claim requires a reduction in repeated false alarms over the strongest matched memory/rewrite baseline and evidence that recall loss is within that predeclared margin; otherwise report the tradeoff or an inconclusive result. Do not tune those criteria to the developmental example. Analyze paired future PRs with their dependent family/issue groups, not IID anchor counts, and disclose per-repository outcomes and stochastic-run variation. With this pilot, emphasize paired family/episode raw counts, disagreements and feasibility rather than statistical significance. Report the selection funnel from all PRs to eligible feedback episodes and independent later targets, and preserve family/PR/lineage dependence. No numerical margin or powered sample size is frozen in this draft. The latest recorded fresh acquisition is blocked by an unresolved HTTP 403; real authenticated model execution and independent human assignments remain pending. No model call, new data acquisition, annotation contact, upload or paid execution follows merely from choosing this design.

## 7 Related work

**Example-driven analysis rules.** RhoSynth synthesizes static-analysis rules from labeled code examples, including positive/negative pairs derived from developer fixes, and refines rules with additional false-positive examples. Its program-dependence-graph representation supports semantic relationships; describing it as only text-pattern mining would understate the overlap. Historical rule acquisition and counterexample-based refinement are therefore established antecedents. FlyReWheel's proposed comparison concerns diagnosis-constrained interventions for repository review, not the invention of rule learning from repairs. [1]

**Historical obligations for agentic review.** Archer extracts pass-level semantic obligations from compiler correctness fixes and combines repository exploration with executable validation. Its discussion explicitly proposes failed cases plus review outputs as feedback for revising obligations, followed by regression-benchmark checks. This is close overlap with the maintenance direction, although that particular loop is presented as a future direction. A defensible distinction must come from the explicit intervention policy and evidence of its value under matched alternatives; moving to general repositories alone does not establish it. [2]

**Feedback and obsolete practices.** AutoCommenter assesses coding best practices in code review and reports deployment-driven calibration, including conditional suppression for outdated practices. It also cautions that historical review comments provide incomplete correctness labels. Feedback handling and obsolete-rule suppression already have practical precedents, making conservative suppression an essential baseline here. [3]

**Repository memory.** Learning to Commit uses historical commits and supervised contrastive reflection against expert patches to create, revise, and deprecate repository-specific skills for future PR generation, with temporally separated evaluation. It is a work-in-progress preprint with a small preliminary study. Its patch-generation task and oracle-diff supervision differ from incoming-patch review, but maintained repository memory is an immediate conceptual alternative. FlyReWheel must test against memory with the same information, rather than attribute gains from historical access to its rule representation. [4]

These four comparisons delimit close overlap; they are not an exhaustive novelty search. We make no first-of-its-kind claim.

## 8 Threats to validity

**Construct validity.** A rejected finding may reflect priority, duplication, style, or incomplete discussion rather than a false alarm. A changed implementation need not imply a changed contract. The vLLM `if/elif` discussion shows why agreement and branch differences cannot replace mechanism-discriminating evidence. Diagnosis categories may overlap; forced abstention may hide useful interventions. Report these failures rather than forcing binary labels.

**Internal validity.** Later fixes, edited discussions, reachable future objects, answer-bearing filenames, or shared memories can leak outcomes. Unequal repository access, hand-curated diagnoses, longer prompts, or uncounted maintenance calls can favor one arm. Separate natural statements from independent judgments, match information and resources, preserve development/holdout lineages, and retain failed units. Fixture enforcement checks do not remove these risks.

**Conclusion validity.** Several anchors can represent one issue; several PRs can share one repair lineage. Sparse contract episodes and a few repositories do not support broad inference. The chosen historical sample also limits which families could recur. Report denominators and unknowns, distinguish sampling uncertainty from unresolved labels, and avoid turning many function calls or rule × PR pairs into an inflated sample size.

**External validity.** Source-rich public repositories with reconstructable discussions may differ from private projects or sparse histories. The developmental Python validator example does not establish cross-language or cross-domain effects. Its isolated execution omits Pydantic and the full request path. The prototype's bounded evidence selection, unsupported input shapes, unfinished runtime composition, and unverified live backend further limit claims about operational review.

## 9 Conclusion

FlyReWheel makes a specific maintenance choice explicit: feedback should justify a kind of intervention before it authorizes a rule rewrite. The prototype binds that choice to evidence, constrains edits, preserves unresolved outcomes, and prevents selected obligations from disappearing during comparison. The developmental example supports narrow rule boundaries while exposing the danger of treating accepted advice as established correctness. The unanswered question is whether rules generated from earlier real PRs receive useful independently verified experimental feedback and recur on enough separate later PRs, and whether hard restrictions handle those opportunities better than equally informed unrestricted editing and scoped memory. Until that comparison is complete, this work is a mechanism and study proposal with bounded development evidence.

## References

1. Pranav Garg and Srinivasan Sengamedu SHS. [Example-based Synthesis of Static Analysis Rules](https://arxiv.org/abs/2204.08643). RhoSynth, arXiv preprint, 2022. Primary full text: [version 1](https://arxiv.org/html/2204.08643v1).
2. Yunbo Ni and Shaohua Li. [Archer: Towards Agentic Review for Compiler Optimizations](https://arxiv.org/abs/2607.01808). arXiv preprint, 2026. Primary full text: [version 1](https://arxiv.org/html/2607.01808v1), including the maintenance discussion in [Section VI](https://arxiv.org/html/2607.01808v1#S6).
3. Manushree Vijayvergiya et al. [AI-Assisted Assessment of Coding Practices in Modern Code Review](https://doi.org/10.1145/3664646.3665664). AutoCommenter, AIware 2024. Primary author manuscript: [arXiv version 1](https://arxiv.org/html/2405.13565v1).
4. Mo Li, L. H. Xu, Qitai Tan, Ting Cao, and Yunxin Liu. [Learning to Commit: Generating Organic Pull Requests via Online Repository Memory](https://arxiv.org/abs/2603.26664). Work-in-progress arXiv preprint, 2026. Primary full text: [version 1](https://arxiv.org/html/2603.26664v1).
