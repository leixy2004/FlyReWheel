# Feedback-driven rule revision generation

This application slice connects an existing pending revision request to a bounded,
reviewable rule proposal, then to the existing comparison and local-decision APIs.
It reuses the rule, case, selected-feedback, review, snapshot, workspace lifecycle,
and source-split registries. It does not activate rules or publish feedback.

## Application API

```ts
import { generateRuleRevision } from '../src/rule-revision.js';
const outcome = await generateRuleRevision(store, {
  requestDigest: pending.digest,
  candidateId: 'revision-proposal-1',
  candidateCreatedAt: '2026-10-02T00:00:00Z',
  context: {
    kind: 'selected-evidence-no-tools',
    snapshotDigest: selectedFeedbackSnapshot.digest,
    workspace: { repoPath, runId, attemptId },
  },
}, { enabled: true, model: explicitlyConfiguredModel }, trustedWorkspaceRuntime);
```

The runtime is a trusted code dependency using the existing workspace backend
interface; it cannot be supplied as JSON. Missing backend/authentication setup
remains blocked. There is no model/fixture fallback and no new credential setup.
The workspace must already be prepared at the selected snapshot's exact head.

`generateRuleRevision` reserves consumed source identities before exposing inputs
to generation and executes a fixed typed worker contract: `rule-revision-v2` for
snapshot-only feedback, or `rule-revision-v3` when any selected source review
carries repository context. Both enforce `policyVersion: diagnosis-operators-v1`;
v3 also requires `evidencePolicyVersion: selected-context-evidence-v1`. It atomically
saves either a validated candidate and its rule or a separate no-rule-change outcome. Disabled, unavailable, and
pre-cancelled runs do not load or reserve evidence. Input/storage failures throw;
runtime/output failures return failed outcomes and lifecycle recovery information.
A `no_rule_change` result saves its diagnoses, reasoning, concrete `nextStep`,
missing evidence, and receipt without creating a rule or candidate. Failed attempts
retain conservative source-use reservations.

A successful candidate outcome exposes `saved.candidate.ruleDigest`. Run reviews
of that exact rule and the base against the same snapshots, pass their IDs to
`store.createRevisionComparison`, and record `accept`, `reject`, or `defer` through
`store.recordRevisionDecision`. Existing acceptance gates reject regressed or
inconclusive comparisons. A local accept never changes the active rule.

A successful `no_rule_change` outcome exposes `savedOutcome.digest` and
`savedOutcome.outcome.result`, including its operator and next step. It has no
candidate rule to compare; the supplied `candidateId` identifies this separate
outcome record instead.

Lower-level APIs are available for trusted application composition:

- `store.prepareRevisionGeneration(requestDigest)`: validated frozen graph plus
  source-use reservation; use before any low-level generator call
- `store.getRevisionGenerationEvidence(requestDigest)`: read-only inspection;
  does not reserve content and is not a substitute for preparation before execution
- `buildRevisionModelInput`, `buildRevisionWorkspaceRequest`: pure preparation
- `createRevisionWorkspaceModelAdapter`: existing lifecycle runner plus typed gate
- `store.saveRevisionModelCandidate`: opaque in-process runtime capability only
- `store.saveRevisionModelOutcome`: separate opaque capability for a completed
  no-rule-change outcome
- `store.getRevisionCandidate`, `store.listRevisionCandidates`: bounded,
  revalidated generated-record catalog
- `store.getRevisionOutcome`, `store.listRevisionOutcomes`: bounded, revalidated
  no-rule-change catalog, optionally filtered by exact request digest

Raw JSON, cloned capabilities, schema-valid receipts, and type casts cannot mint
persistence authority. Stored receipts are readable provenance, not import tokens.

## Inspect persisted generation results from the CLI

Generation remains a trusted application API. Once it has saved a result, use the
record digest returned by the application/job result with these inspection commands.
They read existing records and reuse the exact store validators; they do not call a
model, run a review, reserve new source content, gather requested context, or activate
a rule. Opening the explicit database can apply pending versioned migrations; this
is domain-read-only inspection, not a promise of a database connection with no DDL.

