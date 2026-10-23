# Implementation readiness audit

Audited baseline: `6dea779` on 2026-10-02. This is a read-only source, test, and documentation review, not a new execution result. No tests, model calls, services, authentication, installations, deployment, or publication were performed for this audit. Separate fixes may be in progress; findings below describe the named baseline until their own verification records establish otherwise.


Current follow-up: the [converged application](converged-application-2026-10-04.md)
now includes an explicit executable worker bootstrap and authored governance
recovery. The findings below remain an audit of `6dea779`; they are not a claim
that those later code paths are absent. Live authority/model/deployment gates
remain unverified.

## Bottom line

FlyReWheel has substantial reusable domain machinery, but the main semantic-v2 product is still a collection of composable APIs and offline commands rather than a usable operator workflow. The authored closed-loop demo proves those chosen paths can connect; it does not make an arbitrary repository usable through the same entry point.

The most valuable next work is connecting existing pieces and fixing valid-input failures. More receipt variants, synthetic scenarios, infrastructure abstractions, or a new workflow engine should not precede that. The historical/scientific controls already implemented are useful, but they cannot substitute for a working real-input path and independent labels.

## What can actually be called at this baseline

- **Ordinary offline/local commands:** `rules import/list/show`, `snapshots capture/import/show/list`, `contexts capture/import/verify/cite/show/list`, `reviews run/show/list/finding`, `feedback add`, `revisions request/compare/decide` and their inspection commands, `rules governance apply/show/history/select`, `evaluation score`, `evaluation checkout export/inspect`, and `workspace prepare/inspect/cleanup`. `reviews run` is structural-only unless the caller supplies authored fixtures
- **Actual read-only provider integration:** `github-pr capture` and `github-pr history preview/import/capture/mining-request` call the bounded GitHub acquisition functions. Captured PR discussion remains evidence, not authenticated feedback or a correctness label
- **Older live-capable v1 entry points:** `synthesize --enable-model`, `replay --enable-model`, and `enqueue --enable-model` use the explicitly configured Codex adapter after authorized authentication. They do not execute the semantic-v2 mining/revision workflow
- **V2 model APIs requiring trusted composition:** `createPrMiningWorkspaceModelAdapter(...).generate`, `createSemanticReviewWorkspaceModelAdapter(...).review`, and `generateRuleRevision` / `createRevisionWorkspaceModelAdapter(...).generate`. Their tests inject authored runtimes; the repository supplies no ready executable bootstrap for a real runtime/resolver
- **Queue entry points:** `application-jobs validate/enqueue/status`, `createApplicationJobDispatcher`, and `startWorkerService({ application })`. The checked-in `worker.ts` registers the queue but persists `runtime_unavailable` for those jobs. A queue completion is not necessarily application execution
- **Deliberately synthetic:** `closed-loop demo`, `reviews demo`, `revisions demo`, `evaluation demo`, and the authored generation transports. `createPrMiningModelAdapter` rejects raw `kind: model` transports; `mining supply` imports supplied/fixture candidates rather than proving model execution

## Prioritized findings

### 1. Valid detectorless rules cannot generate a revised candidate — functional bug

**Priority: immediate.** Semantic-v2 deliberately permits `detectionAssets` to be omitted. `validateRevisionOperators` nevertheless hashes `base.detectionAssets` directly when preserving boundary assets and again inside the no-op comparison. `canonicalJson` rejects `undefined`. An imported rule without that optional property therefore cannot produce either a boundary candidate or a contract-replacement candidate, even if the response otherwise satisfies its policy. The model response always carries an array, so it cannot reproduce the omitted shape to escape the problem.

