# A paired test of diagnosis conditioned edit restrictions

**Selected research route, revised 2026-10-02 at checkout `250a242`; authored-fixture runner status reconciled at `9e4f4a6`. Execution specification not yet frozen or preregistered; no new cases, labels, model outputs, or effects.** The chosen next study is a one-repository, three-window experiment with rules generated from earlier real PRs and human-verified experimental feedback from middle-window real PRs. This replaces the earlier requirement to find naturally complete maintenance histories before testing the policy. Earlier sampling proposals are retained as history with their disposition in §10. The accompanying [templates](experiment-protocol/prompts.md) and [record schema](experiment-protocol/record.schema.json) remain research specifications; the separate [local matched-runner fixture slice](../experiments/matched-revision/README.md) implements authored mechanics only.

**Configuration amendment, 2026-10-02:** the [SDK-native draft profile](experiment-protocol/sdk-native-study-amendment.md) addresses SDK 0.159.2's unavailable typed temperature, generation-seed and output-token controls without claiming determinism or an enforced spend cap. It proposes supported native settings, byte/time/call ceilings and repeated randomized blocks under a new version. It does not alter the current schema/runtime or complete an empirical freeze; the existing mandatory-control path remains fail closed. Its adoption/disposition section identifies exactly which configuration assumptions below would be replaced.

## Decision

Test **hard edit restrictions versus unrestricted edits under the identical frozen diagnosis and regression gate**. Add a competent scoped incremental-memory comparator with that same information and gate. Do not compare a constrained, tested updater with an untested or forced-to-rewrite baseline and attribute the difference to diagnosis.

Build the prior rule inside the experiment instead of requiring a historical developer-authored rule. Generate it using only the early window, freeze it **before opening middle-window labels or using middle-window findings to redesign it**, apply it to middle-window PRs, and have independent humans verify the resulting findings and feedback. Compare the resulting states on separate later PRs. Real PRs provide the source evidence; rule generation, review findings, and feedback are experimental interventions with explicit provenance. A naturally documented rule–feedback–update chain is optional supplementary evidence, never a prerequisite for this chosen route. The current four developmental cases remain training/packaging material and cannot enter the formal benchmark.

The experiment can fail usefully. Restrictions may prevent damaging invariant edits, make no difference after the shared gate, or block a helpful change after a wrong diagnosis. All are admissible outcomes. There is presently no evidence selecting among them.

## 2026-10-04 evidence and claim reconciliation

The [primary-source audit](related-work-evaluation-gap.md) supplies five baseline
families with pinned official implementation availability. F/U/H/M remains the
mechanism design. U and M are controlled adaptations, not claimed reproductions of
Self-Refine or ACE; validate memory competence on development data before W2.

The newer [annotation protocol](../experiments/temporal-pilot/w0-first-three/evaluation-preparation/ANNOTATION-TEMPORAL-PROTOCOL.md)
uses a retrospective current-capture default. That default supersedes the historical
visibility prerequisites below **for the declared current-capture study**. Keep all
experimental lock/exposure ordering; apply historical cutoff rules below only to
an explicitly declared as-of subanalysis with event evidence. HTTPX's existing
70-row frame (38/13/19), three exposed W0 cases and six verified exports supersede
the earlier unfilled-repository/403 status. They supply no labels or eligible episodes.

For H2, retain H−U as the mechanism contrast. The primary endpoint is the fraction
of independently labeled later mechanism-relevant legal opportunities L_mech with
a repeated feedback-mechanism false alert; L_mech is the prespecified subset of L
in §7, never selected from arm failures; report H minus U (negative favors H), with a prespecified noninferiority
margin on known-positive detection H minus U. M uses the same endpoints. The
annotation protocol's detection contrast measures reference-set/feasibility behavior
and does not replace this maintenance claim. Freeze mechanism matching and
scientifically justified margins before outputs; use §7 equal-family macro-averaging
and show nonestimable episodes. Require non-degrading strict resolution on L_mech
and report coverage/unresolved mass, so selective silence cannot masquerade as
maintenance success; currently no numerical margin or
powered size exists. An empty denominator stays not estimable. These clarifications
are a dated prospective design proposal, not a completed protocol freeze.

## 1 Question and estimand

Conditional on the eligible episode roster, fixed reviewer and revision models, evidence packages, retrieval scope, resource limits, and acceptance gate, what changes in later review when a diagnosis **enforces** an edit permission rather than merely informs the updater?

