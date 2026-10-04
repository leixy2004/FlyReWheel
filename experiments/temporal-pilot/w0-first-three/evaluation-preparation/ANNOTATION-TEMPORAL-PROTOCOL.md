# Proposed annotation and temporal-visibility protocol, v0.2

Status: retrospective design proposal written after W0 inspection; not preregistered,
not an approved collection, and not evidence of labels, annotator assignment or model
performance. All existing labels stay unassigned. This document supplies defaults
within project research design authority; it does not authorize external recruitment,
packet sharing, upstream acquisition or model execution.

## Question, estimand and sampling

Default question: for frozen repository snapshots and a frozen set of substantive
rule families, does FlyReWheel improve detection of independently established,
actionable rule violations relative to a frozen baseline under matched information
and total construction/maintenance/review budgets? This is a retrospective
fixed-snapshot evaluation, not a historical review replay or causal developer-impact
study. A merged edit is not automatically a defect or a useful general rule.
The default formal task is to find actionable violations still present in the frozen
proposed-head snapshot, within changed surviving lines and the family-defined
context needed to assess those lines. Merge-base and diff are context only: a
violation repaired before that head is not a head-positive. Deleted-only opportunities
are out of this primary scope and counted as excluded targets. Both pre-existing
and newly introduced violations can count if they persist on the scored head within
that scope; report their distinction only where base evidence supports it, otherwise
origin is unknown. Do not claim the metric measures only newly introduced defects. The final captured
head is selected retrospectively; this merged-PR sampling cannot represent rejected
or earlier revision defects. The three existing before-only W0 drafts remain
calibration/packet-safety artifacts, not formal examples of this head-review task.

Primary estimand: the paired difference in issue-level detection proportions on the
same independently enumerated, known-positive issues in eligible W2 PR×family units.
Deduplicate multiple alerts/anchors for one issue before counting detection. A known
positive is detected only when the existing exact-anchor matching contract matches
its frozen issue and snapshot; this deliberately narrower metric does not establish
all semantically equivalent detection. Publish that limitation. Secondary outcomes:
false alerts on independently enumerated known-negative opportunities; finding-level useful-alert
precision only where every emitted violation finding can be assessed; completion, abstention,
failure, unknown coverage, total alerts and accounted cost per preselected unit.
No composite score or post hoc family weighting. Report counts alongside rates.

Default sampling is the census of all 19 W2 metadata-frame candidates, not a claim
about all HTTPX PRs or other repositories. Audit original frame inclusion/filtering
before collection; inference is conditional on that frozen 70-row frame. W1's 13
candidates are development only. The fixed first three of 38 W0 rows are a purposive
early-PR feasibility pilot, already exposed to outcomes; never use them as holdout,
a random sample, or a rule-yield/defect-prevalence estimate. No replacements for
ineligible, unavailable or unknown rows. The six before/after exports represent
three PRs, not six independent samples. Acquisition feasibility remains unproven for
W1/W2 and is not changed by choosing this proposed census.

Freeze family definitions, scope, baseline, arm information/budgets, issue identity/deduplication
and matching rules before W2 source access. The actual issue roster is independently
discovered and locked after source inspection but before any arm outputs; it is not
invented before access. Every PR×frozen-family combination is
registered before labels; excluded/unknown/unassessed combinations remain visible.
Report the flow 70 frame → 38/13/19 windows → 19 selected W2 → temporal eligibility,
contamination, access failures → assessable units → positive/negative/unknown issues
→ executed/completed/failed/not-run units. Exclusion reasons can overlap; show both
reason flags and a fixed first-failure tally to avoid double-counting. Publish both
all-selected and eligible-only denominators. Current-capture primary eligibility
requires membership in frozen W2, a verified complete static pair and declared scope,
a frozen applicable family, and no known development-linked contamination; unknown
lineage stays outside the uncontaminated subset and is reported separately. No
historical-visibility proof is required for this current-capture subset. Missing
historical proof excludes only the optional as-of analysis. Label assessability is
reported separately from input eligibility; Unknown cannot remove an eligible unit.
Never report missing labels as zero.

Failed, abstained and not-run arms remain in the all-selected execution denominator;
on an established positive their detection is zero. If no independently enumerated
positive exists, recall/detection is undefined, not zero or perfect. Incomplete issue
search yields scoped detection of known issues only, not repository-wide recall.
Report paired counts and PR-clustered descriptive differences; with 19 candidates
and possible correlated lineages, do not promise powered significance or general
population confidence intervals. No effectiveness threshold or deployment claim is
licensed here. A nonpositive primary difference fails to support improvement; a
positive difference with increased false-alert burden, unresolved unknown coverage
or unmatched budgets does not support an unqualified improvement claim.