```sh
# Discover records (default 20; maximum 100 per page)
npm run cli -- revisions candidates --db ./state --request-digest <request-sha256> --limit 20
npm run cli -- revisions outcomes --db ./state --request-digest <request-sha256> --limit 20

# Inspect one exact generated record, not its rule or request digest
npm run cli -- revisions candidate --db ./state --digest <candidate-sha256>
npm run cli -- revisions outcome --db ./state --digest <outcome-sha256> --out outcome.json

# Find an application/job's caller-supplied ID, or the exact generated rule
npm run cli -- revisions candidates --db ./state --id <candidate-id> --rule-digest <rule-sha256>
npm run cli -- revisions outcomes --db ./state --id <outcome-id>

# Continue using the previous nextAfter and identical filters
npm run cli -- revisions outcomes --db ./state --request-digest <request-sha256> --after <last-digest> --limit 20

# Follow a candidate's exact request + rule comparison link
npm run cli -- revisions comparisons --db ./state --request-digest <request-sha256> --candidate-rule-digest <rule-sha256> --limit 20

# Same domain commands, explicitly selected PostgreSQL (never ambient opt-in)
npm run cli -- revisions outcomes --postgres --request-digest <request-sha256>
```

`--db` and `--postgres` are required and mutually exclusive. `--postgres` uses the
explicitly configured `DATABASE_URL`. No database URL or credential is included in
returned links; append the same selector to the returned CLI argument arrays.

Candidate/outcome lists return a stable `schemaVersion: 1` JSON envelope with
`candidates` or `outcomes`, normalized filters, `after`, `limit`, `nextAfter`, and
`certification: none`. Records are ordered by immutable digest, not creation time
or quality. The exclusive cursor is the last returned digest; continue until an
empty page returns `nextAfter: null`. Pages are separate reads, not a frozen
cross-invocation catalog snapshot. An unknown request/ID filter returns an empty
page; unknown show digests fail. Malformed IDs/digests/cursors and limits outside
1–100 fail before opening storage. The compact stored-record JSON budget is 16MB per page (before CLI projection
and pretty-printing); exceeding it fails without silent truncation. Retry with a
smaller page. `--out` writes the same JSON as stdout.

Show preserves the exact stored `{ digest, candidate }` or `{ digest, outcome }`
and adds a separate `inspection` projection. It exposes request/base/candidate
rule identities, snapshot and context links, model execution versus fixture source,
operator, proposed diagnoses, and concrete next step. Selected feedback shows its
source, label, anchor, source review, and `selectedVerdict`, derived only from the
frozen selected feedback. It is not the current finding verdict after later
feedback. Follow the finding link for the current view. Caller-declared human
identity remains unverified; fixture FP does not change `Unknown` into a human
verdict. A model completion using fixture-sourced evidence remains fixture-sourced.

Candidate comparison links match both request and candidate rule. No-mutation
outcomes have `ruleDigest: null` and no rule/comparison link: `retain_rule` records
no review repair, `request_context` performs no acquisition, and `abstain` records
no rule rejection. Historical v1 candidates show `operator: null` and no retroactive
policy/context claim. The original pending request and candidate receipt fields
remain unchanged after later comparison or decision. None of these projections
certifies quality, diagnosis truth, human approval, or activation.

`revisions comparisons` opts into the same paginated envelope when any of
`--candidate-rule-digest`, `--after`, or `--limit` is supplied. Without these flags
it retains its legacy bounded array. The store list APIs similarly retain their
legacy no-argument/string-request-digest behavior; an options object enables pages.

The [inspection verification record](evidence/revision-inspection-verification-2026-10-02.txt)
records 1,224 passing tests across 84 files with two workers, final typecheck/build,
and compiled [snapshot-only](evidence/compiled-revision-inspection-smoke-2026-10-02.json)
and [context-aware](evidence/compiled-context-revision-inspection-smoke-2026-10-02.json)
smokes with 67 CLI checks each. These are offline authored fixtures, including
reopen and source-removal checks, not empirical model-quality results.

## Diagnosis-aware operator policy

The validator derives the permitted operator from the selected feedback and the
proposed diagnoses. It rejects a response that chooses an incompatible mutation;
it does not merely ask the model to follow a policy. Every diagnosis remains an
unverified proposal, and passing these checks does not establish its truth.

Each selected feedback item needs exactly one proposed diagnosis:
`judgment`, `context`, `boundary`, `contract`, `mixed`, or `insufficient_evidence`.
An `insufficient_evidence` diagnosis must identify missing evidence. Diagnoses cite their own selected
feedback; candidates must cite the exact base rule and every selected feedback and
finding. Only unique supplied references are accepted.

