# Manuscript readiness and open research decisions

Companion to [the integrated manuscript draft](manuscript-draft.md). Production implementation notes remain anchored to `fa601ee`; the selected study route was reconciled at checkout `250a242` on 2026-10-02, and authored-fixture runner readiness at `9e4f4a6`. This checklist reconciles those historical checkpoints with the current-capture protocol, source native CLI and [converged application](../docs/converged-application-2026-10-04.md); older verification results remain scoped to their original commits. This checklist is authoring support, not empirical evidence or preregistration. The manuscript is Markdown because the repository has no paper-specific LaTeX build convention. Earlier papers, protocols, captures, and source files are retained.

## The decision that matters most

The route is chosen: **one repository, W0-generated experimental rules, W1 human-verified experimental feedback on real PRs, and independent W2 later-PR evaluation**. Compare frozen state F, unrestricted edits U, hard restrictions H and competent scoped memory M with matched models/evidence/budgets and the same gate; report expert-provided and shared inferred diagnoses separately. The [discriminating protocol](discriminating-experiment.md) is authoritative for this route. Naturally complete maintenance histories are optional supplementary evidence, not a gate.

The open empirical question is whether W0 rules yield defensible W1 feedback and recur on enough independent W2 positives/legal neighbors to measure policy differences. This remains unknown. The HTTPX metadata frame is frozen at 70 PRs (W0/W1/W2: 38/13/19); three exposed W0 packages and six verified exports are development inputs, not eligible maintenance episodes or six independent trials. The [annotation protocol](../experiments/temporal-pilot/w0-first-three/evaluation-preparation/ANNOTATION-TEMPORAL-PROTOCOL.md) proposes retrospective current-capture evaluation. This metadata frame is not a complete experimental freeze or preregistration: substantive rules, independent labels, execution settings and margins remain unresolved.

## Before this can become an empirical paper

- [ ] Choose a target venue and paper type. The present artifact is a coherent mechanism-and-study draft, not a completed efficacy paper
- [x] Select the one-repository three-window generated-rule route; defer the 90/180 natural-opportunity study and supersede the former 10/20 two-window immediate-pilot sketch
- [x] Record the existing HTTPX metadata frame and its W0/W1/W2 counts; retain its capture/provenance limits
- [ ] Freeze the actual eligible episode roster, rule/family selection, seed where applicable, execution budget and stopping condition before formal outcome inspection. The proposed W2 census and staged feasibility budgets do not establish labels, assigned personnel or a complete study freeze
- [ ] Freeze the W0 generation procedure, complete rule/failure roster, exact initial texts and provenance before middle-window content/labels enter rule construction. Preserve source chronology separately from actual experimental generation/lock/exposure times; historical-public-visibility proof is additional only for an optional as-of claim
- [ ] Recruit two independent annotators and an arbitrator, or explicitly keep the work single-author feasibility analysis. No model or assistant substitutes for the second human
- [ ] For the default current-capture study, freeze proposed-head snapshots, evidence allowlists and changed-code scope without claiming historical visibility. Keep developmental vLLM lineages out of evaluation
- [ ] Only if an as-of subanalysis is chosen, reconstruct actual historical code/discussion checkpoints and independently verify visibility. Missing historical proof blocks that subanalysis, not a correctly labeled current-capture design
- [ ] Run the fixed common W1 reviewer only after data/model execution is authorized; save original inputs and actual findings, then independently verify experimental feedback. Keep unsupported/no-finding cases and label provenance
- [ ] Establish W2 independent issue lineages and a defensible oracle, including still-valid positives and legal neighbors. Exclude W0/W1/gate repair lineages, duplicates and backports. Natural old/new rule records are not required
- [ ] Retain all in-frame and sampled PRs and W1/W2 PR × family pairs, including zero opportunities, no findings, access failures, unknown labels and not-run units. Report the all-PR selection funnel and conditional effect-cohort denominators; do not infer recurrence from selected positives
- [ ] Obtain the specific model/backend setup and execution authorization still needed, then make the real semantic-v2 execution path operational without weakening gates. Current authored SDK results do not establish real inference; choosing this protocol does not approve authentication, upload or API charges
- [ ] Freeze matched baselines, prompt/configuration versions, total cost limits, recall-loss margin, repetitions, and paired uncertainty analysis before heldout outputs. Measure diagnosis and intervention effects separately
- [ ] Restrict claims to the diagnostic strata actually supported. A boundary-only cohort cannot establish cross-category diagnosis-conditioned action selection. Contract-drift efficacy remains excluded without actual transitions and valid context/time routing
- [ ] Re-audit current implementation and citations at the exact experimental commit; expand related work before making a novelty or submission claim