## Time and admissible evidence

Default visibility is `current-capture`, historical pretraining exposure `possible`
(or `unknown` if that is all evidence supports), and source attestation remains
`locally-declared-unverified`. The current 2026 observations of 2024 PRs do not prove
what a reviewer could see then. `mergedAt` assigns a window only. Merge-base is a
topological comparison baseline, not a documented review checkpoint. Commit dates,
ancestor closure, matching trees and exact allowed heads establish identity/closure,
not historical public availability. Keep checkpointAt, historyCutoff and declaredAsOf
null unless independently evidenced; do not fill them with merge dates.

For a future historical subanalysis, define review checkpoint T as the first
independently archived review-request event for the exact proposed head, before any
outcome/review decision used as a reference. Require event evidence binding the
visible head and base, plus immutable hashes and contemporaneous availability proof
for every included artifact. If that checkpoint/evidence does not exist, mark temporal
eligibility unknown and exclude only from the historical subanalysis. Do not silently
substitute another T. Current-capture eligibility does not imply as-of eligibility.
A schema value `as-of-declared` is a declaration, not independent verification.

At review time, allow only frozen predecision base/proposed-head content, the diff
between those exact snapshots, and project documentation/configuration/tests proven
available in that same scope. The proposed head is admissible only if available at
T; an eventual final head is not automatically admissible. For the current-capture
study use an explicitly declared static snapshot pair, with no historical claim.
Apply the identical source/history/tool allowlist to both arms and reference raters.
Use selected files by default; expand to full frozen context only by a logged common
packet version before either rater submits, never by giving one arm hidden context.

Exclude from judgment packets: merge outcome, later fixes/releases, after-the-target
revisions, future tests, current edited title/body/comments, review discussion,
labels, author/reviewer identities, issue outcomes, branch/ref logs, precomputed
Ruff/docs results, model suggestions, rule-mining outputs and evaluator reasoning.
After-side evidence for the existing before-only drafts is withheld. A later proposed
head may be admitted only in a separately versioned review task with explicit
snapshot/visibility rules; never silently upgrade these drafts to paired review.
Outcome data can support a separately marked retrospective audit after labels lock;
it cannot rewrite original judgments or become ground truth by itself. Any present-day
tool reproduction is newly observed evidence, not historical CI evidence.

## Rubric and independent judgments

Before collection, each real family must specify a checkable precondition, violated
constraint, observable consequence, applicability boundaries, valid counterexample,
source scope and exact anchor convention. Positive requires evidence that the
constraint is violated and actionable within that scope; a version bump/style change
alone is insufficient. Negative requires an explicit assessed opportunity and an
explanation of why the in-scope constraint holds. Out-of-scope or demonstrably
inapplicable opportunities are excluded; an uncertain precondition is unknown. Lack of an alert or absence
of a discovered issue is not a negative. Unknown means insufficient context,
unverifiable premise or unclear applicability; disputed means unresolved substantive
conflict after adjudication; excluded means a predefined scope violation. Missing
work remains unassessed coverage, never an invented unknown instance.

Use two independent human annotators competent in the repository language and each
family. Neither may have authored the evaluated rules/PRs or inspected the evaluated
arm outputs/outcomes for assigned cases. The assistants that saw W0 outcomes are
protocol auditors, not blinded human raters. Before assignment record expertise,
prior exposure and conflicts privately. Calibration uses separate disclosed W0/W1
or authored examples, never W2; freeze rubric before W2. Record calibration exposure.

Both raters independently inspect every assigned PR×family scope with the same
bounded search instructions and record positive/negative/unknown instances, anchors,
reason and coverage. No discussion, shared notes or access to the other's responses.
Proposed default time budget is 30 minutes per PR×family per rater, recorded even on
timeout; unresolved work becomes partial/unassessed, not negative. At the maximum eight families, 19×8×2×30 minutes is 152 person-hours
for initial rating alone, excluding calibration and adjudication. Confirm feasibility
on development calibration and freeze any revised budget before W2. Context requests
must pause both judgments and create a common versioned packet; preserve old versions.
If either rater already submitted, preserve that original and require both to restart
independently on the new packet with equal reset budgets and recorded prior exposure.
Do not compare judgments from different packet versions.