The policy first requires all selected feedback to be `label` declarations with
decisive values (`TP` or `FP`), with no conflicting TP/FP labels on the same finding. These
values remain authored/caller-declared and can be wrong. Non-label,
`Unknown`, or `Disputed` feedback, mixed diagnosis categories, a `mixed` diagnosis,
or `insufficient_evidence` require `abstain`. After those gates, uniform context
diagnoses allow `request_context` even when context is missing. For every other
category, any declared `missingEvidence` requires `abstain`, including uniform
judgment diagnoses. With no such gap:

| Uniform diagnosis | Permitted operator | Effect |
| --- | --- | --- |
| `judgment` with no missing evidence | `retain_rule` | Record the proposed review-repair next step; do not change a rule or finding |
| `context` | `request_context` | Record the missing context/next step; do not acquire it or change a rule/finding |
| `boundary` with no missing evidence | `boundary_update` | Propose an actual applicability, exception, or literal path edit |
| `contract` with no missing evidence | `contract_replacement` | Propose an actual rule edit with the required replacement declaration |

Voluntary `abstain` is allowed for any selection. The three non-mutation operators
use `status: no_rule_change`, with reasoning and a concrete `nextStep`; their strict
schema disallows proposed rule fields. A retained rule is not a repaired finding,
and a context request is not an executed evidence-gathering operation.

### Boundary updates

`boundary_update` may change only semantic `applicability`, semantic `exceptions`,
and literal include/exclude paths. It must preserve `title`, `mechanism`,
`invariant`, `requiredContext`, `expectedBehavior`, and all `detectionAssets`
exactly, and `replacement` must be `null`. An actual permitted edit is required;
a new version label or rationale alone does not qualify.

A semantic base rule may omit `detectionAssets`; proposals must return an array.
For both mutation operators, omitted base assets and `[]` mean the same
detectorless set during preservation and actual-edit checks. Returning `[]` alone
does not count as a rule edit. The frozen base, its content digest, prompts, and
historical receipt identities are unchanged; a generated detectorless candidate
contains `detectionAssets: []`.

Exact field preservation is a structural constraint. Natural-language conditions
and path edits are not checked for logical narrowing, minimum edit distance,
semantic consistency, or correctness. This policy does not prove that the revised
rule retains valid behavior; comparison remains a separate stage.

### Contract replacements

`contract_replacement` permits semantic text, literal include/exclude paths, and
up to four ast-grep detector assets to change, but also requires an actual rule
edit. Its non-null `replacement` binds the exact `priorRuleDigest`, distinct
`previousContract` and `proposedContract` texts, and unique supplied references
including the base rule and every selected finding. The retirement declaration
contains distinct `oldRuleAppliesWhen` and `replacementAppliesWhen` texts, a
`rationale`, `status: proposed_requires_review`, and `activation: not_performed`.

Those contract and applicability texts are review material. The validator does not
establish that the old contract held, the new one took effect, or a timeline is
historically accurate. It neither executes routing nor activates or retires a
rule. A replacement declaration does not override fixed regression expectations.

For both mutation operators, the application assigns the exact logical rule ID,
requested version, direct parent, repository scope, author, and creation time. All
base source references and regression cases/roles remain exact. Generation cannot
remove or relabel a regression, rewrite feedback, create human verdicts, turn an
anchored FP into a safe-file case, certify a rule, or activate it.

## Outcome persistence and compatibility

No-rule-change results are immutable records in the separate
`qe_revision_outcomes` table, linked to the frozen request and base. Save and read
rederive the accepted response and receipt against the selected evidence graph;
save also rechecks source reservations transactionally. They retain the same
fixture/model distinction as candidates and explicitly mark rule mutation, review
repair, and activation as not performed. They do not manufacture an unchanged
rule version or revise the original finding. The frozen request itself remains
unchanged; inspect the candidate and outcome catalogs to find generated results.

Historical `rule-revision-v1` receipts and schema-version-1 candidate records
remain readable through their original schema and byte-preserved prompt
rederivation. Their validation remains `schema-and-exact-provenance-only`; they do
not acquire a retroactive diagnosis-operator claim. Historical v2 receipts,
candidates and no-mutation outcomes also rederive under their original prompt and
response schema, without acquiring context-policy claims. Snapshot-only generation
continues to use v2, whose candidates record `diagnosis-operators-v1` and
`schema-exact-provenance-and-operator-constraints`. Legacy
`insufficient_evidence` responses are historical data, not the new generation
outcome format. Stored receipts remain provenance, not import authority.

