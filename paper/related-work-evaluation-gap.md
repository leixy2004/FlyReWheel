# Primary-source related-work and evaluation gap audit

2026-10-04; paper base `17879c170b7ba6bdbbe86a5c977a9b4de88da386`.
Targeted primary-source audit, not a systematic search, priority certification or
benchmark execution. Two independent agents reviewed literature and evaluation;
source metadata and exact official-repository README hashes are in
[primary-source-availability.json](primary-source-availability.json).

## What remains a hypothesis

The sequence historical rule mining → review → feedback → persistent update is not
by itself a defensible novelty claim. RhoSynth covers example-driven rule synthesis
and counterexamples; Archer covers repair-derived review obligations and proposes
maintenance; AutoCommenter covers practical review calibration; repository memory,
reflection and scoped regression gates have antecedents. Their different tasks do
not erase the overlap. The narrow candidate contribution is whether **enforced
constraints on the permitted edit, conditional on the same diagnosis**, outperform
unrestricted edits and competent scoped memory on independent later review cases.
This is unmeasured. Structural validation does not establish correct diagnosis.

Three claims require separate evidence: H1, useful transfer from W0 history; H2,
maintenance quality after W1 feedback; H3, repeated streaming adaptation. The current
one-update F/U/H/M design addresses H2 only. Neither a successful export/checkpoint
nor one feedback episode establishes H1 yield, H3, contract-drift efficacy or improved
developer outcomes. Public baseline results are not FlyReWheel results.

## Five baseline families and actual readiness

Verified public implementations linked below are **available for inspection**, not
installed or verified to run here; other rows explicitly mark unconfirmed resources. Same-model internal controls are necessary for
causal attribution; separately trained models are external task references. No
baseline execution is authorized by this document.