Lock and hash both submissions before comparison. A third independent qualified
human adjudicator reviews disagreements, unmatched issue proposals and coverage
conflicts using the same packet/rubric and anonymized reasons, blind to arm identity
and outputs. They may accept either judgment or retain unknown/disputed with reason;
never force consensus. Preserve both originals and the adjudicated record. If the
third resource is unavailable, retain disagreements as disputed and do not claim an
adjudicated reference set. Adjudication must not consult later outcomes to settle a
historical ambiguity.

## Agreement, Unknown and alert matching

Report pre-adjudication raw agreement, a full label contingency table and unweighted
Cohen's kappa on independently rated, common anchored opportunities (positive,
negative, unknown; exclusions reported separately). Kappa is undefined when expected
agreement is one; publish null and counts. Adjudicated agreement is not reliability.
Predefine common opportunities using the rubric independently of model outputs.
For free-discovered issues, report both raters' issue counts and exact issue/anchor
intersection-over-union before adjudication; absent proposals are not converted into
negative labels. Before W2, define issue identity as family + violated constraint + target snapshot
+ canonical affected code span; when multiple anchors are allowed, freeze their
canonicalization in the rubric. Publish exact-anchor agreement separately from
semantic disagreement. Align free-discovered issues using that frozen rule without
outputs; report unmatched proposals, and do not force different anchors to agree.
Do not calculate kappa on a post-adjudication aligned issue list.
Report unit-level coverage agreement separately, including partial and unassessed.

Unknown/disputed instances never enter known-positive or known-negative denominators.
Report their counts and proportions across the full selected scope, by family/PR and
reason, and alerts landing on them. Treat lack of coverage as missing, not safe.
For finding-level precision with U unresolved among A exhaustively inventoried
emitted violation findings and
K verified useful alerts, publish bounds K/A to (K+U)/A as well as known-only results;
if A=0 precision is undefined. Here A is every emitted violation finding across the fixed arm/unit set,
including repeated and out-of-scope findings. Use the existing evaluator finding
counter (`uniqueAlerts` currently counts violation findings, not semantic issue
clusters); do not call it semantic deduplication. Each finding must be classified
useful, non-useful or unresolved; U includes applicability disputes, missing context
and all other unjudged usefulness. Out-of-scope alerts are non-useful for this task;
repeated useful findings are reported as redundant burden and may remain useful
under this finding-level definition. Report raw findings, exact anchors, redundancy
and issue-level detection together so repetition cannot masquerade as added coverage.
If that partition is incomplete, do not emit the bounds. Missing opportunity coverage can conceal arbitrary
issues, so this protocol does not promise finite recall bounds from unknown counts.

Freeze reference search/submissions before generating arm outputs. Novel unmatched
alerts require a separately versioned, output-origin-blinded correctness audit with
both arms' findings shuffled, with identifiers stripped but wording unaltered; preserve
original bytes privately. This audit may estimate all-alert precision, but never
adds positives to the primary recall reference. Until that audit is complete,
precision for unmatched alerts is unknown, not false by default. Existing evaluator
unmatched/excluded/unknown counters must remain visible.

## Blinding and contamination

A facilitator holds packet-to-PR mapping separately from packets. Use random packet
IDs, independently shuffled order, no split/arm identifiers, no outcome metadata,
and no access to the public ledger, source hashes, GitHub search or unrestricted
repository history during rating. Do not rewrite source bytes to hide recognizable
paths/comments. Public code can remain identifiable; obtain prior-recognition and
in-task recognition declarations, log breaches, and retain affected units in a
contamination stratum. Raters exposed to outcomes cannot be labeled blinded. This
protocol is open-source outcome blinding with limits, not identity-blinding proof.

Before W2 release, an audit facilitator (not a rater or arm developer) checks frozen
W0/W1/W2 identities, ancestry/patch equality, duplicate files, backports/cherry-picks,
shared issue links and copied rule examples using authorized acquisitions only.
Exact and near-duplicate detection procedures/thresholds must be frozen on development
data first; unresolved semantic overlap stays unknown. Publish reasoned lineage
clusters and exclusion flags without exposing W2 contents to developers. Default:
known W0/W1-linked W2 cases excluded from the uncontaminated primary subset, retained
in all-selected descriptive accounting; cluster same-lineage W2 cases for dependence.
Unknown overlap gets a separate sensitivity stratum, never presumed independent.
All W0 cases are contaminated development data. Public-model pretraining exposure
cannot be ruled out by these checks and remains a stated limitation.

