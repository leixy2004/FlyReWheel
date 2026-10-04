# Matched frozen-diagnosis runner: local fixtures and Codex bridge

This separate research module closes the **shared diagnosis → one matched proposal → common gate → fixed later roster** interface gap. It does not run a real experiment, freeze W0/W1/W2, generate a benchmark, acquire sources, infer diagnoses, annotate cases, or activate rules. Production execution deliberately returns `not_run: production_adapter_unconfigured`, even with an injected callback or authored SDK transport. The default fixture needs no SDK invocation. The optional local bridge tests the existing official SDK with authored mock executables; neither path needs credentials, network, a database, or a new dependency.

## Run

```sh
npm run experiment:matched -- --fixture /tmp/matched-revision-example
npx vitest run tests/matched-revision.experiment.test.ts --maxWorkers=2
npx vitest run tests/matched-revision.codex.test.ts tests/workspace-worker-entrypoint.test.ts --maxWorkers=2
```

The output directory must be new. `packet.json`, `future.json`, and `report.json` contain all inputs, requests, bounded raw outputs/failures, effective states, gate diagnostics, per-target observations, usage and paired H−U/H−M differences. Existing files are never replaced. The TypeScript API is `runMatchedRevision({ mode, packet, future, transport })`; it accepts an already digest-locked episode plus a separately locked future roster. The CLI intentionally exposes only the built-in authored fixture.

The fixture uses the **same authored candidate in U/H**, an equivalent authored memory delta in M, and **identical scripted review predictions in every arm**, including F. Consequently the demonstration does not manufacture a method win. It reports zero model executions, zero empirical episodes and zero independent human annotations. These outputs test plumbing, not accuracy, diagnosis quality, memory competence, chronology, or effect size.

## Contracts and enforcement

- F retains the incumbent and receives diagnostic gate/future reviews
- U and H use exactly the same strict proposal envelope and structured-content schema. The shared evidence/feedback/diagnosis/budget block is byte-identical. Only their edit policy changes
- H internally injects the immutable supplied per-feedback diagnoses into the existing `validateRevisionModelResponse` / `diagnosis-operators-v1` validator. Its jointly generated diagnosis prompt is **never sent**. Boundary retention stays invalid; context requests do not acquire evidence; inferred contract diagnoses reach the existing replacement branch
- U does not enter H's validator. It may revise all supported rule-content fields or retain/abstain/request context. Both structured arms retain product rule-schema validation, immutable provenance/obligations and exact evidence identities
- M begins with a lossless rendering of the same content. It permits one `revise`, `qualify` or `suppress` delta. The immutable initial lesson plus the delta count toward the persistent-state cap. Suppression still reviews every scheduled target
- Non-mutation, invalid output and rejection consume the single scheduled proposal slot; there is no retry, reroll or gate-conditioned rewriting. Only a valid changed proposal passing every gate obligation becomes effective. Otherwise the incumbent is evaluated on the entire later roster
- Gate feedback rows must bind the selected finding's exact snapshot/source/path/issue scope and TP/FP expectation. Historical regression labels and positive obligations cannot change. Revision-consumed source digests and declared lineages cannot reappear as future targets
- Review prompts contain only content-only persistent state and the fixed source/issue packets. They omit diagnosis, proposal rationale, gate answers, reference labels and sibling outputs. Rule provenance is not used as hidden persistent memory
- A declared provided or inferred diagnosis is preserved with its context status and upstream provenance. This runner does not turn authored/model records into independent human diagnoses. An administrative failed inference requires the original failure and `insufficient_evidence` records; it is never rerun
- All arms have the same frozen models, sampler/seed and resource ceilings. Actual authored dispatches, zero current model calls, failure counts, known usage, unknown usage and timing are separate. Shared upstream diagnosis cost is reported once physically and charged to each U/H/M standalone budget. Unmeasured upstream usage blocks further dispatch rather than becoming free computation

## Review/memory adapter boundary

`AuthoredTransport.execute(request, signal)` is the runnable **test adapter**, not a credentialed runtime. It returns a strict result, bounded output and usage. Requests declare model, sampler, response schema and output limit. It must honor cancellation; the runner also rejects late returns, including callbacks that block the timer. JavaScript cannot forcibly terminate an arbitrary injected function, and no isolation is claimed.

The common review request takes the rendered effective state and every exact target/issue scope; a memory implementation must interpret `revise` as replacing the active lesson, `qualify` as a local qualification, and `suppress` as disabling it. The retained original text is audit-only under replacement/suppression. This is an explicit **local-delta memory representation and review interface**, not a heuristic that pretends to implement or validate a competent external memory system. A future real adapter must demonstrate these semantics, use a frozen model-tokenizer and trusted no-tools runtime, support exact evidence/scope assessment, and document the chosen memory method before empirical comparison. No such adapter or competence result is supplied here.

The current packet reuses the product's selected-evidence revision graph, including its versioned context-citation rules. It supports detectorless or proposal-schema-compatible structured content. It is not a general W0/W1 assembler or an independent newly acquired context store. Extra restored context needs a separately validated common-evidence adapter before real use; declaration text alone is not a source record.