The primary paired contrast is hard restriction H minus unrestricted editing U. The same revision output representation is used in these two arms; the intentional difference is the diagnosis-to-permitted-action/field constraint and its enforcement. This estimates the enforced policy with its communicated permissions, not the validator's effect independently of its instructions; that narrower question would need a soft-policy instruction control. H versus scoped memory M is a required practical comparator, but additionally changes the persistent representation and therefore does not by itself isolate the hard controller. Frozen state F is a no-maintenance reference.

Estimate effects separately under an expert-provided diagnosis O and a model-inferred diagnosis I. Never pool them into an end-to-end headline. Even I remains conditional on whatever authenticated or adjudicated TP/FP feedback supervision the experiment supplied. Neither condition establishes autonomous extraction of trustworthy labels from ordinary review discussion.

This is a one-feedback-episode, later-transfer experiment within a selected repository and frozen rule set. It does not estimate long-run streaming adaptation, prevalence of natural rule maintenance, or contract-drift handling. Whether real later PRs contain enough relevant instances is still unknown; creating experimental feedback does not create recurrence or guarantee a measurable effect.

## 2 Selected construction and eligibility

### Three chronological windows and two clocks

Choose one non-developmental, non-vLLM repository for source access, relevant human expertise, and feasible annotation cost, not known favorable outcomes. Freeze one complete PR frame, a time-based or probability-sampling rule, window cutoffs, inclusion rules, acquisition/annotation budget, and stopping condition before looking for successes. Repository, dates, counts, seed, people, models, and cost ceilings remain unfilled execution fields; the **route** is chosen, not a claimed registration. Do not silently reuse the old two-window 10/20 or 90/180 counts.

| Window | Permitted work and evidence | Lock before proceeding |
| --- | --- | --- |
| W0 rule construction, ending C0 | Earlier real PR repairs and only their code/discussion/contract evidence verifiably visible before C0. A declared human/model construction procedure proposes rules and development obligations without W1/W2 access | Rule-family roster, exact initial texts, source inputs, construction procedure/configuration and outputs, generation failures, and digests, before W1 is opened to rule construction or its labels are produced/released |
| W1 feedback, C0 to C1 | Apply the frozen W0 rules to real middle-window review checkpoints with a common fixed reviewer; preserve exact inputs, outputs, failures and coverage. Independent humans verify findings and issue truth from permitted W1 evidence and produce explicitly experimental TP/FP/unknown feedback and reference diagnoses | Middle finding/label roster, both human judgments and arbitration, feedback, shared revision evidence, diagnoses, and development gate before policy proposals; no W2 information may enter this stage |
| W2 evaluation, C1 to C2 | Review later real PR checkpoints using F/U/H/M effective states, each under the same as-of target evidence and budget. Independent source assembly and annotation establish later positives, legal neighbors, and unknowns | Target PR/family/issue roster, independent lineages and reference labels before arm outputs; keep W2 content/labels out of construction, diagnosis, updating, and gate tuning |

The source-time inequalities are C0 < C1 < C2; dates and PR numbers alone do not prove visibility. Historical review heads need public-event evidence and exact base/head/context bytes. Check comment edit versions, submitted rather than pending review times, original versus current commit IDs, and first-ready-for-review events. W0 rule construction may use a repair only if its necessary evidence was visible before C0; W1 supervision may use later evidence about a W1 finding only if it was visible before C1. Later evidence about W2 targets stays in the separate label package through a declared label-observation cutoff. If evidence cannot be time-bounded, record unknown or ineligible rather than moving it backward in time.

Keep **source chronology** separate from **experimental wall-clock order**. Rules are generated now from older permitted material; they did not historically exist at C0. Record the actual rule-lock and first W1-content/label-exposure times, and later feedback/proposal/target-label/output locks. A generated-rule timestamp must never be backdated as a natural historical rule. An assembler may handle withheld bytes, but cannot then author/tune W0 rules or W1 updates using that exposure. Isolation of prompts, allowed-head exports, caches and threads limits experiment-time leakage; it cannot erase unknown model pretraining exposure to public history. Disclose that residual limitation and any known model data-window information without claiming decontamination.

### Required evidence chain for the selected route

For every screened candidate retain the eligibility decision, including failure. Eligibility for the paired update comparison requires:

1. **Generated prior state:** exact W0-only input package, generation procedure/author or model/configuration, rule text/digest, family and scope, and a recorded rule lock before W1 exposure. Save every proposed family and failed/unsupported extraction; never retrospectively broaden a rule to manufacture a W1 error
2. **Experimental index application:** exact W1 source checkpoint, actual review output and original reviewer-input manifest. A prewritten finding or an author-selected patch description is not a completed experimental review
3. **Experimental feedback:** independently human-verified TP/FP/unknown findings with raw judgment records, source support, provenance, and lock/release times. Natural comments may be supporting evidence when time-valid, but approval, rejection, merge status and politeness are never automatic labels. Supply the same verified feedback to every updating arm
4. **Diagnosis:** two independent judgments and arbitration using the rubric below. Required source/contract evidence must distinguish a misapplication from an overbroad rule. Original input must establish whether decisive context was available; do not infer its absence from missing citations
5. **Development obligations:** a still-valid positive, the feedback finding, and available safe regression obligations from W0/W1, fixed before policy outputs. Preserve exact source/label provenance; no W2 case enters the gate
6. **Future transfer:** at least one supported still-valid positive and one supported legal neighbor in independent W2 issue lineages for the corresponding paired recall/false-alarm comparison. They must be separate from extraction, feedback and gate repair lineages and from each other. A source's own corrected side, another commit of the same PR, backport, duplicate fix, or another authored input is not independent future evidence
7. **Exposure and feasibility:** permitted as-of bundles, withheld label packages, complete PR-frame and PR × family accounting, lineage exclusion, and a feasible budget. Missing access, unreconstructable checkpoints, unsupported rules, no findings, no feedback, no recurrence and unknown labels remain visible

**All-PR denominator.** Enumerate every in-frame PR and show how many were sampled, accessible, reconstructable, reviewed, and adjudicable. Keep every sampled W1/W2 PR × frozen-family pair, including zero-opportunity, no-finding, unknown, failed and not-run pairs. Inspect pairs independently of the model's retrieval and emitted alerts; unreviewed or unmatched code is not negative truth. Record multiple same-issue anchors as one instance and keep shared PR/family/lineage dependence. The denominator for recurrence is all sampled later PRs under the declared sampling rule, not only feedback-rich or positive cases. Report conditional denominators for rule yield, feedback yield, paired eligibility, and each scored outcome separately.

The paired effect cohort is necessarily selected for a supported feedback opportunity and evaluable later positives/negatives. Report that selection and its cost against the all-PR frame; it is not a natural prevalence or full-PR precision estimate. If an explicitly enriched stress-test supplement is later chosen, freeze it separately and never blend its counts into recurrence estimates. Do not extend the search, resample seeds, swap repositories or expand windows after seeing unhelpful recurrence just to obtain favorable cases.

### Required diagnostic strata

| Stratum | Evidence required before assigning it | What would invalidate the assignment |
| --- | --- | --- |
| Judgment error | The old rule's condition and invariant are still supported; the index finding misapplies them despite the decisive evidence being in the original reviewer input | Only the final rule appears reasonable; the original input is missing; changing the rule is actually necessary |
| Context missing | A specific decisive source/contract fact was absent from the documented original input; with it, the old rule remains valid and the finding can be adjudicated | Inferring absence from an unmentioned citation; confusing unavailable evidence with a false invariant |
| Boundary error | The old rule actually includes the legal index case; its invariant remains supported within a narrower condition or explicit exception | A retrospectively invented broad rule, an unsupported negative label, or a genuinely obsolete invariant |

Each of these strata must be represented by an independent eligible family before making a cross-category claim about **diagnosis-conditioned action selection**. Missing strata do not prevent the selected one-repository feasibility pilot: report the missing yield and narrow any scored comparison to the supported strata. If only boundary cases qualify, call that comparison a boundary-field restriction study; do not infer a diagnosis benefit. Mixed and insufficient-evidence records are retained as abstention/feasibility strata, not forcibly assigned to one of the three.

For the smallest scored context stratum, require that the decisive context was missing from the **original review**, but was recoverably supplied by feedback or lawful pre-revision evidence and is now in the common revision packet. Record this restoration explicitly. The category describes the cause of the earlier failure, not an assertion that the present input is still incomplete. This avoids an experiment in which every gate result is unknowable by construction. An episode still lacking decisive context at revision is an unresolved-context stress case; keep it visible, but do not claim a successful repair without actual acquisition and a fresh supported judgment.

The implemented H policy still returns `request_context` for a context diagnosis; it neither acquires context nor repairs the finding. This limitation remains part of the measured policy even if the common packet now contains the earlier missing evidence. Do not give H an unimplemented repair step. A common gate re-review may now resolve the old finding because restored context is supplied to every arm, including F; any such improvement cannot be attributed to H's request operator. A later context-acquisition experiment would need its own shared access schedule and budget.

**Contract drift is optional and excluded from the primary claim.** Admit it only with an independently established old contract, actual transition evidence, a new contract, and an executable, validated old/new routing oracle. An optional type field or a proposed retirement declaration cannot establish this. No current developmental case meets these conditions.