## Existing contracts and minimal gaps

Reuse `src/core/paired-evaluation.ts` EvaluationDatasetSchema and
EvaluationAnnotationSchema; retain strict labels/coverage, exact SnapshotAnchorSchema,
real authors/families/rules, protocol/rubric/dataset digests and evidence bindings.
Reuse EvaluationRunsSchema, existing matcher and complete evaluation workspace
bindings; no export downgrade, fake family, synthetic human author or empty formal
form to satisfy validation. Set provenance booleans to what actually happened.
W1 and W2 are separate datasets (32 combined PRs exceed the 25-PR contract limit).
W2 19×at most 8 families = at most 152 units, within the 200-unit limit; exceeding
other contract limits requires an explicit design revision, not silent truncation.

The only proposed gap is a facilitator-side procedure ledger linked by digest:
packet/version → cutoff/availability decision + evidence IDs; assignment/recognition
and conflict attestations; two independently locked submission digests/times;
adjudication link/reason; opportunity enumeration/search coverage; contamination
flags/lineage and exclusion flow. Keep identity mapping private and publish aggregate
counts. This is a procedural sidecar proposal, not a second label schema or a
materialized participant record. Add a strict sidecar schema only when real inputs
and the collection interface are approved; existing schemas need no change now.

## Minimal staged plan: spend only after feasibility is established

This section narrows expenditure, not the frozen sampling frame. It proposes no new
PR selection or immediate collection. W0 remains the same three exposed PRs; W1
remains the 13 development candidates; W2 remains the 19 untouched candidates.
Start with **one substantive family**, selected on development evidence before W2,
only if one can be specified honestly. Eight families and 152 initial-rating hours
are a maximum option, not a minimum or an established need. A one-family conclusion
is limited to that family; it is not evidence for general reusable-rule efficacy.

The essential research claim is improved detection of actionable head-snapshot
violations under matched information and total budgets, without concealing false
alerts or missing coverage. The primary metric stays the paired, issue-level
detection difference defined above. Issues are measurement opportunities nested in
PR×family units; independent replication is at PR or linked-lineage cluster level,
never at anchor, export, repeated run or rater level. A process-feasibility gate is
not a test of that efficacy claim.

### Stage A: tiny calibration and task feasibility

Use the three already exposed W0 cases only, one candidate family, two independent
initial judgments capped at 15 minutes per case per person. These are disclosed
calibration exercises, not blinded holdout labels or formal head-review instances;
existing before-only drafts test packet/rubric usability only. Any head-side exercise
requires a separately versioned packet under the formal task rules. No new content
is required to draft this plan. Cap initial rating at 1.5 person-hours, adjudication
at 45 minutes and preparation/logging at 30 minutes: **2.75 person-hours total**,
conditional on personnel, approved access and a real rubric already being available.
Rule discovery/creation is not hidden in this cap; log it separately, and stop rather
than assume free or unlimited design work.

Progress only if a real checkable family exists, at least two of three exercises
receive complete independent submissions within budget, and every rubric ambiguity
preventing a reproducible judgment is resolved in a dated rubric revision. Unknown
judgments can be valid completed work but do not establish that actionable violations
are measurable. Zero positives in these tooling-heavy cases is a legitimate outcome,
not grounds to replace a PR or manufacture a rule. If no defensible family exists,
stop with “no eligible family demonstrated.” If a family exists but no positive
opportunity is observed, a W1 feasibility pilot may still be proposed on a documented
substantive rationale; it must not be represented as demonstrated defect signal.
Allow at most one wording-only recalibration within the stated cap; if it requires
more time/context, record unmet feasibility and revise a later proposal, not this run.

### Stage B: bounded development pilot, only after Stage A gate

Proposed pilot is all 13 existing W1 metadata candidates, one frozen candidate family,
two raters × 30 minutes per PR: **13 initial-rating hours**. Reserve 3.25 hours for
adjudication (15 minutes per PR) and 1.75 for packet/ledger administration: **18
person-hours total**, excluding explicitly costed source acquisition, contamination
auditing, rule creation and any later model experiment. This is a future authorized
work package, not a current instruction to acquire W1 or assign anyone. Full W1 avoids
introducing a new convenient subset or silently changing selection. A smaller time
budget must be approved and frozen after Stage A but before W1 access; do not cut
search time after seeing hard cases.