## Bounded official Codex SDK bridge

`src/adapters/matched-revision-codex.ts` reuses `runCodexWorkspaceWorker`, its official pinned SDK, supervisor and cancellation/cleanup receipts. Shared response schemas live in `src/core/matched-revision-model.ts`, allowing the same fixed `matched-proposal-v1` / `matched-review-v1` contracts to pass through both the source and freshly compiled worker entrypoint. The proposal contract does **not** use the product's joint diagnosis-generation prompt or its H-only revision response. U/H/M retain their existing edit-policy text; F has no proposal. The bridge forwards each original prompt without additions and checks its schema against the fixed stage schema. Gate and future use the same review contract and selected-evidence/no-tools policy. Every call opens a fresh SDK thread.

Two deliberately different APIs are exposed:

- `runMatchedCodexRequest(request, context, dependencies, signal)` preserves all current mandatory frozen controls. `preflightMatchedCodexControls` reports that SDK 0.159.2's typed `ThreadOptions` / `TurnOptions` cannot enforce temperature, seed or a generation output-token cap. Dispatch fails before executable launch or runtime verification. No guessed config keys, prompt instructions, byte limits or postflight token counts are represented as these controls
- `createAuthoredCodexMatchedTransport({ workingDirectory, fixtureRoot, codexPathOverride, limits })` is an import-only test seam using an author-controlled script inside its explicit fixture root. It records `controls: not-enforced-authored-script`, the SDK version, raw scripted usage, session ID and process-group stop receipt. There is no default executable, authentication, gateway, CLI switch or environment switch. The authored exception is rejected under an isolated-runtime boundary and is never a production fallback

The worker bounds input/schema bytes, raw stdout/stderr bytes, execution time and cleanup time. The matched ledger still uses its explicitly fixture-only UTF-8 byte upper bound and postflight acceptance checks. Scripted SDK usage is distinct from real-model usage; known fixture cost is zero because no inference occurs. Failed calls preserve measured usage when available; malformed/missing usage stays null and stops that arm's further dispatch. On a runner timeout, the bridge allows a bounded wait for the existing worker's cancellation receipt, never accepts a late result and never retries. Unverified cleanup prevents subsequent bridge launches. A process-group stop remains weaker than whole-runtime isolation, as documented for the existing worker.

An optional shared `settings.modelReasoningEffort` passes unchanged through every
proposal/gate/future request, the bridge and the worker's typed SDK
`ThreadOptions.modelReasoningEffort`. SDK 0.159.2 declares `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`, `ultra` and `persistent`; other values, including
`null` and `none`, are rejected before launch. Omission preserves existing
requests and emits no reasoning-effort override; it does not select or attest a
model/service default. U/H/M have no arm-specific override, and F uses the same
setting for its reviews. Explicit values appear in `processEvidence.modelReasoningEffort`,
including failed-process receipts retained by the transport and matched ledger.
That field records forwarding, not real-model acceptance or measured reasoning.
Authored tests inspect the exact SDK-generated `--config model_reasoning_effort="…"`
argument through the bridge and both source/freshly compiled worker entrypoints.
This optional plumbing does not amend the frozen mandatory controls, enable
production, or turn the proposed SDK-native study amendment into an execution freeze.

No ready production transport, real model tokenizer, authenticated gateway, measured monetary-cost source, source/label cohort, temporal audit or competent memory-baseline validation is supplied. The outer production workspace runner and OpenSandbox adapter are not enabled for matched experiments in this increment. Packet origins, tokenizer selection and frozen control requirements remain unchanged.

An SDK-native study could instead explicitly freeze temperature/seed as **unset or unavailable**, hold all supported native settings equal, and distinguish enforced byte/time/call limits from measured token usage and postflight budget rejection. Missing seed/temperature controls do not by themselves prohibit a valid scientific comparison. That would be a separately versioned protocol decision, requiring an honest cost/overshoot policy and readiness validation, rather than a silent relaxation of this frozen protocol. This increment makes no such change and produces no efficacy evidence.

## SDK-native authored integration

