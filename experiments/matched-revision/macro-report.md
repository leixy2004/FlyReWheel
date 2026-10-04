# Descriptive repository and rule-family aggregation

`aggregateMatchedResults` consumes the existing frozen packet, future and completed
legacy runner report. Supply every planned episode/repetition, including
`report: null` for missing records. This is an authored-only reporting extension,
not an empirical study or a replacement result/execution framework. The current
single-repository protocol remains unchanged. SDK-native reports are rejected
until their separate planned block roster can be bound by a reader.

## Reproduce without model calls

```sh
node --import tsx experiments/matched-revision/macro-replay.ts \
  --from-contract-smoke experiments/matched-revision/contract-smoke \
  --out /tmp/flyrewheel-macro-report.json
python3 experiments/matched-revision/macro-reference.py
npx vitest run tests/matched-revision.macro-report.test.ts \
  tests/matched-revision.evaluation-contract.test.ts \
  tests/matched-revision.experiment.test.ts --maxWorkers=1
npx tsc --noEmit
```

The output filename must be new. The CLI reads only the existing checked-in
contract fixture and executes no runner, transport or model. `macro-smoke/report.json`
is its deterministic saved output. It contains one planned authored unit, four
arms, zero empirical episodes and no estimated uncertainty interval. Fixture
scores are not evidence of method efficacy.

## Estimand and weights

For each metric, calculate its existing per-target denominator within each
arm/episode/repetition. Form H−U and H−M **inside that paired unit**. Average
repetitions within an episode, episodes within a rule family, families within a
repository, then repositories equally. The four supported outcomes are positive
recall, repeated-feedback false-alarm rate, strict resolution and coverage. The
positive recall guard and strict-resolution companion therefore survive alongside
the primary false-alarm contrast. Contrasts always mean H minus baseline; a
negative false-alarm contrast is directionally favorable, but no win is inferred.

This estimates a descriptive equal-repository/equal-family/equal-episode/
equal-repetition average on the supplied planned roster. It is not pooled finding
accuracy or a population estimate. A repository with many findings/families does
not receive greater final weight. Condition, diagnosis-category set, complete
settings and protocol digest define separate strata. They are never pooled.
Repetitions may not change their frozen packet/future; their IDs remain caller
declarations, not verified independent random draws or native schedule receipts.

Unknown/disputed reference labels remain in the audit counts and retain the
existing scorer's denominator semantics. Abstentions and administrative failures
remain observations, not exclusions or successful resolutions. Any undefined
required denominator or missing report propagates `null` to the full-roster macro
and paired contrast. `completeCaseDescriptive` is separately labelled at each
hierarchical level with planned/estimable child counts; it must not be substituted
for the full-roster estimate. A missing report's administrative per-arm scores
are bookkeeping only and never enter macro averages or imply a zero effect.

## Uncertainty and sampling unit

All reports currently withhold intervals. Mandatory reasons are authored inputs
with zero empirical episodes, no verified probability sample/independent
repository clusters, and no frozen confirmatory inference plan. Missing execution
records, zero required denominators and unresolved labels add explicit reasons.
There is deliberately no JSON flag that converts authored records into evidence.

A future probability-sampling adapter would have to establish the target
population, frozen eligible roster, repository/lineage independence, selection
mechanism, estimable paired outcomes, prespecified confidence level and handling
of missingness/multiple outcomes. Findings, anchors, families and repeated seeds
inside the same repository are not independent sampling units. Shared lineages
across repositories can invalidate even repository-level independence. Fixed
convenience cohorts/censuses alone do not warrant superpopulation intervals.
Label error, unknown labels, contamination and selection bias are not sampling
uncertainty and are not covered by a confidence interval.

`boundedRepositoryDifference` is a separately labelled mathematical reference:
for n independent bounded repository contrasts X in [−1,1], the two-sided
Hoeffding bound gives half-width sqrt(2 log(2/alpha)/n), clipped to [−1,1]. Its
target is the mean of the repository expectations under that sampling process;
at least two valid repository values are required here. It is conservative,
often vacuous for small n, and is never attached to current reports. The bound
and independence assumptions follow [Duchi's CS229 notes on Hoeffding's inequality](https://cs229.stanford.edu/extra-notes/hoeffding.pdf).
The elementary closed form adds no statistics package or bootstrap machinery.
A separate Python Decimal/Fraction reference checks the numerical implementation;
these calculations verify arithmetic, not empirical coverage.

## Identity, costs and trust

The reader validates packet/future digests, repository/rule scope, unique planned
slots and report digests, exact four-arm and call-stage rosters, shared diagnosis,
common inputs and complete model/request settings. Reusing the same report in a
second repetition is rejected. Proposal, gate acceptance and effective states are rebuilt from raw calls.
Future observations are rebuilt from the raw call output/status; metrics and paired differences are recomputed rather than trusted
from cached scores. These checks catch structural inconsistency, not coordinated
fabrication; digests do not authenticate label truth, independent execution,
lineage independence or real monetary usage.

Standalone costs include measured invoked calls and each U/H/M arm's share of
upstream diagnosis cost. Unknown usage/cost remains null, with a separate known
lower bound and unknown-unit count. Never add standalone totals across arms to
claim physical shared-diagnosis billing. Missing reports cannot become free runs.