Here complete dual search means both real independent raters searched the same
locked packet/rubric scope and locked their submissions; it does not mean all labels
are known or merely schema-valid. Unknown remains an allowed completed judgment.
At the single scheduled end-of-pilot review, require at least 10/13 PR units with
complete independent search coverage by both raters and resolved procedure issues,
and known-positive head-snapshot issues on at least two distinct PRs after the
existing adjudication procedure, to say the primary metric is operationally
measurable beyond a single case. These are proposed resource/feasibility thresholds,
not empirical power thresholds or evidence of improvement. Positives must be
supported by the independent reference process, not merge status, Ruff output or a
single unchecked assertion. Freeze one family for this pilot; do not rotate families
or repeatedly tune the rubric until a gate passes. Any later W2 result is conditional
on this development-stage family selection, not an unbiased all-family claim. All 13 remain in the
flow; completion, positive yield, negative opportunities, Unknown, disputed and
unassessed counts are reported separately. If positives occur in only one lineage,
record that dependence and do not claim independent replication.

If zero positives, report “zero observed eligible positives in this development
pilot; detection metric undefined,” not zero defect prevalence or zero method yield.
If fewer than two positive-bearing PRs, fewer than 10 complete units, unresolved
rubric ambiguity, or exceeded budget, stop progression as measurement/resource
futility. Do not replace cases, widen families opportunistically, move W2 into
calibration, or request more labels until success. A later redesigned study is a
new version and retains this failed/zero-yield pilot in the record.

The annotation pilot alone cannot estimate model discordance or efficacy. If a
separate matched two-arm development run is later authorized, lock labels first,
then observe positive opportunities per lineage, paired detection discordance,
Unknown/coverage, false-alert burden, cost and runtime failure. No favorable observed
point estimate is required for reporting the pilot; negative or zero differences
remain publishable. No efficacy early stopping or repeated significance peeking.
A stronger efficacy study is not launched on authored fixtures or annotation yield
alone; missing arm/uncertainty evidence stays an explicit planning limitation.

### Stage C: size a proposed confirmation from uncertainty, not arbitrary N

Before W2 access, freeze the minimum scientifically worthwhile improvement and
maximum acceptable false-alert/cost burden, together with the desired uncertainty
width and analysis assumptions. A suggested **planning precision target** is a
95% interval half-width of 0.10 in paired detection difference; this is not a claimed
achievable precision, a power calculation, or the minimum worthwhile effect.
Effect and burden tolerances need a substantive task rationale before execution.

Use the pilot's distribution of independent lineages, positive counts per lineage,
paired outcomes, annotation missingness and cost to simulate the prespecified metric
under no benefit and worthwhile-benefit scenarios. Include pessimistic higher
within-lineage dependence, more missing labels, lower positive yield and smaller
attainable benefit than the pilot suggests. Vary discordance across a plausible
range, including higher discordance that can increase paired-difference variance. Account for pilot estimation uncertainty; never size from
only its most favorable point estimate. Without real paired outputs, use an explicit
conservative design envelope or postpone efficacy sizing. Fit/simulation results,
assumptions, seed and stopping target must be frozen before confirmation. These are
future planning computations, not analyses completed in this checkpoint.

Worst-case current knowledge permits any detection difference in [-1, 1]. Unknown
positives and incomplete search mean even a precise known-positive result is not
population recall. For a *hypothetical independently sampled cluster design*, write
D_j=(treatment detections minus baseline detections)/P_j in [-1,1] for cluster j
with P_j>0 known positives, and w_j=P_j/sum(P_j) for its
fixed positive-count weight. Conditional on fixed weights and independent clusters,
a conservative 95% bounded-variable half-width is
`sqrt(2 * log(40) * sum(w_j^2))`; the effective cluster count is
`1 / sum(w_j^2)`. This follows from bounding each weighted contrast in an interval
of length 2w_j. Dependence or outcome-related weights invalidate treating it as a
sampling guarantee. In particular P_j is learned during annotation, so conditioning
on realized weights does not by itself validate population-ratio inference. The
concentration center in this planning model is sum(w_j * E[D_j]). Zero-positive
clusters have no defined D_j and no primary weight but remain in coverage, cost and
false-alert denominators; if total P=0 the primary metric is undefined. Unequal
weights and lineage aggregation reduce the effective count. Clip resulting limits to [-1,1], not the raw half-width.