Evidence: [optional rule field](../src/core/semantic-rule.ts#L65), [array-only proposal](../src/core/pr-mining-model.ts#L16), [operator checks](../src/revision-generation.ts#L247), [canonical JSON](../src/core/identity.ts#L6). Existing detectorless comparison tests use empty arrays; the operator tests use a base with assets.

Small fix: treat omitted/empty assets equivalently only where comparing their semantic absence and constructing the new proposal. Do not normalize historical stored records or change their digests. Test omitted assets, explicit `[]`, genuine edits, no-op rejection, both mutation operators, and historical rederivation. This issue was reported for a separate fix; this audit does not claim that fix passed.

### 2. The CLI cannot supply the database consumed by queued application jobs

**Priority: immediate.** Domain capture/import/request/review/feedback/decision/governance commands all use `storeFor`, which opens only PGlite. `application-jobs enqueue` and the executable worker use PostgreSQL. Application payloads contain digests rather than their dependency graph; the dispatcher reads those digests from its PostgreSQL domain store. No supported domain CLI selector or graph-transfer command connects the two stores.

Thus following local capture/import commands and then enqueueing their digests cannot run the intended workflow, even after an operator supplies a backend and authentication. The TypeScript `QualEvoStore.openPostgres` API can populate the database, but requiring custom integration code is the gap.

Evidence: [CLI opener](../src/cli.ts#L44), [enqueue/status](../src/cli.ts#L459), [worker executable](../src/worker.ts), [digest-only jobs](../src/application-job-contract.ts), [dispatcher lookups](../src/application-dispatcher.ts#L94).

Small fix: one explicit, mutually exclusive local/PostgreSQL store selector reused by every domain command; retain local defaults and never switch because ambient credentials happen to exist. Use the existing store/database abstraction. Validate selection before acquisition or writes. An offline command-plumbing test can verify this without provisioning anything. This issue was assigned separately; no successful server-backed workflow is claimed here.

### 3. Governed rule selection and review execution (gap addressed locally)

**Original gap, addressed in the current working tree:** the [governed review coordinator](governed-semantic-reviews.md) now freezes complete registry selection and rechecks it at each trusted review admission. Suspension blocks new stale admissions; supersession selects the exact successor for new plans. Explicit digest APIs remain historical/manual and are labeled non-governed. Explicit digest replay is a legitimate research feature; it should not be the only way an operator reviews a new change.

Evidence: [store selector](../src/storage/store.ts#L1116), [selection implementation](../src/storage/semantic-governance.ts), [review CLI](../src/cli.ts#L270), [application dispatcher](../src/application-dispatcher.ts#L109).

Implemented local slice: an explicit-path selection plan freezes one snapshot and complete governance-head bindings, then dispatches existing semantic-review jobs and reports exclusions and durable outcomes. Each new attempt must pass current-head admission. Later governance changes preserve already admitted historical execution. Tests cover root selection, replacement, suspension, no selected rules and rerun/restart identity. No additional scheduler or production runtime was introduced.

### 4. Some admitted rule/revision shapes cannot complete the comparison workflow

**Priority: resolve before claiming general rule maintenance.** There are three related applicability problems:

- **Selected-finding slice addressed locally:** a boundary path revision still leaves ordinary review targets `out_of_scope`, but an explicit opt-in v5 comparison applicability channel can use an exact, context-complete NOT_APPLICABLE declaration to correct selected FP feedback. It preserves separate target coverage and rejects lost established positives. This does not adjudicate whole-file negative/fixed regressions; excluded file-level cases remain inconclusive. Existing v1–v4 reports are unchanged. See [contract and limitations](local-revision-comparisons.md#explicit-applicability-for-literal-path-revisions) and [focused tests](../tests/comparison-applicability.test.ts)
- A multi-language rule has every detector examined for every captured target. The irrelevant language produces `language_mismatch`, and any non-`scanned` entry blocks semantic comparison. A rule with valid Python and TypeScript assets therefore cannot receive a fully scored comparison across its ordinary language-specific targets
- General v2 import allows detector forms/aliases beyond the proposal schema: Semgrep/OpenGrep, aliases such as `ts`, and more than four assets. A boundary update must preserve assets exactly, while the model response accepts at most four canonical-language ast-grep assets. Those imported rules have no representable boundary-update response

Evidence: [scope disposition](../src/semantic-review-inputs.ts#L21), [scanner eligibility](../src/semantic-review.ts#L22), [comparison gates](../src/revision-comparison.ts#L50), [operator restrictions](../src/revision-generation.ts#L247), [proposal schema](../src/core/pr-mining-model.ts#L11), [operator test](../tests/revision-operators.test.ts#L27), [current mismatch tests](../tests/revision-comparison.storage.test.ts#L212).

Do not fix these by counting all exclusions or mismatches as safe. Define explicit detector applicability and an evidence-backed non-applicable outcome, retain lost-positive checks, and state which rule forms the generation workflow supports. Unsupported forms should fail in a cheap preflight before inference, not after paying for an impossible response. Preserved immutable detector assets can be application-owned rather than regenerated by the model. These changes affect scoring/receipt semantics, so legacy results must retain their original interpretation.

### 5. Model-capable semantic-v2 operations are APIs requiring an unfinished runtime composition

**Priority: genuine external integration gate, not more mock breadth.** There is no normal executable that configures v2 mining/review/revision. `startWorkerService` can accept trusted runtime and workspace-resolver dependencies, but `worker.ts` supplies neither. The checked-in workspace image gateway is blocked; the OpenSandbox integration needs a real lifecycle authority that the repository does not implement for a deployed environment.

Evidence: [worker](../src/worker.ts), [service dependency injection](../src/worker-service.ts#L9), [mining adapter/API distinction](pr-mining-model-boundary.md), [revision API](rule-revision-generation.md), [runtime inventory](runtime-readiness.md), [workspace image configuration](../deploy/workspace-worker/workspace-worker.json).

A bounded real run needs one supported, reviewed bootstrap/resolver and one operational backend/gateway, with the existing fail-closed checks preserved. More test-only runtime implementations do not close this gate. A read-only selected-evidence/no-tools pilot would be a separate, explicitly designed execution mode with narrower claims, not permission to route around the current blocked workspace boundary. This audit neither requests nor retries the separately blocked security-review action.

### 6. Operator completion and inspection are missing between primitives

**Priority: same usable slice as selection.** Generated revisions and no-rule-change outcomes have store getters/list methods but no matching CLI commands. A job status gives a domain ID/digest, yet the user cannot inspect a generated revision outcome through a corresponding command. A no-change result's concrete next step is particularly important for context/judgment diagnoses.

Local update (2026-10-02): `revisions candidate/candidates/outcome/outcomes` now expose the existing validated records, with bounded digest pages, exact request/ID/rule filters, and inspection links to request, rule, snapshot, selected context, feedback finding, and exact request-plus-rule comparisons. Fixture/model execution and caller-declared selected verdicts remain explicit; a no-mutation outcome reports its concrete next step without claiming repair or acquisition. This addresses the inspection gap only. See the [inspection contract](rule-revision-generation.md#inspect-persisted-generation-results-from-the-cli); the coordinator gap below remains open.

There is also no non-demo coordinator for candidate generation → same-snapshot base/candidate reviews → comparison → explicit decision. The only one-command closed loop creates its own synthetic history and authored responses. `synthesize` is the older v1 draft route and is not a v2 revision generator. Publication/SARIF utilities use the v1 finding type, not semantic-v2 findings.

Evidence: [revision getters](../src/storage/store.ts#L889), [no-change outcomes](../src/storage/store.ts#L933), [revision application API](../src/rule-revision.ts), [CLI](../src/cli.ts), [synthetic coordinator](../src/local-closed-loop.ts), [publication/export types](../src/publication.ts).

Add small list/show/outcome commands and a report with title, file/span, rule version, evidence, uncertainty, and next action. Supply a resumable, real-input recipe using the existing APIs; automate only deterministic wiring. Human approval and rule selection remain explicit. A web UI, external comments, and provider webhooks are not prerequisites for this pilot.

## Schema and maintainability assessment

The relational keys/foreign keys plus versioned JSON evidence are a reasonable small-system design. Immutable case/rule/finding identity and separate model judgment versus human feedback are essential domain concerns. The failure is not that there are schemas; it is that interoperability and operational evolution lag behind the number of schema variants.

- **Migration safety:** `QualEvoStore.initialize` executes all 13 SQL files on every open. There is no applied-version/checksum ledger, transactional migration coordinator, or migration lock. `CREATE TABLE IF NOT EXISTS` will not repair an old table definition. Repeated `CREATE OR REPLACE FUNCTION` plus trigger existence checks are not a production upgrade strategy. Ordinary list/status commands also perform DDL. Before a shared server-backed release, use one established migration mechanism, separate privileged migration from ordinary access, and test old-database upgrade plus concurrent startup. No need to replace PostgreSQL/PGlite
  Update (2026-10-02): [versioned migrations](database-migrations.md) now reuse pinned node-pg-migrate with ordered history, checksums, one atomic adapter transaction, PostgreSQL advisory-lock coordination and explicit reviewed legacy adoption. The 14 historical files are unchanged. This addresses replay-on-open and migration coordination in local/adapter verification; separate privileged runtime roles and live PostgreSQL upgrade validation remain open.
- **Concentrated responsibilities:** `storage/store.ts` is 1,421 lines and `cli.ts` 481 lines at the baseline. The store imports runtime adapters to validate capabilities, performs graph reconstruction and scoring, and owns several workflows. Extract cohesive repositories/services behind its existing facade and shared transaction context incrementally. Preserve atomic domain-plus-job commits; a large rewrite or generic repository framework would add risk
- **Compatibility cost:** independent review runtime, fixture, worker-output, receipt, scorer and revision versions now require cross-version rederivation. Archived fixtures are valuable, but older prompt builders should become frozen compatibility modules rather than policy branches interleaved with current generation. In particular, new revision prompts append instructions that supersede an embedded legacy prompt. Keep one obvious current contract and a documented compatibility matrix
- **Finite operating envelope:** several catalogs hard-fail above 100 records instead of paginating; governance caps rules/events and revalidates whole histories under table locks. These are honest prototype bounds, not ongoing service capacity. Add pagination on user-facing inventories before a long pilot; postpone broad scalability machinery until measured demand exists
- **Documentation drift:** README's early workspace section still says OpenSandbox is not integrated; later sections describe its adapter. The paper drafts/checklist still say unchanged-file evidence capture and exact object-closure evaluation exports are absent, although the audited HEAD implements selected exact-head context and optional closure binding. Update precise capability statements without claiming repository-wide coverage, historical public availability, or model quality

Evidence: [migration loop](../src/storage/store.ts#L96), [SQL migrations](../src/storage/migrations), [governance read/lock path](../src/storage/semantic-governance.ts), [revision prompt layering](../src/revision-generation.ts#L144), [claim checklist](../paper/claim-evidence-checklist.md), [method draft](../paper/method-draft.md).

## Reuse versus custom infrastructure

Keep the actual mature components already present: official Codex SDK, pg-boss, PostgreSQL/PGlite, Octokit, ast-grep, AWS S3 client, Sandcastle, and the selected OpenSandbox adapter boundary. A dependency's presence does not mean its integration is operational.

The durable domain result ledger is useful for retention and atomic deduplication beyond broker retention. Its separate owner/expiry/retryable state and 30-second reconciliation overlap some pg-boss responsibilities; document that their purpose is domain-result fencing and conservative external cleanup, not a second scheduling engine. Do not expand this into another workflow platform. Avoid adding Temporal, Redis, a vector database, a second evaluator service, automatic clustering, or a full governance UI before the single-repository loop works.

The runtime boundary has accumulated more lifecycle/provenance scaffolding than verified application usage. That is a prioritization warning, not a reason to disable cleanup or containment requirements. The next accepted runtime change should deliver a real supported bootstrap/integration, not another merely injectable proof path.

## Minimum milestone plan

### A. Make valid inputs and storage paths composable

Fix omitted assets; add explicit shared database selection; expose generated candidate/outcome inspection. Add real CLI process-level offline tests using a fresh persistent local database and reopen it. Add a preflight that can report unsupported rule/output shape and missing reference/runtime prerequisites without invoking a model. Exit criterion: an operator can capture/import an arbitrary allowed input, inspect every persisted step, and identify the exact next blocker without writing TypeScript.

### B. Make one governed local workflow usable

Add selected-rule review and a resumable real-input comparison recipe. Resolve or explicitly reject unsupported applicability/scoring cases before generation. Reuse existing functions and pg-boss for scheduling. Exit criterion: selection, review, exact feedback, revision/outcome, comparison and explicit replacement are demonstrable with real input bytes and clearly authored semantic responses; suspension changes the selected-rule path, and a lost positive still blocks acceptance. This establishes application wiring only.

### C. Establish one authorized real inference loop

In the chosen cloud environment, connect one reviewed runtime/bootstrap and a user-authorized authentication path. First prove actual PostgreSQL worker/restart behavior; then run a tightly bounded repository example through real inference and inspect evidence/unknowns/costs and recovery. Use existing mature execution facilities. Exit criterion: a non-fixture v2 result is persisted, inspected after restart, and its failed/abstained case is handled honestly. This requires the external setup and security gates below; it is not unlocked by A/B tests.

### D. Test the scientific claim separately

Freeze a defensible temporal source frame and later independent cases, obtain independent annotations, and execute matched baselines/ablations using the existing paired scorer. Current public-PR captures, selected-context integrity, and exact Git closure proofs do not establish historical public availability or correctness. Exit criterion: empirical evidence supports the specific paper claim, or the claim is narrowed. Full production governance is not a prerequisite for a well-scoped experiment, but authored fixtures are not its results.

## Authority and stopping boundaries

Code, offline fixtures, command plumbing, documentation, and source-level review can progress under the current cloud-only implementation scope. The following need separately verified access/authorization and must not be silently performed as implementation work:

- Provisioning/altering a PostgreSQL service or cluster, supplying secrets, or running persistent migrations against a real target database
- Connecting an account or creating persistent credentials/grants; selecting a different paid API billing path
- Changing sandbox, network, admission, storage, or credential-isolation controls, or retrying a denied security-sensitive action through another route
- Sending repository contents to a model/provider outside the user's approved scope and budget; executing target repository code
- Publishing, deploying externally, commenting on repositories, pushing commits, or contacting third parties

No such authority was exercised by this audit. A/B are useful implementation work while C is blocked; they should not be reported as C or D completion.