## Frozen selection and holdout protection

The loader rederives request, base, feedback, finding, review, snapshot, and case
bindings. It reads exactly selected feedback IDs, never later appended feedback,
comparison results, decisions, or evaluation results. Feedback and base timestamps
must not postdate the frozen request; these are caller-declared times, not an
independently verified historical cutoff.

Only selected finding excerpts and their cited captured evidence enter the prompt,
along with the frozen base, request, and base source/regression case records.
Unselected file contents do not enter the prompt. Parent snapshot packages are
integrity-validated, but holdout checks cover exactly the consumed case/excerpt
source identities. Unrelated files or uncited sides can remain heldout without
invalidating a saved candidate. Base cases must also be non-heldout. Before generation, consumed excerpt/case source
digests are reserved through the existing immutable split registry: unknown
content becomes training-use; existing non-heldout splits remain unchanged. Unique
insertion serializes with concurrent case registration. A later holdout import of
identical consumed content fails. Reservations are usage metadata, not correctness
labels, new ProblemCases, or proof that an entire file is safe. Save rechecks the
graph and reservation transactionally.

This does not discover undeclared external datasets, establish cross-repository
semantic independence, remove pre-existing training contamination, or certify a
paper-quality temporal split. Application callers must use preparation before
executing a low-level adapter with a manually assembled graph.

## Execution and trust limits

This first slice is selected-evidence synthesis. The existing workspace runner
still verifies a checkout with `all-local-refs-v1`; that checkout is infrastructure,
not a certified historical split. The fixed revision contract selects SDK shell and
unified-exec disabled, web/apps/MCP/project instructions disabled, read-only mode,
and rejects observed command/file-change/tool events. These are trusted worker
configuration and acceptance checks. They do not independently attest a sandbox,
prove a provider followed policy, or preemptively isolate every possible data path.
Isolation and credential/gateway guarantees still belong to a separately verified
backend. Full-repository revision reasoning is a planned extension requiring an
explicit context and temporal/data-split design, not a permanently excluded goal.

Authored executors remain `source: fixture`, `modelExecution: not_run`, and
`synthesis: not_run`, including the official-SDK smoke. A completed receipt records
accepted bytes, requested model configuration, and lifecycle observations; it is
not cryptographic attestation or a correctness certificate. Model identity is
requested configuration, not provider-attested identity. Raw transport strings do
not claim execution. Production model/backend/auth behavior has not been run by
this change; blocked OpenSandbox review routes are not retried.

## Exact limits

- Selected feedback: 1–100; snapshots: at most 100; base source/regression cases:
  at most 200; graph: at most 16,000,000 JSON bytes, rejected without truncation
- Default generation: 262,144 input bytes, 131,072 output bytes, 30,000 ms;
  configurable hard caps: 2,000,000 input, 1,000,000 output, 300,000 ms
- Text fields: at most 8,192 characters; semantic text lists/path lists: at most
  32 entries; detector assets: at most 4; diagnoses: exactly one per selected
  feedback; response references: at most 300, unique and supplied
- Workspace input includes output schema; output/time limits cannot exceed model
  limits. Existing runner bounds process output, artifacts, lifecycle timeout and
  cleanup. A candidate requires verified stop, collection, destruction and release
- Candidate and no-rule-change input/record: at most 2,000,000 JSON bytes; cursor
  pages: 1–100 records (default 20), at most 16,000,000 returned record JSON bytes,
  rejected without silent truncation. Legacy no-argument/string-filter catalogs
  retain their 100-record cap; cursor pages can discover later records

## Local verification

```sh
npm run typecheck
npm test # package script already sets --maxWorkers=2
npm run build
node scripts/smoke-revision-generation.mjs
node scripts/smoke-revision-generation.mjs --context
```

The recorded compiled smoke exercises official SDK → authored executable → typed revision
worker → lifecycle receipt → persisted candidate → semantic comparison → local
acceptance, then demonstrates rejection of a regressed candidate evaluation. It
also persists and reopens all three no-rule-change operators, rejects
judgment/context/mixed mutation mismatches and a protected invariant edit, checks
fixture/human/activation boundaries, and cleans its synthetic Git workspace.
Operator tests cover disallowed edits, missing/conflicting evidence, replacement
declarations, persisted no-rule-change outcomes, and archived v1/v2 receipt/store
rederivation. Generation and storage checks cover tampering, unauthorized fields,
source reservations, concurrency, limits, cancellation, cleanup, and transaction
rollback.