### Optional natural records

A supplementary natural cohort requires a rule and finding that demonstrably existed before real corrective feedback, plus the same visibility, adjudication, gate and later-lineage checks. It is a distinct origin stratum; its absence does not block the selected generated-rule experiment. Do not pool natural and generated episodes without a prespecified separate-origin analysis or claim that experimentally generated feedback documents historical human rule revision. Synthetic fixtures remain mechanics-only tests.

## 3 Current materials and eligibility

The four developed cases are already exposed to the authors and excluded from formal holdout regardless of whether further material is obtained. This is an evidence inventory, not an assignment of research labels.

| Development case | What is usable now | Why it is not an eligible maintenance episode |
| --- | --- | --- |
| vLLM #8568 tool-choice default | Captured base/final source and current discussion; isolated function-body observations; narrow implicit/explicit-input contrast | No historically existing old review rule; early review head lacks a full recovered source checkpoint; edited-discussion visibility is unresolved; the accepted `if/elif` advice has no demonstrated outcome defect in the tested domain; no independent later same-rule positives/negatives |
| vLLM #2664 Ray dispatch | Squash-parent/merge source; receiver-construction context; a retained legal local-call branch | No raw review sequence or documented original reviewer input; no old rule; missing version-bound external dispatch validation; same-file branches are not independent future instances |
| vLLM #9034 zero-token delta | Source-bound zero-slicing mechanism and retained guarded slice; saved integration-test source | No old rule or raw corrective review episode; serving context is partial; offset assumptions remain bounded; the integration test does not isolate this method; no independent same-family future positives/negatives |
| vLLM #2570 optional max tokens | Source and direct test declaration for `None`; useful zero/positive-value contrasts | No old rule, review-input trace, or maintenance feedback sequence; no independent later targets; a changed annotation does not establish contract drift |