## Reconciliation with earlier draft notes

The earlier [method draft](method-draft.md) and [claim checklist](claim-evidence-checklist.md) retain useful research boundaries, but parts describe earlier implementation checkpoints. The integrated manuscript uses current contracts for these corrections:

| Earlier capability statement | Scope at `fa601ee` | Continuing limit |
| --- | --- | --- |
| Unchanged-file evidence is unavailable | Explicit, exact-head repository-context packages can supply supporting citations; context-aware revision carries selected cited excerpts | Selection remains bounded and incomplete; findings/coverage stay on captured changed entries; revision remains no-tools |
| Only all-local-refs execution exists | Optional exact allowed-head closure export and workspace admission are implemented | Default remains all-local-refs; historical-visibility evidence is additionally required only for an as-of claim, while current-capture exports still require exact identity and exposure controls |
| No rule retirement or selection exists | Explicit local experimental governance implements selection, suspend, retire, supersede, and governed review admission | It does not infer semantic applicability timelines, validate a contract change, or activate production rules |
| A scope exclusion cannot score a selected false-positive correction | Opt-in v5 permits a separately evidenced, exact selected-finding non-applicability claim | Exclusion alone never establishes correction; lost positives block acceptance; whole-file negative/fixed cases remain inconclusive |

Sources: [repository context](../docs/repository-context.md), [revision generation](../docs/rule-revision-generation.md), [evaluation workspaces](../docs/evaluation-workspaces.md), [local governance](../docs/semantic-rule-governance.md), [governed review](../docs/governed-semantic-reviews.md), [scope applicability](../docs/local-revision-comparisons.md#explicit-applicability-for-literal-path-revisions).

## Claims retained at their proper strength

- The vLLM result is an actual isolated function-body reproduction with 35 authored inputs and four versions/variants. It is not a benchmark, independent-case collection, upstream-test result, or reviewer comparison
- The two `if/elif` variants are counterfactuals. The nested variant reuses the final suffix; the complete early historical function has not been recovered
- New evidence invalidates overbroad local behavior summaries; it does not validate a universal API contract, rule extraction quality, or feedback-driven learning
- Fixture suites support the implementation properties each recorded checkpoint tested. They do not support measured false-alarm reduction, preserved recall, diagnosis truth, or scientific novelty
- RhoSynth already refines rules using counterexamples; Archer explicitly proposes feedback-driven obligation revisions and regression checks. Historical repairs, feedback, and the loop cannot carry the novelty argument on their own

## Execution blockers and local work

- The old vLLM HTTP 403/zero-capture attempt is historical evidence, not the latest capture state. HTTPX now has a 70-row metadata frame, three W0 source packages and six exports. These are not complete W1/W2 content, independent annotations or a materialized rule family
- The source CLI exposes `evaluation native init-authored`, `init-w0` and `run` ([offline guide](../docs/offline-reproducibility.md)). Authored execution and frozen real-W0 blocked records can be persisted and reopened. A real current-capture W0 review still requires eligible task semantics, trusted runtime/model configuration, resource authorization and independent labels for evaluation; historical visibility is not its default gate
- Trusted authenticated model/backend execution and exact resource limits remain unestablished; no model call or paid execution is authorized by the study-route decision
- Two independent annotators and an arbitrator remain unassigned and uncontacted
- The [matched F/U/H/M runner](../experiments/matched-revision/README.md) now exercises shared supplied diagnoses, neutral proposals, U/M validators and a local-delta memory/common-gate interface with authored fixtures. Production real-model execution remains unconfigured, memory-baseline competence unverified, and empirical episodes and independent human annotations both zero

Local work can validate the existing frame and exposure records, prepare prompts and annotation instructions, and audit lineages and hashes. The [legacy/native macro reporters](../experiments/matched-revision/native-macro-report.md) provide authored descriptive aggregation with missingness retained and empirical intervals withheld; they do not supply real episodes or labels. The four-case annotation packet remains development/training only even if humans later complete it. Its labels cannot become formal benchmark outcomes.

## Scope of this revision

This reconciliation changes documentation only. It does not change implementation, raw evidence, labels or dependencies, and performs no authentication, model execution, acquisition, annotator contact, upload or publication. Implementation statements retain their cited checkpoints. Local document/schema/packet checks are distinct from software-runtime or scientific validation.
