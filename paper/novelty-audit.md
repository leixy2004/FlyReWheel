# Adversarial novelty audit

**2026-10-02; checkout `2a204ab`.** Source-only research audit of the [manuscript](manuscript-draft.md), [readiness checklist](manuscript-readiness.md), and [implemented revision contract](../docs/rule-revision-generation.md). No model inference, experiment, external write, or publication was performed. This is a targeted novelty search, not a systematic review or a priority certification. Paper citations below refer to the inspected versions, without claiming an accepted venue.

## Bottom line

**Broad novelty is weak.** Learning review knowledge from repairs, refining overbroad rules from feedback, preserving lessons in repository instructions, and gating persistent updates on regression evidence all have direct antecedents. Six additional primary sources materially strengthen the four-source related-work section. Figma's production account is especially close to the proposed application; Scoped-ORC is especially close to the update gate.

The smallest plausible research delta is **the incremental value of an enforced diagnosis-to-edit policy for maintaining a reviewer**, over an equally informed, equally scoped memory/rewrite system with the same regression gate and non-mutation options. That is an untested empirical hypothesis, not a demonstrated novel algorithm. Natural-language diagnosis fields, immutable records, and schema enforcement do not establish causal diagnosis or semantic correctness.

## Eight closest sources

Each card distinguishes the task, information/evidence, update, and evaluated unit. “Not demonstrated” means not established by the inspected source, not proof that the authors never implemented it.

### 1. RhoSynth: counterexample refinement already works beyond syntax

