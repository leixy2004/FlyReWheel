# SDK-native configuration and call-record contract

This import-only local slice implements **configuration and audit-record validation**
and the authored executable integration described below
for `paired-restriction-sdk-native-v1-draft`, following the
[study amendment](../../paper/experiment-protocol/sdk-native-study-amendment.md).
It does not adopt/freeze the study or enable inference. No source, label, token,
billing, authority or execution evidence is supplied by these schemas or tests.

## API and meaning

- `sdk-native-contracts.ts` exports separate schema-version-1 configuration and
  call-record kinds, inferred TypeScript types and strict Zod schemas
- `validateSdkNativeConfiguration(raw)` validates canonical JSON inputs and returns
  a frozen copy. A single construction/diagnosis/proposal/review settings map is
  shared across arms. Explicit reasoning effort uses the existing SDK enum;
  omission stays unspecified, without inserting a default
- Temperature, generation seed and generation output-token cap are explicitly
  `unsupported_in_pinned_typed_sdk`. Requested/applied values, including null or
  zero placeholders, are forbidden. The scheduling seed is solely for assignment
  and order; repetition/algorithm/roster/target-schedule declarations are distinct
- Limits declare canonical serialized request/schema bytes, UTF-8 rendered state
  (including M's retained lesson/delta/overhead), role-specific answer bytes,
  raw stdout+stderr and forwarded/event bytes, time and dispatched/provider calls.
  Existing supervisor maxima are reused. Timers include setup, execution, cleanup
  and allocated shared diagnosis. The schemas declare these counters; the authored
  integration below supplies measurements and enforcement for its bounded slice
- `validateSdkNativeCallRecord(raw, configuration)` checks configuration identity,
  role/arm settings, monetary-policy bindings and reported limits. A completed
  record needs matching applied settings and launch/configuration evidence,
  reported enforcement, complete byte/time/call measurements within limits and an
  external monetary-admission record. Failures retain overshoots, mismatched applied
  settings, unauthorized attempts and missing measurements without becoming valid
  answers. Every dispatched record represents one SDK invocation; provider calls
  are counted separately. Shared construction/diagnosis has no physical arm charge
- Raw SDK token names are individually nullable and are never summed. Observed
  currency is either unknown (null), supported by an authoritative billing-record
  digest, or explicitly an estimate with an assumptions digest. Null never means
  zero. This slice computes no cost totals, efficiency or cost-dominance result
- Monetary admission is `not_evaluated`, `blocked`, or an explicitly identified
  external admission/authorization record. Hard ceilings require matching currency
  and whole-study limit, authorization, mechanism, in-flight-reservation and
  stop/overshoot evidence digests. Alternative exposure binds its authorization and
  stop/reconciliation policy. Recording a digest does **not** verify the evidence,
  create authority, reconcile spend or permit a launch
- SDK policy, application checks, process-group stop, external isolation,
  whole-runtime destruction and remote-generation stop remain distinct fields.
  Unknown external/remote containment does not become verified from local cleanup

The call record is an audit fragment, not an empirical packet, whole study record,
scorable result, full failure roster or trusted runtime receipt. An R=1 configuration
can describe feasibility only, not estimate run variation. Canonical digests prove
byte identity, not provider acceptance, provenance, execution or authorization.

## Deliberately still pending

Operational native request/worker/transport admission and effective-settings
verification; independently verified isolation and billing admission; monetary
stop/reconciliation; real-model construction/diagnosis and empirical allocation;
analysis and empirical source/label/memory-baseline
readiness remain unimplemented. Authored byte/state/count/deadline enforcement,
unknown-usage stopping, supplied-diagnosis elapsed allocation, the separate authored
diagnosis-only stage below, and complete no-retry
failure/target rosters are implemented below. An optional authored repeated-block
manifest now resolves and checks schedule digests; a configuration alone remains
an unverified declaration.
Passing this validator cannot clear any of these gates or authorize a next call.

The old `SettingsSchema`, authored packet format, paper `record.schema.json`,
mandatory sampler/token controls and production `not_run` behavior are unchanged.
Old requests do not accept this profile. The separate authored-native worker kind
is rejected under the operational isolated-runtime boundary. The legacy authored
branch and its unknown-usage dispatch blocker retain their behavior.

Local checks: `npx vitest run tests/matched-revision.sdk-native-contracts.test.ts
--maxWorkers=2`, `npm run typecheck`, and `npm run build`. All fixtures are authored
contract examples; none are live SDK, isolation or billing evidence.

## Authored executable integration

`runMatchedRevision({ mode: 'authored_fixture', packet, future, native: {
configuration, repetition, transport } })` now runs this profile through the
existing F/U/H/M orchestration. Obtain `transport` only from the import-only
`createAuthoredCodexNativeMatchedTransport({ workingDirectory, fixtureRoot,
codexPathOverride })` factory. It requires an explicitly authored executable in
its fixture root and invokes the existing supervised SDK worker. An injected
callback, serialized admission record, native configuration or production flag
cannot enable a real backend. No CLI or environment switch enables this slice.

This is a single already-frozen authored block. The packet's arm order and complete
gate/future rosters remain fixed. By default construction/diagnosis are supplied
data, not fabricated native calls; the explicit authored diagnosis-only option
below executes a separately identified SDK script. The configuration's runtime digests remain unverified
declarations. Without the optional schedule binding below, its schedule digests
also remain declarations. Effective provider settings are not implemented. The
selected repetition must be within the declared range.

The native request has a separate profile-tagged strict schema and contains no
sampler or output-token ceiling. Proposal prompts render the native configuration
as their budget; legacy token budgets remain only in the source packet's provenance.
One role-settings map is shared across F/U/H/M. Native persistent-state checks count
`renderState()` bytes including all retained M text and rendering overhead.

The native ledger enforces canonical request/schema bytes before dispatch,
role/arm attempt counts, rendered-state bytes, accepted final-answer bytes,
combined stream/forwarded bytes and per-call/arm deadlines. The existing supervisor
uses the tighter combined/forwarded stream ceiling, and separately checks its
worker-envelope overhead. Cancellation waits for the existing supervised cleanup;
late or oversized answers remain failures and never enter review scoring. Setup,
execution and cleanup phases are measured, with conservative integer rounding.
Known supplied diagnosis elapsed time is allocated to U/H/M; unknown upstream time
blocks their dispatch and stays null. Every planned proposal/gate/future slot and
every target row remains in the report after call or budget failure.

New `authored_completed` records are explicitly `authored_sdk_no_model` and are
validated against the native configuration. They record SDK invocations separately
from zero provider/model calls, no monetary admission, unknown currency/cost, null
applied/effective provider settings, and null external/remote runtime evidence.
Their launch receipt binds forwarding to the authored SDK process, not provider
acceptance. `authored_supervised` describes only local byte/time/call checks and
process-group stop. Real `completed` record requirements are unchanged.

The native supervisor captures actual JSONL usage fields before the pinned SDK's
normalization of absent cache-write usage to zero. Missing fields remain null,
including on malformed/incomplete outputs; no overlapping token totals or billing
estimates are computed. Unknown usage blocks later calls in that arm; unverified
cleanup blocks later launches through that transport across arms. Cost remains
unknown even when all raw usage fields are present. Cleanup-removal failures retain
measured process and raw-usage receipts and stop later launches across arms;
stream-limit failures stop later work in an arm even when usage was fully reported.
Continuing authored mechanics
with zero provider calls does not reconcile money or authorize real execution.

Focused integration coverage: `tests/matched-revision.sdk-native-execution.test.ts`.
The earlier “deliberately still pending” section applies to operational/empirical
execution; authored-native request, supervision and failure-roster mechanics are
now implemented as described above.

## Frozen authored repeated-block schedule

`createSdkNativeSchedule({ schedulingSeed, repetitions, conditions, blocks })`
in `sdk-native-schedule.ts` returns a deterministic, deeply frozen, version-1
manifest. Each source block supplies `{ packet, future, repetition }`. The explicit
condition list is canonical (`provided`, then `inferred`, or either alone), and
all episode × declared condition × repetition cells must be present at creation.
Input list order does not affect the manifest. The manifest fixes algorithm and
content digests, packet/diagnosis/gate/future identities, PR/family/lineage target
identities, planned block/arm/target order, one proposal slot and no rerolls.
It binds authored data before proposal/review outputs, not a live study freeze.

The versioned `sha256-williams-paired-block-v1` algorithm uses SHA-256 sorting of
canonical `[schedulingSeed, domain, value]` tuples, with canonical code-unit tie
breaking. No ambient PRNG or model seed participates. It randomizes episode/repeat
groups and keeps each group's O/I blocks adjacent. Each two-repeat cycle
counterbalances O/I order. Within every episode/condition/four-repeat cycle, seeded
arm labels and row permutations of a Williams square balance all four positions
and all twelve directed adjacent-arm pairs. Incomplete cycles have incomplete
balance; R=1 is feasibility only. Targets are independently hash-permuted per
block, and every arm receives exactly that order. This is matched input/order
pairing, not shared model random draws or guaranteed removal of provider drift.

`bindSdkNativeScheduleConfiguration(configuration, manifest)` resolves the existing
native scheduling fields to this manifest's block-roster and target-schedule
digests. `validateSdkNativeSchedule` reconstructs the algorithmic schedule and
rejects changed identities/order even when the outer digest was recomputed. A
bound configuration is still required to detect substitution with another
self-consistent manifest. Hashes establish identity, not external authenticity.

The existing `runMatchedRevision` accepts optional `native.schedule: { manifest,
blockId }`; it validates source bindings and repetition before dispatch, consumes
the manifest's order without rewriting the original packet/future identities,
and uses schedule-specific block/call IDs. Reports mark schedule digests verified
only on this path. Shared diagnosis, gate G, H-only proposal restrictions and all
byte/call/time/unknown-usage/cleanup checks remain in the original loop.

`runSdkNativeStudy({ mode: 'authored_fixture', schedule, configuration, blocks,
transport })` in `sdk-native-study.ts` is a thin sequential driver of that same
loop. Execution inputs are `{ blockId, packet, future }`. Every supplied input is
snapshotted and checked before the first dispatch; duplicates, unknown blocks and
identity substitutions fail closed. Missing execution inputs retain their planned
block/arm/proposal/gate/future roster. Each supplied block runs once in manifest
order, with independent fresh SDK calls even for identical effective states.
There is no cache, best-repeat choice, retry, replacement, resume or live backend.
There is no durable cross-process execution registry; rerunning this local API
must not be represented as additional independent empirical evidence.

The report keeps completed/failed/missing block counts, full per-block reports,
per-slot and per-target statuses, actual call order and UTC start/finish timestamps.
Unexpected interruptions retain observed call records and mark unreturned outcomes
missing; they cannot establish that no dispatch occurred. Authored episode
identities, planned repeated blocks and empirical episodes are separate counts;
empirical episodes and provider model calls remain zero. Raw H−U/H−M comparisons
stay within each block, with no selected-run or cross-condition aggregate analysis.

The default schedule uses supplied, locked records. O reuses the same locked diagnosis;
I requires a distinct supplied attempt identity per repeat. This default does not execute
or validate independent diagnosis inference. Its native authored gate
continues to block nonzero upstream model-call records, including the authored
I-condition declarations used to test complete failure rosters. A future live
pre-output schedule and real-model diagnosis-only runtime still need operational
implementation and admission. Runtime pins, monetary authorization, source/label readiness, statistical
aggregation/uncertainty/missing-run rules and empirical study adoption stay open.

Schedule checks: `npx vitest run tests/matched-revision.sdk-native-schedule.test.ts
--maxWorkers=2`. These are authored mechanics, never efficacy or billing evidence.

## Independent authored diagnosis-only stage

`sdk-native-diagnosis.ts` supplies the bounded, import-only authored analogue of
the I-condition dependency. `MatchedDiagnosisSchema` is a reusable strict response
contract: one cited diagnosis per selected feedback plus original/revision context
status. It has no proposal, state, arm, provenance, condition, or identity fields.
The separate `matched-diagnosis-v1` worker contract accepts only
`authored-sdk-native-no-model` under the authored executable boundary. The legacy
request schema and operational isolated-runtime admission still reject this path.

1. Create each inferred input with
   `prepareAuthoredSdkNativeDiagnosisPacket(packet, future, repetition)`. It freezes
   an explicit `authored_sdk_diagnosis_pending` Unknown slot, zero upstream model
   calls and null usage/time/cost, without inventing an executed inference. Pending
   inputs are native-only; produced outcomes cannot be resubmitted as supplied packets
2. Freeze the schedule with
   `diagnosis: 'authored-sdk-once-per-inferred-block'`, then bind its configuration
   and run the existing study driver. The schedule rejects supplied inferred outputs
   in this mode, and rejects pending slots in supplied-only mode. Provided-condition
   blocks remain unchanged. For a single unscheduled authored block, explicitly set
   `native.diagnosis: 'authored-once-per-episode-repeat'`
3. Before any arm work, the runner sends one diagnosis-only request using the
   shared diagnosis-role settings, fresh thread, fixed schema and existing supervisor.
   An allowlisted input includes the old rule, selected original review/source/feedback,
   public source-case obligations, visibility and citation inventory. It excludes the
   supplied diagnosis, gate answer roster, all future targets/labels and H-only edit policy
4. Source validation requires exactly one diagnosis per selected feedback, unique
   supplied references, each feedback's own citation and its selected context citations.
   Malformed, uncited, duplicate, failed, late or oversized results lock an administrative
   `insufficient_evidence`/Unknown outcome with the original failure; they never reroll.
   A valid insufficient-evidence answer remains a proposed Unknown, not a positive cause
5. The outcome has its own `matched-revision-sdk-native-authored-diagnosis` record,
   `authored_sdk_no_model` execution kind and `authored_sdk_diagnosis_no_model`
   supervision origin. It is frozen once per transport/episode/repetition; repeated
   reads return the same promise/output and changed input/configuration/block bindings
   are rejected. U/H/M receive byte-identical locked diagnosis and common revision input.
   A process restart or new transport is outside this in-process lock; it supplies no
   additional independent empirical evidence
6. The shared native call has `arm: null`. The report counts its physical SDK invocation
   once and gives each U/H/M standalone budget the same dispatch count, elapsed time
   including setup/cleanup, nullable raw usage, and unknown monetary cost. F receives
   no standalone diagnosis charge. Thus a one-diagnosis/one-proposal/two-review arm needs
   four allowed standalone SDK dispatches. Token fields are not added together and null
   cost is never converted to zero. Unknown usage, unverified cleanup, timeout or bound
   overshoot blocks dependent U/H/M dispatch; failed but bounded/counted answers can
   proceed using administrative Unknown. Transport-level cleanup fencing still applies
   across all arms

The study report retains the diagnosis slot for every planned inferred block, including
missing inputs and reporting interruptions, and records the shared call before actual
arm calls. Original packet/schedule identities remain pre-output inputs; the locked
outcome is reported separately, never retroactively substituted into those identities.
All proposal/gate/future slots and target rows remain present after diagnosis failures.
No CLI, live-model fallback, operational runtime proof, billing admission, external
source/label acquisition, or empirical diagnosis result is enabled.

Focused coverage: `tests/matched-revision.sdk-native-diagnosis.test.ts` and
`tests/matched-revision.sdk-native-diagnosis-worker.test.ts`, plus the existing
native execution/schedule and legacy matched suites. These validate authored wiring,
source-ID constraints and failure mechanics, not semantic attribution accuracy.