Even the optimistic equal-weight 19-independent-cluster scenario gives about **0.623**
half-width under that conservative bound; 13 gives about **0.753**. Achieving
half-width 0.20 by that bound would require at least **185** effective clusters;
0.10 would require **738**. These are illustrative worst-case sufficient counts,
not required sample sizes, powered estimates, an adopted sampling change or
confidence intervals for the present deterministic merged-PR frame. Observed
variance may support a smaller justified design, while clustered/uneven issues can
make nominal N misleading. A full census describes its frame; it does not create
random-sample inference to new PRs. Rater agreement alone cannot certify ground truth.

The current W2 cap remains 19 PRs. If pilot-informed planning cannot justify the
chosen precision/claim within those candidates and resources, retain W2 as a bounded
descriptive holdout or stop; do not call it powered confirmation. Expanding to other
windows/repositories requires a separately authorized protocol and sampling frame,
not opportunistic expansion here. If confirmation is eventually viable, use one
final analysis, retain failures/Unknown and all selected denominators, and interpret
an interval spanning no benefit as inconclusive for improvement. If its upper bound
is below the prespecified worthwhile benefit, report futility for that benefit.
Neither a small positive point estimate nor a nominal p-value overrides coverage,
contamination, false-alert or budget failures.

### Concrete lower-budget options and limits

| Option, not current assignment | Initial double rating | Adjudication reserve | Administration reserve | Bounded subtotal |
| --- | ---: | ---: | ---: | ---: |
| A only: existing 3 W0 × 1 family × 15 min/rater | 1.5 h | 0.75 h | 0.5 h | 2.75 h |
| B only: all 13 W1 × 1 family × 30 min/rater | 13 h | 3.25 h | 1.75 h | 18 h |
| W2 descriptive option: all 19 × 1 family × 30 min/rater | 19 h | 4.75 h | 2.25 h | 26 h |
| W2 broader option: all 19 × 2 families × 30 min/rater | 38 h | 9.5 h | 4.5 h | 52 h |
| W2 maximum option: all 19 × 8 families × 30 min/rater | 152 h | 38 h | 18 h | 208 h |

The staged one-family A+B+W2 option totals **46.75 annotation/administration hours**
only if each gate passes; stopping after A spends at most 2.75. These are transparent
caps/assumptions, not measured productivity or guaranteed completed labels. Preparation
is counted only within the small ledger/packet administration reserve; substantive
rule design, acquisition, security/interface work, contamination audit and model cost
must have separate visible budgets before commitment. Two/eight-family reserve
amounts assume linear scaling, not measured productivity; there is no borrowing from
later stage budgets after a cap is reached. Detection uncertainty does not substitute
for separate false-alert/precision uncertainty and exhaustive alert accounting. Third-rater overflow or missing
context becomes disputed/partial and can trigger futility, never rushed consensus or
unrecorded unpaid work. Fewer families narrows the claim while preserving the PR frame.
No lower-budget option removes the two-rater independence requirement.

The immediate deliverable is this staged proposal, with all labels unassigned. True
next blockers are a defensible family and independent human/access resources even
for Stage A; later collection and model budgets are separate gates. Bridge validation
on retained W0 exports can proceed independently and supplies no efficacy signal.

## Decisions and actual blockers before collection

Defaults settled by this proposal: current-capture primary study, W2 frame census,
W0/W1 development separation, paired issue detection, explicit unknowns, two independent
human raters plus independent adjudication, bounded equal evidence, versioned freezing
and contamination accounting. No generic research-owner approval is needed to finish
this document or its audits.

Before any collection, record a versioned acceptance or revision of: real family and
rubric definitions; baseline/arm information, budgets and primary matching rule;
frame eligibility and lineage procedure; calibration/search time budget; access UI,
privacy controls and evidence allowlist; acquisition scope/request/disk budget; and
whether historical analysis is desired. Publish the accepted protocol digest before
new W2 access. Changes afterward require a dated deviation and exploratory labeling;
this does not retroactively preregister anything.

True current blockers are (1) no established real reusable rule/family or reference
rubric, (2) no assigned independent qualified human raters/adjudicator or confirmed
time resources, (3) no controlled annotation interface/access assignment, and (4) no
authorized W1/W2 source collection/model execution budget. Historical availability
proof is an additional evidence blocker only for the optional historical claim,
not an excuse to block a correctly labeled current-capture design. These require
substantive inputs/resources/authorization, not fabricated placeholders. No person
is recruited, no packet shared and no model invoked by this proposal.

The retained six W0 exports/cache remain available for the native bridge. Their
missing real episode labels, frozen eligible task semantics and historical evidence
must produce explicit blocked records with reopen persistence, not authored eligible
runs. Bridge contract success is independent of human-label or scientific validity.