A separately versioned [SDK-native configuration and call-record contract](sdk-native-contracts.md)
validates supported role settings, schedule-only seeds, unavailable generation
controls, declared byte/time/call bounds, nullable usage/cost and explicit monetary
admission records. Its import-only authored transport now runs a supplied block
through this existing F/U/H/M loop and the supervised SDK fake executable, with
separate native requests and validated `authored_completed` no-model records.
It retains complete failure/target rosters and measures byte/time/call limits;
unknown usage or exceeded bounds stop further work in an arm, and unverified
cleanup stops later launches across arms. The default source CLI now exposes `evaluation native init-authored`, `init-w0`
and `run`; use the [offline reproducibility guide](../../docs/offline-reproducibility.md)
for complete runnable commands and reopen. This authored/blocked bridge does not
provide a real-model operational dispatch path. Legacy packet validation, frozen controls and production
`not_run` remain unchanged. Authored repeated-block scheduling and an optional
[independent diagnosis-only stage](sdk-native-contracts.md#independent-authored-diagnosis-only-stage)
are implemented: each inferred episode/repeat starts from an explicitly unexecuted
slot, invokes one supervised authored script, and shares the locked output and
standalone resource allocation across U/H/M. Failures retain administrative Unknown
and all planned targets without retry. These distinct authored records claim zero
model calls and zero empirical episodes. Real runtime/billing admission, real-model
construction/diagnosis, source/label readiness and study-adoption gates remain pending.

## Scoring and remaining boundaries

`scoring.ts` is a small per-issue counter, not a parallel product evaluation service. The existing offline paired scorer remains unchanged because its positive/negative alert vocabulary cannot represent legal neighbors, safe-applicable cases or supported non-applicability. This slice retains missed positives, unsupported alerts, unknown/disputed references, scope loss and not-run outputs; zero denominators are `not_estimable`. H−U/H−M differences use identical rosters and show gained/lost positive target IDs. There are no family/repository population estimates, significance tests or invented uncertainty bounds.

`fixture-bound` evidence means only that declared citations resolve in the supplied target packet and missingness gates passed. It is **not independent semantic citation assessment**. Gate pass and metric values therefore establish fixture behavior only. The exported report is a mechanics artifact, not a completed `paper/experiment-protocol/record.schema.json` record; it does not invent human assessor IDs, annotation locks, visibility audits or temporal eligibility. The paper's operational freeze, trusted real execution, fresh independent source/label cohort and competent-baseline verification remain pending.

## Durable authored-study recovery

`runSdkNativeStudy` accepts an optional `MatchedStudyStore`, initialized with the
existing `Database` adapter and normal checksummed migration runner. Migration
015 adds the study claim and append-only event ledger; it does not rewrite older
migrations. No broker, lockfile framework, new dependency, credentials or real
model capability is introduced.

```ts
import { openPGliteDatabase } from '../../src/storage/database.js';
import { MatchedStudyStore } from '../../src/storage/matched-studies.js';
import { runSdkNativeStudy, sdkNativeStudyDigest } from './sdk-native-study.js';

// All of these inputs and the transport are the same authored-only imports
// used by the existing native study. Print/save the identity before dispatch.
const studyDigest = sdkNativeStudyDigest(schedule, configuration);
console.log({ studyDigest });
const db = await openPGliteDatabase('/absolute/local/study-db');
try {
  const store = await MatchedStudyStore.initialize(db);
  const result = await runSdkNativeStudy({ mode: 'authored_fixture', schedule,
    configuration, blocks, transport, store });
  // After interruption, reopen this database and call with these exact inputs.
  // A live owner returns not_run / study_running_in_another_driver.
} finally { await db.close(); }
```

Status is available without an executable or dispatch option:

```sh
npm run experiment:matched -- --study-status <study-digest> --db <existing-pglite-directory>
```

Initializing execution storage applies packaged migrations under the existing
migration policy. The status command uses `MatchedStudyStore.openExisting(db)`
and never advances migration history or creates study tables. It reports the lease, frozen arm/target rosters,
locked diagnoses, retained receipts, uncertain calls and next recovery action.
`inspectSdkNativeStudy(store, digest)` provides the same concise API;
`store.inspect(digest)` retains the complete immutable records.

Recovery guarantees and limits:

- The study identity binds schedule and configuration; supplied inputs, including
  missing blocks, are frozen before first dispatch and cannot be substituted later
- Transactional claims use database time, row locking, owner UUIDs and increasing
  fences. The lease exceeds one bounded call plus cleanup by 30 seconds and is
  renewed at each awaited checkpoint. A stale driver cannot add receipts or finish
- Dispatch intent commits before calling the transport. Call receipts and the
  single shared diagnosis commit before downstream work. An interrupted intent is
  explicitly uncertain, never evidence that no call occurred
- Reopening a finished study returns its exact saved report without another SDK
  invocation. Finished block results are similarly reused, with exact roster,
  source, configuration, call-receipt and diagnosis bindings checked
- Recovery never resumes inside a started block: it retains all returned receipts,
  consumed/uncertain slots, the locked shared diagnosis and every planned target.
  It may execute only never-started blocks. Any uncertain dispatch or unverified
  cleanup blocks all later launches; remaining targets stay missing in the report
- A claim recovery changes driver ownership, not the number of scheduled attempts.
  There are no retries, output selection, new diagnosis samples or favorable rerolls
- PGlite is a single-process database owner. Sequential close/reopen in fresh local
  processes is tested; contenders may share one PGlite Database handle. Simultaneous
  independent processes must use the existing PostgreSQL adapter, not open the same
  PGlite directory. Use the status API through the owning handle while it is open;
  run the local status CLI only after that owner has stopped and closed the database. No live PostgreSQL deployment is required or claimed by local tests
- Recovery reuse is limited to the same immutable study identity and does not alter
  the protocol's prohibition on output-cache reuse across independent study slots.
  All outputs remain authored mechanics: zero real model calls and empirical episodes;
  operational admission, runtime/billing, source/label and adoption gates stay closed

Focused integration coverage:

```sh
npx vitest run tests/matched-revision.sdk-native-recovery.test.ts --maxWorkers=1
```