| Family and role | Verified source and exact availability | Required adaptation and leakage control |
| --- | --- | --- |
| **1. Stateless / repository-context reviewer**: no-history H1 control; optional external CodeReviewer | [CodeReviewer v2](https://arxiv.org/abs/2203.09095v2); official [code and task scripts](https://github.com/microsoft/CodeBERT/tree/c0de43d3aaf38e89290f1efb771f8de845e7a489/CodeReviewer), [model card](https://huggingface.co/microsoft/codereviewer), [Zenodo data record](https://zenodo.org/records/6900648). Quality estimation, comment generation and refinement are different targets. | Implement no-history with the common reviewer for H1; do not attribute a cross-model CodeReviewer difference to rule memory. Its released comments/refinements are not an exhaustive defect oracle. Never put reference comment or corrected target into review input. |
| **2. Frozen historical knowledge F**: no-maintenance control | [RhoSynth](https://www.amazon.science/publications/synthesizing-code-quality-rules-from-examples) is example-based rule synthesis, not merely text patterns. No public implementation/data confirmed in inspected author sources. [Archer v1](https://arxiv.org/html/2607.01808v1) has [official source/dataset directory](https://github.com/cuhk-s3/Archer/tree/05b2fcfa9336de0e449f362009820ed558f2fad3); `main.py`, `repro.py`, LLVM/Alive2/llubi setup. Its §VI maintenance loop is proposed, not evaluated. | Local F freezes the same initial content as H/U/M; it is not a reproduction of either system. Archer's compiler obligations/validators do not transfer automatically to HTTPX. Use W0-only retrieval; final fixes and later obligations must not enter target inputs or gate. |
| **3. Feedback-guided unrestricted rewriting U**: H2 mechanism control | [Self-Refine v2](https://arxiv.org/abs/2303.17651v2), [official implementation and task data](https://github.com/madaan/self-refine/tree/9a206d41e5d2d0c241bb441f41eeadb945afaa55). Original method iterates generated feedback and refinement. | U shares the frozen diagnosis, evidence, rule format, one proposal slot and gate with H. Call it a controlled feedback-rewrite adaptation, not original Self-Refine: shared external diagnosis and one step change the method. No hidden oracle feedback or extra retries. |
| **4. Scoped incremental memory M**: required practical comparator | [ACE v1](https://arxiv.org/html/2510.04618v1), [official implementation](https://github.com/ace-agent/ace/tree/82709de050e1db6e6ef2f07bcb0393560b94992a): `ACE.run`, finance entrypoint, offline/online/eval-only modes, task processor extension. [Reflexion v4](https://arxiv.org/abs/2303.11366v4) and [official task scripts/logs](https://github.com/noahshinn/reflexion/tree/218cf0ef1df84b05ce379dd4a8e47f17766733a0) provide an episodic-reflection alternative. | Review adapters, scopes and deletion/qualification policy are unimplemented research work. M must edit/suppress/retrieve rather than passively append. Calibrate competence on W1 within matched total budgets; label the constrained adaptation honestly. W2 labels must never enter online reflection/curation, cache or playbook selection. |
| **5. Conservative retain/suppress control**: tests whether silence explains gains | [AutoCommenter](https://arxiv.org/html/2405.13565v1), §§3.3, 4.2–4.3, reports deployed review calibration and conditional filtering of obsolete practices. Complete production code/internal data/model not confirmed public. | Implement a declared local retain/suppress-only policy on the same W1 feedback; do not name it an AutoCommenter reproduction. Prespecify thresholds on development data. Count lost positives, coverage and suppression scope: fewer alerts alone is not maintenance success. |

H versus U remains the primary mechanism contrast; M is the required practical
comparison, F is the maintenance reference. Families 1 and 5 need not inflate the
first feasibility run: family 1 belongs to H1, family 5 is a prespecified diagnostic
if suppression explains results. Do not choose whichever baseline looks weakest.
Unused compute for F is reported as lower actual cost, not silently spent on extra
review attempts; equal ceilings do not imply equal consumed compute.

[Scoped-ORC v1](https://arxiv.org/html/2609.29144v1) evaluates scope-matched retrieval
and regression-controlled skill updates on generated code-repair streams. It is
close methodological prior work; the paper describes supplemental code, but this
audit did not locate a public author repository. A scope/gate ablation is justified,
while a claim to have reproduced Scoped-ORC is not. [Learning to Commit v1](https://arxiv.org/html/2603.26664v1)
uses repository memory for future PR generation in an internal-repository pilot;
public runnable code/internal data were not confirmed. It supports conceptual
overlap, not an immediately executable reviewer comparison.

## What public benchmarks do and do not supply

**SWE-PRBench.** The [paper v1](https://arxiv.org/html/2603.26130v1) describes 350 PRs,
with reported experiments on 100, historical review-comment references and an LLM
judge. The [official harness](https://github.com/FoundryHQ-AI/swe-prbench/tree/379f0bfd8978a1734cd8399e115d04d4fdceeb89)
exposes `eval_harness/run_eval.py`, `RUBRIC.md` and pipeline `v0.4.1`; the
[data card](https://huggingface.co/datasets/foundry-ai/swe-prbench/blob/main/README.md)
is separately hosted. These are useful context/scoring comparators, not independently
enumerated missing-defect labels or a W0/W1/W2 rule-maintenance chain. The paper
acknowledges judge variation, no measured human baseline, and residual pretraining
contamination. Neither its reported context trend nor human-recall extrapolation is
adopted as a general law here. Corpus files were not downloaded or inspected.

**SWE-bench.** The [original paper](https://arxiv.org/abs/2310.06770) and
[official harness](https://github.com/SWE-bench/SWE-bench/tree/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e)
provide issue-to-patch, test-based evaluation. Repair success is not review accuracy
or selective rule maintenance. Gold patches/tests are answer material; feeding them
into rule updates while scoring the same lineage would confound transfer. Public
history can be memorized, even when the experiment uses chronological windows.
The review task still needs independent issue/negative-opportunity annotation.

**CodeReviewer data.** The official release supports the three stated tasks; a
review-comment-generation score cannot certify actionable violations, safe cases,
or later maintenance. Reference text overlap and corrected-code exposure must be
separated from review input. No external benchmark is substituted for the frozen
HTTPX frame or used to invent its missing labels.

## Concrete gaps to close before a maintenance claim

1. **Freeze the claim hierarchy.** The annotation protocol's positive-detection
   contrast is a reference-set/feasibility measurement, not a replacement for H2's
   H−U repeated-false-alarm contrast with a recall-loss guard. For H2 define the
   primary signed difference as H minus U in the fraction of independently labeled
   W2 mechanism-relevant legal opportunities L_mech receiving a repeated
   feedback-mechanism false alert. L_mech is the prespecified subset of legal
   neighbors exhibiting that mechanism, never selected from observed arm failures.
   Negative favors H. Freeze mechanism identity/matching before outputs. Also
   prespecify a noninferiority margin for H−U known-positive detection; neither
   margin nor operating threshold has been justified numerically yet. Empty
   legal/positive denominators are not estimable. Use the existing protocol macro-average: equal weight across independent families,
   average episodes/repetitions within family; retain nonestimable episodes and
   show their counts rather than silently drop them. Strong M uses the same endpoints; beating U alone does not establish practical superiority. Require non-degrading
   strict resolution on L_mech and report its coverage/unresolved mass: selectively
   timing out or abstaining on legal cases cannot count as maintenance success.
   Confirmatory uncertainty rules for these safeguards must be frozen as well.
2. **Use the correct time claim.** Default to retrospective current-capture frozen
   heads; historical replay additionally needs archived public-event visibility.
   Merge times, merge-base and object closure prove neither historical exposure nor
   absence of pretraining. Target-side positive labels concern remaining violations,
   not repaired-before-head defects. Keep W0 outcomes out of supposed holdout.
3. **Prevent gate and baseline leakage.** No W2-derived obligation, prompt/example,
   memory entry or stopping decision. Match retrieval scope, labels, diagnosis and
   gate, and count construction/reflection/retrieval costs. Probe M competence
   before W2; never claim equality to an original algorithm after truncating it.
4. **Preserve denominators and dependence.** Retain unknown, no-family, zero-yield,
   no-finding, failed/not-run and suppressed cases. Multiple issues nest within
   PR/lineage; six exports are three PRs, not six trials. A fixed 19-row census
   supports conditional description, not an arbitrary powered claim. Two independent
   humans plus adjudication remain unassigned. Existing reference schemas suffice;
   use the procedure sidecar for exposure/coverage rather than fabricate instances.
5. **Keep execution separate from science.** Six real exports and blocked bridge
   reopening demonstrate provenance/persistence. No materialized rule families,
   human reference labels or eligible native episode exists. The staged 2.75/18/26
   person-hour options remain proposals; H2 needs actual feedback and later legal
   as well as positive opportunities, not merely calibration completion.

## Claim corrections and independent critique disposition

The existing manuscript's Archer distinction is supported; broad “first temporal
feedback rule system” language is not. RhoSynth's journal title differs from its
arXiv title; CodeReviewer v2 differs from its v1/README title. Cite exact inspected
versions. Do not equate a missing link with proof that code does not exist.

The literature auditor independently checked CodeReviewer, RhoSynth, AutoCommenter,
Archer and Learning to Commit. The evaluation auditor checked ACE, Reflexion,
Self-Refine, Scoped-ORC and benchmark/estimand fit. Their central objections—H2 versus
annotation-metric drift, baseline adaptation versus reproduction, and lack of a
ready temporal reference chain—are incorporated above and in the manuscript and
protocol. This is protocol/literature critique, not human annotation or replication.