The [operator verification record](evidence/revision-operators-verification-2026-10-02.txt)
reports final frozen-source typecheck/build, 663 passing tests across 46 files
with two workers, and the passing
[compiled v2 smoke](evidence/compiled-revision-operators-smoke-2026-10-02.json).
Earlier recorded v1 runs remain separate checkpoints. These authored fixtures
establish the asserted structural enforcement and persistence behavior, not
diagnosis truth or empirical improvement. No live model, network service,
deployment, publication, or auth change was part of this verification.

### Context-aware source reviews

`rule-revision-v3` consumes exact-head unchanged-file context already selected by
an immutable source review. It does not discover new files, acquire context, or
read another Git SHA. The existing feedback → finding → review → snapshot/context
registry bindings freeze the selection; the revision request is unchanged and
later feedback does not join it. The same review/package/anchor validators reject
missing packages, wrong repository/head/path/object/hash/span/excerpt bindings,
uncited evidence substitutions and forged selection changes before execution.

For every context-enabled selected feedback item, `repositoryContextBindings`
records its feedback ID, exact review ID/digest, snapshot digest, the review's
canonically sorted package digests, and the sorted context evidence IDs cited by
that exact finding. The prompt includes those identities, package coverage metadata,
the selected anchor judgment (including reported missing context), and only the
finding's cited excerpts. Full packages remain durable in the registered source
review; uncited package bytes, unrelated review evidence and other findings do not
enter generation. Package identity is not authorization to read other contents.

The v3 response must echo those bindings and the evidence policy exactly. Each
diagnosis may cite only the base rule and its own selected feedback/finding and
supplied excerpts; it must retain all of that finding's context citations. The
result and any contract-replacement declaration must retain the union of consumed
context citations. These checks apply to non-mutation outcomes as well. Citations
never establish diagnosis truth or contract history. Unknown/unverified selected
findings cannot be overridden by proposed judgment/boundary/contract diagnoses:
these require abstention; context diagnoses may request context. Existing mixed,
conflicting, missing-evidence and structural mutation restrictions still apply.

Source reservations include the original whole-source hashes for every consumed
context excerpt, together with consumed snapshot excerpts and base cases. They do
not reserve uncited files, even inside a selected package. Existing non-heldout
split assignments remain unchanged; consumed content cannot later become holdout.
This differs deliberately from comparison's conservative whole-selected-package
holdout gate: generation only exposes the bounded excerpt selection. Neither
contract proves absence of unknown holdouts or a certified temporal split.

Context candidates use record schema version 3; context no-mutation outcomes use
record schema version 2. Both persist `selected-context-evidence-v1` and the exact
bindings alongside their v3 worker receipt. Save and reads rederive the prompt,
schema, receipt, response, operator and frozen selection through the existing
registries. Historical v1/v2 generation cannot silently downcast a context review.
Stored source repositories may be removed: reopens use the captured immutable
registry bytes, while missing/corrupted registry packages fail closed.

Generated candidates feed the existing `per-anchor-context-v4` comparison scorer.
Paired reviews must retain the same complete context selection; explicit same-anchor
safe/violation declarations determine outcomes, never an absent finding or mere
citation. Regression labels/roles and source provenance remain immutable, fixture
FP stays a fixture declaration, and generation/comparison never activate a rule.

The `--context` compiled smoke runs the official SDK with an authored executable
through v3 generation, boundary revision, context-aware comparison, local decision,
all three non-mutation outcomes, and source-repository removal/reopen. It also
checks no-tools configuration and rejection of invalid mutation operators. The
context tests additionally cover missing/wrong/future/unselected citations,
per-feedback citation scope, unresolved anchors, consumed-only holdout reservations
and races, registry corruption, and immutable historical v1/v2 records. No live
model, network, backend, authentication, deployment or publication is exercised.
See [repository context](repository-context.md).

The [context revision verification record](evidence/context-revision-generation-verification-2026-10-02.txt)
and [compiled v3 smoke output](evidence/compiled-context-revision-generation-smoke-2026-10-02.json)
record the final frozen-source aggregate checks and authored application results.