Pranav Garg and Srinivasan Sengamedu SHS, *Example-based Synthesis of Static Analysis Rules*, 2022-04-19, [arXiv v1](https://arxiv.org/html/2204.08643v1). Inspect §§2–4 and §6.4/Table 2.

- **Task/context:** Java code-quality detection, learning first-order rules over program-dependence graphs from developer repairs. Data/control dependencies represent context, not just textual patterns
- **Update/evidence:** Additional non-buggy counterexamples refine rules, including disjunctive postconditions that recognize alternative valid implementations
- **Evaluated:** 31 synthesized rules; eight refinement cases. Table 2 reports macro precision rising from 58% to 97%, estimated from offline labels grouped by rule version, not a chronological future-PR maintenance trial
- **Boundary:** Implemented and evaluated counterexample-based rule refinement. It does not establish FlyReWheel's diagnosis-conditioned choice between changing the rule and repairing its application. “Exceptions learned from false positives” is not a sufficient distinction

### 2. Archer: the review task overlaps; maintenance is explicitly proposed

Yunbo Ni and Shaohua Li, *Archer: Towards Agentic Review for Compiler Optimizations*, 2026-07-02, [arXiv v1](https://arxiv.org/html/2607.01808v1). Inspect §§III–V and §VI.

- **Task/context:** LLVM optimization review, using obligations extracted from historical correctness repairs, repository exploration, and deterministic executable validation
- **Evaluated:** 398 real-world PRs and 47 bisected regression cases; obligations and validation receive ablations. These are review experiments
- **Proposed update:** §VI suggests feeding a failed case and review output back into obligation revision, then checking the regression benchmark. The section frames this as a future direction; no measured maintenance-loop benefit is reported there
- **Boundary:** FlyReWheel may implement a more explicit intervention contract, but should not claim the general historical-obligation/review/feedback/regression loop as new. Conversely, do not describe Archer's proposed loop as an evaluated system result

### 3. Accumulated behavioral rules: concrete scope refinement from review feedback

Aditya Aggarwal and Nahid Farhady Ghalaty, *Self-Improving AI Coding Agents Through Accumulated Behavioral Rules: A Closed-Loop Framework*, 2026-07-13, [arXiv v1](https://arxiv.org/html/2607.13091v1). Inspect §§II-B–F, III-E, IV-A–C, VIII.

- **Task/context:** Persistent coding/self-review instructions derived from accepted review feedback, with scope, rationale, and review-event provenance
- **Update:** An engineer refines existing rules when feedback reveals excessive or insufficient scope. A reported conflict is resolved by qualifying a general disposal rule for factory-created clients
- **Evaluated:** Observational deployment: 11 sessions, nine tracked error classes, 74 post-rule session-exposures. No controlled no-rule comparison
- **Boundary:** “Validation” checks artifact structure and freshness, not behavioral non-regression. This source anticipates scope refinement and provenance, but does not isolate the benefit of a machine-enforced diagnosis/operator mapping

### 4. Figma: production false-positive feedback → policy update → replay

Rohan Sharma, Liam Buchan, and Dave Martin, *How Figma stays ahead of vulnerabilities with agents*, 2026-07-23, [primary engineering report](https://www.figma.com/blog/how-figma-stays-ahead-of-vulnerabilities-with-agents/). Inspect “How we started,” “Metrics,” and both “How we improve the agent” loops.

- **Task/context:** Security PR review using contextual precedents
- **Update:** Dismissed findings trigger transcript-informed policy edits, human review, and baseline replay
- **Evidence/unit:** Live finding ratings and 66 historical vulnerability tasks; the report explicitly disclaims holdout evaluation
- **Boundary:** A production account of the closest application loop, not a controlled study of diagnosis-constrained operators. It also warns about overfitting policy changes to individual bugs

**Access qualification:** Direct opening was robots-blocked. The listed sections were read through indexed excerpts from Figma's own URL; no alternate-host bypass was used. Treat unexposed implementation details as unknown.

### 5. Scoped-ORC: regression-controlled and scoped persistent updates

Yezhou Cheng et al., *Scope Before You Persist: Preventing Cross-Family Interference in Agent Memory*, 2026-09-24, [arXiv v1](https://arxiv.org/html/2609.29144v1). Inspect §§3.2–5, 6, 8 and Appendix C.

- **Task/context:** Frozen-model code repair on procedurally generated recurring contract families; natural-language skill edits
- **Update/evidence:** Incumbent/candidate paired probes combine public examples, private tests, and metamorphic checks; historical groups must satisfy non-regression constraints. Accepted skills are retrieved by family
- **Evaluated:** Complete streams, including a 27-stream, 12-round extension and a fixed-proposal scope intervention
- **Boundary:** Implemented gate and scope experiments, not just a design suggestion. Real repository rule extraction, reviewer-feedback diagnosis, open-world routing, and automatically learned invariants are outside the demonstrated result. The matching gate/scoping baseline belongs in FlyReWheel's comparison

### 6. ACE: localized memory updates and retention are established alternatives

Qizheng Zhang et al., *Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models*, 2025-10-06, [arXiv v1](https://arxiv.org/html/2510.04618v1). Inspect §§3.1–3.2, 4.1–4.2, 4.5, 5.

- **Task/context:** Evolving agent/domain playbooks from trajectories, outcomes, and execution feedback
- **Update:** Separate generation, reflection, and curation; localized delta entries, deterministic merging, helpful/harmful counters, and redundancy pruning, rather than repeatedly replacing the entire memory
- **Evaluated:** AppWorld task/scenario completion and FiNER/Formula answers; online predictions precede updates on each sample. Components receive ablations
- **Boundary:** No repository-review diagnosis/operator study or per-update historical-obligation gate is established in the inspected version. Selective unlearning of obsolete knowledge is discussed as future work. Compare against a competent incremental memory baseline; unrestricted whole-document rewriting alone is too weak

### 7. Codex custom review rules: conditional repository guidance already evaluated

Hari Srikanth, *Custom Code Review rules for Codex*, 2026-07-20, [official product engineering post](https://developers.openai.com/blog/custom-code-review-rules-for-codex). Inspect “Writing rules that hold up” and “Getting started.”

- **Task/context:** Incoming PR review guided by root/nested repository instruction files, including local invariants, safe alternatives, and applicability scope
- **Update:** Human refinement, narrowing, or removal when guidance creates noise; no autonomous historical rule-induction algorithm is established by the post
- **Evaluated:** A reported suite includes violations, safe counterexamples, unrelated bugs, and competing rules. Required custom-finding recovery is reported as 98% versus 58.3%; sample size and full reproducible protocol are not supplied there
- **Boundary:** Product evidence, not a peer-reviewed or independently replicated effect estimate. It weakens novelty based only on conditional rule representation or positive/negative review tests; it does not resolve the maintenance-policy hypothesis

### 8. ErrorProbe: diagnosis memories already use verified-before-write selection

Jiazheng Li, Emine Yilmaz, Bei Chen, and Dieu-Thu Le, *Towards Self-Improving Error Diagnosis in Multi-Agent Systems*, 2026-04-19, [arXiv v1](https://arxiv.org/html/2604.17658v1). Inspect §§4.3–4.4/Algorithm 1, 5, 6.1/Table 2, and limitations.

- **Task/context:** Identify the responsible agent and decisive step in failed multi-agent traces using backward tracing and structural failure signatures
- **Update/evidence:** Admit diagnostic patterns only with tool-grounded reproduction and sufficient confidence; retain context signatures and verification guards for selective retrieval
- **Evaluated:** Agent/step attribution on TracerTraj and Who&When, plus memory-on/off comparisons on coding/math failure traces
- **Boundary:** Evidence-conditioned retention and diagnosis before memory writes are established here. It does not evaluate repository-review rule replacement or preserving old review positives. Executable confirmation differs importantly from FlyReWheel's structurally checked but unverified diagnosis proposals

The manuscript's AutoCommenter and Learning to Commit comparisons remain relevant. They were not re-audited in depth here; these eight cards prioritize the additional threats and two necessary anchors rather than expanding a generic bibliography.

## What is left to claim

| Candidate claim | Audit judgment |
| --- | --- |
| Historical repairs yield reusable review rules | Established antecedent; not the delta |
| Applicability/exception fields reduce overgeneralization | Familiar representation and product practice; possible task-specific result, not a priority claim |
| False-positive feedback should refine persistent knowledge | Direct prior implementations |
| Diagnose failures before updating memory | Direct adjacent prior work; diagnosis text alone is insufficient |
| Scope updates and preserve regression obligations | Direct adjacent implemented/evaluated antecedent |
| Contract drift is handled | Unsupported now: declarations and supersession do not establish valid historical/current routing |
| Enforced diagnosis-conditioned editing outperforms equally informed selective memory | Plausible narrow hypothesis; presently untested |

**Recommended question:** Under identical evidence, retrieval scope, budgets, and regression tests, when does preventing invariant edits after boundary feedback improve later review, and when does it block necessary correction?

Keep the first causal claim at **boundary edits versus retaining a still-valid rule after a mistaken application**. Include missing-context outcomes as a separate stratum if they can be adjudicated. Contract replacement adds a much harder temporal oracle and routing problem; omit efficacy claims about it until those exist. Repository generality alone is not a mechanism contribution.

The policy's field restrictions are an inductive bias, not semantic minimality: a large applicability rewrite can be more destructive than a small invariant correction. An incorrect diagnosis can therefore make hard restrictions harmful. That possibility is the scientific test, not an implementation defect to hide with abstention.

## Smallest informative falsification experiment

**Disposition update, 2026-10-02:** the [selected three-window pilot](discriminating-experiment.md) supersedes this eight-family sketch as the immediate assembly route. Generate and freeze W0 rules from early real PRs before W1 exposure, human-verify actual W1 findings as experimental feedback, then compare independent W2 outcomes. Natural rule-maintenance histories are optional. The 4/2/2 allocation and per-family counts below remain unexecuted historical stress-test targets, not active prerequisites, an acquired sample or a power calculation. The controller comparison and falsification logic remain relevant; supported strata determine the claim.

### Historical eight-family case targets

1. Seek eight independent non-developmental rule families: four supported overbroad-boundary episodes, two mistaken-application episodes with a still-valid rule, and two missing-context episodes. These quotas select a diagnostic stress test, not a prevalence estimate
2. Each episode needs a frozen pre-feedback rule, as-of feedback/evidence, at least one established positive to preserve, and separate later issue lineages containing both true violations and legal neighbors. A practical minimum target is two of each later type per family; report family-level dependence rather than treating 32 outcomes as IID
3. Two independent adjudicators establish the applicable contract, issue labels, and diagnosis before method outputs. If this cannot be obtained, report single-author feasibility instead. If rules or feedback are researcher-constructed, label the experiment controlled reconstruction, not natural human rule maintenance
4. Freeze rosters, source availability, prompts, costs, repetitions, and stopping interpretation before outputs. Keep all failures/unknowns. Exclude vLLM developmental lineages and duplicate/backport issue lineages

Eight families cannot establish a population effect. They can reveal a failure of the proposed mechanism and whether qualifying episodes are practically obtainable. Do not compensate for missing families with more anchors from one repair.

### Isolate the controller rather than historical access

Run the same reviewer with these maintenance policies:

- Frozen rule: no update
- Scoped incremental feedback memory: structured local lessons and non-mutation options
- Diagnosis plus unrestricted rule editing
- The same diagnosis plus hard operator restrictions

All updating arms receive the same raw feedback, declared TP/FP supervision if used, selected code/context, past obligations, retrieval scope, and **the same regression acceptance gate**. All may retain, abstain, or request context; otherwise the control is artificially forced to rewrite. Use the same total budget including rejected proposals, review replays, and maintenance. Requests for context are measured as unresolved until acquisition actually happens; equal evidence access must be preserved.

First compare free versus constrained editing under **the same adjudicated diagnosis** to test whether restrictions can help at all. Then repeat with the same model-proposed diagnosis to expose classification error. These are provided/oracle and inferred-diagnosis conditions respectively; the inferred condition still uses human-verified experimental feedback and is not a fully autonomous end-to-end result. The baseline gate and frozen-policy controls separate the value of operator restrictions from ordinary selection. A no-gate ablation is secondary, not the main novelty comparison.

### Falsifying outcomes and decision boundary

- If scoped incremental memory or diagnosed unrestricted editing has no worse heldout false alarms, retained positives, coverage, and cost, this pilot provides no reason to favor the extra controller
- If apparent precision improvement comes from abstention, path exclusion, or suppressing still-valid positives, do not count it as selective maintenance success
- If restrictions help only with oracle diagnoses, claim a supervised intervention effect at most, not a working diagnosis system
- If all episodes are boundary errors, the test says nothing about diagnosis-based action selection; it tests only a restricted edit space
- If even the small roster cannot be reconstructed, stop expanding the efficacy narrative. Deliver a bounded prototype/feasibility study or investigate conditional transfer separately

For a later confirmatory study, predeclare a practically meaningful false-alarm improvement, a recall-loss margin, and cost ceiling; size the study from pilot variability. A nonsignificant small-pilot result is not evidence of equivalence. Report paired family-level outcomes and the actual lost/gained cases before aggregate rates.

## Immediate manuscript changes recommended

1. Add the Figma report, accumulated-rule scope refinement, and Scoped-ORC as closest comparisons, with their evidence limits
2. Require competent scoped incremental memory plus the same gate; under the selected protocol, equally diagnosed unrestricted editing is the primary mechanistic comparator, not merely an ablation
3. Separate oracle diagnosis, inferred diagnosis, operator restriction, and regression-gate effects
4. Keep contract-change handling as an implementation boundary/future test, not a demonstrated concept-drift solution
5. Do not promote “first,” “minimal edit,” “causal diagnosis,” or “effective maintenance” claims from fixture tests or the developmental example

**Stopping conclusion:** The paper's current cautious mechanism-and-study framing survives. Its efficacy and novelty case is not yet established; adding more infrastructure without the matched causal comparison will not establish it.