Sources: [#8568 analysis](developmental-case-vllm-8568.md), [three case cards](pilot-case-cards.md), [materials/feasibility inventory](pilot-feasibility.md), and [bounded reproduction](pilot-boundary-reproduction.md). Additional #14352 is also already inspected and remains in the conservative #8568 component lineage; its later date and different field do not make it a new eligible heldout episode. Author input variants and all implementation fixtures supply zero additional natural episodes.

## 4 Arms and the one-candidate decision

| Arm | Persistent state after proposal | Diagnosis use | Gate |
| --- | --- | --- | --- |
| H hard policy | Structured rule, edited only through the implemented operator restrictions; otherwise old state | Shared frozen diagnosis selects allowed action/fields | Same G |
| U unrestricted editing | Same structured rule schema; any semantic, applicability, context-requirement, or path field may be revised | Same diagnosis is advice; no diagnosis-conditioned edit prohibition | Same G |
| M scoped incremental memory | Local delta to the same family's initial rule content, rendered as one scoped lesson; may retain, revise, qualify, or suppress a lesson | Same diagnosis is advice; no diagnosis-conditioned edit prohibition | Same G |
| F frozen reference | Exact old state | No persistent update | Evaluated against G for diagnostics; no new state to accept |

U and M can retain, abstain, or request context. They are not required to mutate. Every updating arm has exactly **one proposal slot**, one submitted post-maintenance state or explicit non-mutation result, and one gate evaluation. This is a design choice for a minimal intervention, not a sample-size or power claim. A non-mutation outcome uses the slot; an invalid output does not earn another. Record the number of actual changed candidates separately rather than forcing meaningless edits to make that count equal. No best-of-N selection, rejection-conditioned rewriting, or uncounted retry is allowed.

All arms start from the identical old content. H/U use the same schema and rendering. M starts from a lossless rendering of that content with an empty delta area; its update must fit the same total persistent-token cap and cannot retain an entire extra transcript for free. It receives the same target-family retrieval envelope as H/U, not a global memory store. Selecting a family is fixed before outputs. No arm may drop targets from the evaluation roster by changing paths or retrieval scope.

All updating arms receive byte-identical evidence/feedback/diagnosis blocks, public development cases, source visibility and missingness, plus identical resource ceilings. Freeze revision/reviewer model identifiers, sampler settings, revision output limit, persistent-state limit, reviewer context and output limits, call cap, time/cost ceiling, target order, and repetition seed roster. Match ceilings rather than spend tokens artificially; report actual usage. Candidate validation, rejected proposals, diagnosis, all gate replays, future reviews, and failures count toward cost. Charge the shared inferred-diagnosis call once to each standalone policy in cost comparisons; disclose physical caching separately. F's lower maintenance cost is intentional and reported, not presented as a compute-matched updater.

Use a common review prompt and common code/context per target. It sees only the arm's effective persistent state, not arm name, revision rationale, diagnosis, raw feedback, gate outcome, or sibling outputs unless that information is explicitly part of the permitted persistent state. Otherwise a nominal no-mutation arm could receive a hidden memory update.

### The hard-policy intervention being tested

Use the current [operator contract](../docs/rule-revision-generation.md) and [validator](../src/revision-generation.ts), without describing them as semantic guarantees:

- `judgment` permits retention; `context` permits a recorded context request; both also permit abstention
- `boundary` permits actual changes only to applicability, exceptions, or literal paths; title, mechanism, invariant, required context, expected behavior, and detection assets remain exact
- Mixed/insufficient or conflicting/unresolved feedback and relevant missing-evidence gates force abstention under the implemented policy
- Reference contract-drift episodes remain outside the primary experiment. An erroneous inferred `contract` diagnosis must still exercise the actual contract-replacement branch, including its prior-rule and distinct old/new-contract/routing declarations. Score the result within the episode's reference stratum; do not replace a harmful prediction with a favorable oracle category or silently disable the branch

Immutable evidence identities, provenance, roster, and regression obligations are common to **all** arms. U/M may change persistent review content but cannot rewrite labels, citations, evidence, or regression cases. H-only restrictions must not accidentally be enforced on U/M through reuse of H's production validator. Conversely, U/M should not be penalized for failing an H-only response schema. A shared neutral research envelope with an arm-specific content validator is required.

The production revision path generates diagnoses and proposals jointly. The separate [local matched runner](../experiments/matched-revision/README.md) instead accepts an already frozen shared diagnosis and exercises F/U/H/M with a neutral proposal envelope, arm-specific validators, bounded local-delta memory and a common gate. U/M do not inherit H-only restrictions. These are authored-fixture mechanics: the production real-model adapter remains unconfigured, memory-baseline competence unverified, and empirical episodes and independent human annotations both zero. This documentation revision adds no implementation or runtime work.

## 5 Diagnosis conditions

**O provided diagnosis:** independent adjudicators lock the cause of the index failure before any method output. Supply the same category, permitted-source citations, and bounded explanation to H/U/M. The explanation must not include the desired replacement rule, future labels, or facts unavailable by the revision cutoff. This tests restrictions under privileged diagnostic supervision, not an automatic diagnosis system.

**I inferred diagnosis:** a single diagnosis-only call per episode/repetition sees the common pre-revision input, without the expert category. Freeze its category, uncertainty, missing-evidence declarations, and citations, then give that exact output to H/U/M. No updater may relabel its diagnosis to obtain wider permissions. An uncertain but well-formed diagnosis is shared unchanged. For a failed or malformed call, preserve the raw failure and supply an administrative `insufficient_evidence` record identifying that failure to all updating arms, without fabricating a substantive diagnosis or making another call. H must abstain; U/M still have the same raw evidence and their own non-mutation options. This estimates the policy effect under that shared diagnostic error distribution.

Run O and I as separate paired conditions on the same frozen roster, in fresh contexts, with randomized arm/condition execution order and paired reviewer seed schedules. O results cannot leak into I prompts or memory. Report diagnosis agreement with the reference, uncertainty, and per-stratum confusion separately from update effectiveness. Without all required strata, aggregate diagnosis accuracy is misleading.

An additional unrestricted **without-diagnosis** arm would estimate the value of diagnosis information, not hard enforcement. It is optional and must not replace U in the primary comparison.

## 6 Shared gate and effective state

Freeze G before proposals: all selected feedback obligations and the same historical positive/negative regression cases, with exact source/context packages and independent expected judgments. Labels/evidence may be public to revision when declared so for every arm; this is development supervision, never heldout evidence. No gate case or related repair lineage enters future evaluation.

Apply the same gate semantics to H/U/M: every required case must have a supported, known judgment meeting its expectation; every old positive must retain a detection; every selected erroneous finding must be explicitly corrected at its proper scope. A regression, still-failing obligation, insufficient-context judgment, missing execution, or mere path exclusion blocks acceptance. A legal-neighbor non-applicability answer needs source-bound evidence at that issue scope, not silence or a whole-file safety inference. Existing [comparison contracts](../docs/local-revision-comparisons.md) motivate these semantics. The local fixture supplies a memory-state review/gate interface, but a real adapter must still demonstrate the memory semantics and exact evidence/scope assessment; fixture-bound citations do not establish independent semantic support.

Accept a proposed changed state only if it is valid and passes G. Otherwise the effective state is the unchanged incumbent. Retention, abstention, and unfulfilled context requests also leave the incumbent effective. Evaluate that effective state on **every** heldout target. Do not discard rejected proposals or abstaining episodes, and do not evaluate only accepted updates. Reusing an identical frozen-state review for exactly identical inputs/configurations is permissible if declared in advance; charge/report the equivalent standalone evaluation cost and do not reuse it across different contexts.

An unchanged incumbent is not a successful correction merely because it remains deployed. Gate diagnostics still record any remaining failure; only an actually supported fresh judgment can establish resolution. Retention can nevertheless be the right maintenance decision: later detection performance determines its benefit, while any unresolved index finding remains visible. `retain_rule` does not execute review repair, and `request_context` does not execute acquisition.

**Optional no-gate ablation:** evaluate H and U with G bypassed as a matched pair under the same diagnosis condition, using their already frozen proposals. No new generation or extra candidate search. Keep each arm's schema/policy validity checks; bypassing G does not turn an invalid proposal into a valid state. Report this as an operator-by-gate interaction diagnostic, separate from the main shared-G estimand. It cannot support a claim that H beats an ungated baseline in the matched-gate setting.

## 7 Paired units and exact outcomes

### Unit and dependence

An episode is one old rule version plus one feedback mechanism and its frozen independent future roster. Its entire package is evaluated under every arm/condition. The elementary outcome is a blinded **issue instance at a target PR checkpoint**, not a detector hit or anchor. Group repeated anchors for one mechanism into one issue. Keep PR, family, repository, and cross-PR issue-lineage IDs. Multiple episodes in one family and multiple families touching one PR are dependent; choose one episode per independent family for the smallest pilot where feasible. Seeds, anchors, gate checks, and function calls never increase the number of independent episodes.

The main display is a paired per-episode ledger, followed by diagnosis-stratum and family-level summaries. Macro-average equally over independent families; within each family average its episodes and frozen repetitions. Also show pooled raw counts as descriptive exposure counts, without treating them as IID trials. Do not claim a population effect or calculate a powered formal sample size from these developmental examples. Any confirmatory clustering/uncertainty method must preserve both shared-family and shared-PR/lineage dependence and be frozen after feasible pilot variance is known, before new confirmatory outcomes.

### Label and prediction vocabulary

Reference labels are `violation`, `legal_neighbor`, `safe_applicable`, `unknown`, or `disputed`. Review observations are `violation`, explicit `safe`, supported `not_applicable`, or `unresolved`. Explicit abstention, absent output, uncovered/excluded scope, timeout, unsupported input, and invalid output are distinguishable reasons for unresolved. `not_applicable` is correct only for an adjudicated legal neighbor with adequate source support. Missing context cannot certify safety.

For episode e, use its common labeled positive set P, legal-neighbor set L, and safe-applicable set S. All arms use the same sets. Also retain U, the unresolved-reference targets. If a required denominator is zero, report `not_estimable`; do not use zero or drop the episode silently.

| Outcome | Definition and interpretation |
| --- | --- |
| Future positive recall | Correctly supported violation predictions on P divided by size(P). Every unresolved/abstained/excluded/not-run positive is a miss in this denominator |
| Effective positive miss rate | 1 minus future positive recall; show false-safe and operational/unresolved misses separately |
| Legal-neighbor false-alarm rate | Violation predictions on L divided by size(L). Unresolved negatives are not false alarms, but are not correct resolutions either |
| Strict legal-neighbor resolution | Explicit safe or supported not-applicable predictions on L divided by size(L). Unresolved, excluded, and not-run negatives contribute zero |
| Safe-applicable resolution | Explicit safe predictions on S divided by size(S); not-applicable is an error for this set |
| Repeated feedback-mechanism false alarms | Violation predictions on the prespecified subset of L exhibiting the feedback mechanism, divided by that subset's size. Define membership before model outputs; do not select it from observed failures |
| Strict balanced resolution | One half of positive recall plus one half of strict legal-neighbor resolution. This transparent auxiliary score makes blanket abstention score zero; it does not replace reporting its two components or establish clinical/business utility weights |
| Valid judgment coverage | Supported, determinate judgments over all scheduled, in-scope issue targets; separately show coverage on P/L/S and count unsupported not-applicable assertions. Coverage is not accuracy |
| Scope loss | Scheduled targets without a supported judgment because of path, retrieval, or applicability exclusion, divided by all scheduled targets. Supported issue-specific non-applicability on L is resolution, not scope loss |
| Maintenance outcomes | Counts/rates of changed proposal, admitted change, retention, abstention, context request fulfilled/unfulfilled, policy-invalid output, gate rejection by reason, and unresolved index finding; denominator is every scheduled episode-run |
| Retained old obligations | Detection on old positive gate cases, plus recall on independent future positives to which the same old invariant still applies. The former is gate-selected by construction and cannot alone demonstrate generalization |
| Cost | Actual calls, input/output tokens, billed currency when available, elapsed time, and failure/retry count for diagnosis, proposal, gate, and future review; disclose cached versus standalone cost |

For each arm pair report paired differences in these episode/family quantities, with the same sign convention throughout, plus counts of episodes improved, tied, and harmed. Report which actual positive detections H loses or gains relative to U and M, not only rates. Generic issue precision can be shown descriptively on the adjudicated roster, with its selected-case denominator; no claim is made about full-PR precision or recall for unrelated defects.

**No reward for silence or unchanged state.** Retaining or rejecting a proposal does not remove its episode from a denominator. Zero emitted alerts produces no false alarms but zero strict negative resolution unless safe/non-applicable judgments are actually supported, and every missed positive stays a miss. An unfulfilled context request is not a repair. Correct retention is not arbitrarily penalized as an action; unresolved feedback, missed opportunities, abstention, scope loss, and the full cost are its measured penalties.

Unknown/disputed reference labels remain outside verified-positive/negative denominators and visible in the total roster. Never label them safe. Report their prediction distribution and the fraction of scheduled targets they represent. For accuracy/strict-resolution summaries, give pessimistic and optimistic bounds by assigning each unresolved reference the least/most favorable legally possible correctness for the paired predictions; use one common possible label assignment per target for both arms. If feasible-label constraints are insufficient, report the unresolved mass rather than a made-up bound. Keep this label uncertainty separate from sampling uncertainty and from model abstention on known labels.

## 8 Blinding and exposure controls

1. Separate source assembly, independent annotation, and output assessment. Rule authors cannot be the sole final adjudicators of that family's future labels. Preserve both independent judgments, disagreement, arbitration evidence, and missingness
2. Adjudicators first lock as-of contract/applicability judgments without later fixes, method outputs, or arm identities. Only then open the separate later-evidence bundle, record any changes, and freeze the reference before running methods
3. A separate blinded assessor maps randomized output IDs to issue instances and judges citation sufficiency. Do not show arm names, diagnosis condition, gate outcome, author-preferred revision, or sibling results. Reveal mappings after judgment lock; record any unblinding or obvious style inference
4. Revision sees only pre-revision evidence and public development obligations. Future reviewer runs see each target's as-of package and the permitted persistent state. Keep future fixes, test additions, comments, issue resolutions, and labels out of model inputs
5. Use isolated allowed-head exports, audited visibility declarations, neutral filenames, isolated caches/threads, and disabled outside retrieval. Record exact bytes and exclusions. Hashes alone do not prove historical visibility. Audit edited comments, submitted versus pending reviews, backports, shared repair lineages, and answer-bearing paths
6. Freeze the reviewed target universe independently of model retrieval and output. Missing/rejected/not-run units persist in the roster. An arm's scope change cannot remove its missed positives or denominator
7. Keep O and I runs, repetitions, episodes, and arm contexts separate; randomize execution order and pair seed schedules. Public pretraining exposure remains a limitation. Disclose model/version/data-window knowledge without claiming it is eliminated by local isolation

## 9 Feasible pilot and go or no-go

**Stage A, frame and packet feasibility.** Select and freeze the one-repository W0/W1/W2 source frame, budget, selection rule and stopping condition. Audit every in-frame/sampled PR, including unavailable or zero-yield cases. Locally prepare empty manifests, visibility and lineage checklists, neutral prompts and staged annotation forms; validate existing development-packet mechanics without promoting those cases into the study. This preparation needs no model call or external acquisition. No new fresh source frame or qualifying episode is currently assembled.

**Stage B, generated-rule and feedback feasibility.** After the required data access, model-execution permission and human assignments are established, construct and lock W0 rules before W1 exposure; run the common W1 review and independently verify experimental feedback. Report rule yield, feedback yield, annotation burden, missingness and recurrence against the full denominators. Failure to find a useful maintenance opportunity is a valid result. Naturally complete old-rule histories are not a go/no-go gate.

**Stage C, bounded paired stress test.** Freeze the supported episode/target roster, prompts, separate O/I diagnoses, one-proposal design, common gate, budgets, repetitions and analysis before policy outputs. The paired false-alarm/recall contrast needs supported independent W2 positives and legal neighbors; a missing denominator is `not_estimable`, not zero. If only one diagnostic stratum is feasible, narrow the claim rather than fabricate the others. If no paired cohort qualifies, stop the effectiveness stage and report feasibility and missingness. This is a falsification/feasibility pilot, not a significance contest or a population-effect estimate.

Advance to a larger confirmatory study only if the construction cost is acceptable, the policies actually differ on supported independent targets, and H merits testing against **both** U and competent M without buying fewer alerts through missed positives or unresolved review. Identical effective states or a gate rejecting every distinct proposal leave the incremental effect unestablished; do not weaken the gate after observing that outcome. H weakly dominated by U or M on false alarms, positive recall, strict resolution and cost gives no efficacy claim on these data. Mixed or imprecise results remain inconclusive.

If H helps only under O, the supported claim is at most a diagnosis-supervised restriction effect. If inferred diagnoses remove or reverse that gain, diagnosis is a practical bottleneck. Even I retains human-verified experimental feedback and cannot be advertised as fully autonomous learning from ordinary comments. If H matches a simpler equally informed comparator, prefer the simpler explanation and narrow the contribution.

A confirmatory study requires fresh heldout episodes, a predeclared meaningful false-alarm improvement, acceptable positive-recall loss, coverage requirements and cost ceiling. Choose numbers from the intended use and pilot variability before new outcomes. No powered sample size or empirically justified numerical margin is supplied here; a small nonsignificant pilot cannot establish equivalence.

### Present blockers and permitted local preparation

- **Real PR data:** the earlier HTTP 403/zero-capture attempt remains historical evidence, not the latest availability state. The frozen HTTPX 70-row metadata frame and six W0 exports now exist; W1/W2 content, historical visibility and independent labels remain unestablished. This research audit performs no source acquisition or access workaround
- **Real model execution:** the recorded runtime remains blocked pending a trusted authenticated backend and operational configuration. Authored SDK outputs do not verify real inference. Model choice, exact configuration, budget and permitted execution are not supplied by selecting this study route
- **Independent humans:** two qualified annotators and an arbitrator remain unassigned; no one has been contacted. Assistant/model judgments cannot substitute for independent human responses
- **Research execution:** the [matched F/U/H/M fixture runner](../experiments/matched-revision/README.md) now exercises shared-diagnosis orchestration, neutral proposals, U/M validators and the local-delta memory/common-gate interface. Production mode returns `not_run: production_adapter_unconfigured`; a competent real memory baseline and empirical execution remain unverified. The production H validator is not used to constrain U/M proposals

Safe next local work is evidence inventory/hash checking, empty frame and exposure-ledger preparation, neutral W0/W1/W2 prompt and annotation instructions, and development-packet validation. Authentication, credential configuration, paid API calls, upload/publication, annotator contact and actual model/data execution are not authorized by this planning choice and remain pending. This revision changes paper specifications only.

## 10 Reconciled decisions and earlier-plan disposition

The next route is **selected**, not another menu of competing proposals: one repository; W0-generated experimental rules; W1 real-PR reviews with independently verified experimental feedback; W2 independent later-PR comparison of F/U/H/M under matched information, models, budgets and gate; O and I reported separately. The execution freeze and preregistration are still pending, and no empirical stage has run.

- [Phase 0](phase0-protocol.md)'s three-repository 90-history/180-target natural-opportunity study is deferred protocol history. Its original thresholds remain attached to that unexecuted design; they are not prerequisites for this controlled experiment or evidence already satisfied by it
- The former manuscript/readiness 10-history/20-target two-window proposal is superseded as the immediate pilot structure. It is not silently reinterpreted as three windows. Window dates, sample counts and budget will be filled once for the selected route before any formal acquisition/label exposure
- The [novelty audit](novelty-audit.md#smallest-informative-falsification-experiment)'s eight-family 4/2/2 diagnostic allocation and two-positive/two-negative targets remain optional historical stress-test suggestions. They are neither current acceptance quotas nor a power calculation. Actual yield determines the supported claim, not retrospective case replacement
- Naturally documented maintenance records may form a separately identified supplementary cohort, but finding them is no longer the mandatory entry gate. The four vLLM cases and already-inspected #14352 lineage remain development-only regardless of new annotations

Before execution, complete and hash one operational configuration for this selected route, including both chronological cutoffs and experimental exposure locks. Any later change must be a dated amendment with reason and exposure status. Do not call the selected direction a registered protocol, an acquired benchmark, or empirical validation.

## Companion documents

The [manuscript](manuscript-draft.md#6-evaluation-protocol), [readiness checklist](manuscript-readiness.md), [pilot inventory](pilot-feasibility.md), and [research packet specification](experiment-protocol/README.md) use this same selected route. Implementation descriptions and historical evidence retain their original commit-specific scope.
