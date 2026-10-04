# Proposed annotation and temporal-visibility protocol, v0.1

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
