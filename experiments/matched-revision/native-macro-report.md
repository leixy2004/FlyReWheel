# Native schedule to descriptive macro report

The supported native input is `NativeMacroInput` consumed by
`aggregateNativeStudy`: the existing `SdkNativeStudyReport`, its canonical
configuration, the complete frozen `SdkNativeStudyInput[]` source roster, and an
explicit repository/lineage cluster mapping. The existing schedule, call,
diagnosis, packet, proposal, gate and scoring validators are reused. This adds
reporting to the existing native study; it does not create an execution backend.

## Run

Generate an authored end-to-end example with the existing supervised SDK fake
executable, two independent scheduled executions and one deliberately missing
repetition:

```sh
node --import tsx experiments/matched-revision/macro-replay.ts \
  --native-authored-smoke /tmp/flyrewheel-native-macro-example
```

The directory must be new. This invokes authored local scripts, never a model,
provider, credentials or a data collector. It writes `input.json` containing the
canonical native inputs/results and `report.json`. The shared diagnosis is
executed once per supplied inferred block; the third planned block remains
missing. The fixture supplies scripted tokens but leaves every monetary cost
unknown, exactly as the native contract requires.

Replay the saved input without invoking any executable:

```sh
node --import tsx experiments/matched-revision/macro-replay.ts \
  --native-study /tmp/flyrewheel-native-macro-example/input.json \
  --out /tmp/flyrewheel-native-macro-replay.json
cmp /tmp/flyrewheel-native-macro-example/report.json /tmp/flyrewheel-native-macro-replay.json
```

The output file must be new. The same commands work with the checked-in
`native-macro-smoke/input.json`. Replaying the same saved input is deterministic.
Regenerating the authored study records fresh process IDs, times and diagnosis
lock identities, so a fresh execution need not have the same digest.

## Inputs and identities

`sources` must include the exact frozen packet/future for **every** scheduled
block, including blocks absent from execution. Missing frozen sources are an
error: their labels/denominators cannot be invented. By contrast, an explicitly
missing block result or absent result row remains on the planned schedule and
contributes null. For absent result rows, the imported report's status counts must
match its retained rows; `plannedBlocks` continues to match the full schedule.
This is marked `resultRecordAbsent` rather than asserted to be a returned runner
record. Duplicate block rows are rejected, even if byte-identical, to prevent
counting an imported recovery result twice. Reordered result/source arrays are
joined by block ID; changing the frozen schedule order is rejected.

Each block is bound to episode, condition, repetition, source/future identities,
arm order and target order. Every returned native call is checked against its
canonical call schema, frozen configuration, exact scheduled ID, actual request,
raw output and next-slot position. Proposal, gate and effective state are rebuilt
from raw records even for interrupted prefixes. Supplied and independently
executed authored diagnoses are both supported; pending inferred inputs keep
their original packet identity, while the separately validated locked diagnosis
supplies the common revision input.

Returned interrupted calls, shared diagnosis receipts and uncertain next-call
intents are retained. No partial report is promoted to a completed observation.
Uncertain intents require the exact next planned request digest. Unverified
cleanup or uncertain completion prevents acceptance of later new invocations;
chronologically completed earlier recovery records may still be read. These are
consistency checks on declared receipts, not proof of external execution.

## Statistical and cost boundaries

The same macro aggregator computes within-unit H−U/H−M contrasts and equal
repetition → episode → family → repository averages. Cross-repository equal
weighting remains a documented descriptive extension beyond the original
single-repository estimand. Native strata separate condition, frozen native
configuration, schedule, protocol and optional evaluation context. They do not
split repetitions according to a diagnosis produced after execution.

`clusters` supplies exactly one row per repository:
`{repository, clusterId, lineages}`. The lineage set must exactly cover all
revision, gate and future lineages in its frozen inputs. Shared lineages across
repositories must map to the same declared dependence cluster. Cluster mapping
is hashed and reported; it changes neither repository weights nor the number of
independent empirical samples. A shared lineage ID is treated conservatively as
a shared dependency. Independence cannot be established from declared IDs.

Missing/interrupted reports propagate null through full-roster arm and paired
macros. Complete reports with failed/unresolved calls retain the known reference
denominators. Unknown/disputed labels, abstentions and zero denominators preserve
the existing scorer's meanings. Raw native token usage is retained per call;
monetary totals remain null even when model calls are zero. Known lower bounds
are explicitly separate and never estimates of billing. Shared diagnosis records
are preserved once physically, with the existing standalone allocations checked.

Every empirical interval is withheld: authored inputs have zero empirical
episodes, no verified probability sample/independent clusters and no frozen
confirmatory inference plan. Missing records, zero required denominators and
unresolved labels remain additional reasons. The separate Hoeffding arithmetic
reference now computes `log(2) - log(alpha)` to remain finite even at
`Number.MIN_VALUE`; it does not issue an empirical interval.

## Verification

```sh
npx vitest run tests/matched-revision.native-macro.test.ts \
  tests/matched-revision.macro-report.test.ts \
  tests/matched-revision.sdk-native-schedule.test.ts \
  tests/matched-revision.sdk-native-diagnosis.test.ts \
  tests/matched-revision.sdk-native-recovery.test.ts --maxWorkers=1
npx tsc --noEmit
npm run build
```

Tests cover provided/inferred diagnoses, missing and interrupted results, uncertain
intents, unknown costs, all-Unknown/zero denominators, duplicate/reordered imports,
identity/request/diagnosis tampering, within/across-block fail-stop, shared lineage
mapping, byte-identical CLI replay and extreme-alpha JSON serialization. Statistical
and code-integrity reviewers independently inspect the implementation. No efficacy
result, real model run, new data acquisition or main-branch merge is claimed.
