# Verification and recovery scope

Historical local checkpoints begin **2026-10-02**, canonical directory `FlyReWheel/`. This is a local
source/build/test result, not a deployed sandbox or production service.

## Real PostgreSQL cloud checkpoint: 2026-10-03

At GitHub baseline `237056acaaa3c21684fd63772eaca119e2af5f3a` (tree
`3e21d1d39b5da1a63b608508edac2dfee772712a`), a local verification script exercised
compiled application code against PostgreSQL 17.11 in an isolated temporary
Docker database. All 15 migrations, four-pool concurrent initialization and claims,
stale-owner fences, offline replay deduplication, actual worker SIGKILL recovery,
compiled service health/readiness and SIGTERM, and database KILL/start persistence
passed. A separate database passed 014→015 upgrade, deliberately failing SQL
rollback, corrected retry, and preservation of its existing sentinel record.

See [reproduction and limits](real-postgres-verification.md) and
[structured evidence](evidence/real-postgres-2026-10-03.json). These are real
PostgreSQL and process-lifecycle checks with authored test inputs. They do not
retroactively change the older simulated/PGlite evidence. Real model calls were
not run; application runtime remained blocked. Isolated workspace execution, S3,
k3s, production database roles, and empirical efficacy remain unverified. Final
aggregate tests for the current working tree are pending; prior test counts below
belong to their stated checkpoints.

## Versioned database migrations checkpoint: 2026-10-02

The [migration upgrade path](database-migrations.md) replaces replay-on-every-open
with pinned **node-pg-migrate 9.0.0**, ordered history, exact SQL SHA-256 checksums,
and one adapter-owned transaction for migration SQL and all metadata. PostgreSQL
uses a waiting transaction-scoped advisory lock on the pinned connection. PGlite
serializes same-instance calls; persistent directories still require one process
and one open instance. All 14 historical SQL files remain unchanged, as do domain
payloads, identifiers and interpretation.

**Upgrade compatibility is explicit:** normal startup refuses an untracked old
schema. Operators must back up, stop old processes, review `database inspect`,
and attest the already-applied 001–014 prefix with `database adopt` and its exact
schema fingerprint. Adoption records only metadata for that prefix, without
replaying its SQL; only later files execute. The fingerprint detects changes since
review, not historical execution or data compatibility. Required table/function
names and frozen source checksums add a sanity check; they are not automatic
cross-engine schema certification.

Final source-frozen verification passed **1,210 tests across 82 files** with two
workers in **759.33 seconds**, plus typecheck, production build, static validation
of **30 deployment YAML documents**, historical-SQL diff and whitespace checks.
The source/test/script/deploy/dependency tree SHA-256 remained exactly
`4afadd7dee014b7881cf9fd01d9f9e7cbc243ca9e0e164b5334375899fe05b9b`
throughout the final aggregate and ancillary checks. No assertion or individual
test timeout was relaxed. An initial 720-second aggregate bound was insufficient;
the final completed run used a 1,200-second command budget. The verification log
also records an interrupted retry while the last reviewed filename fix was
finished; neither incomplete run is counted as a pass.

The 33 new tests cover real PGlite fresh/repeated/reopened initialization,
concurrency, pending migration execution, full-batch rollback and retry,
historical byte drift, incomplete/empty/corrupt history, populated legacy
adoption, 013→014 upgrade, stale fingerprints, partial/non-public schemas, and
catalog/filename shadow cases. PostgreSQL lock exclusion, pinned-client ordering
and sanitized failure cleanup are tested through an explicit server-lock
simulation at the public driver boundary. Independent review reproduced and
rechecked the empty-history replay and catalog-shadow fixes, and confirmed the
public runner/loader usage and strict filename filtering.

The new compiled migration smoke confirms exact source/dist SQL bytes, adoption
through the compiled CLI from a populated pre-ledger database, zero replay on
reopen and preserved domain records. Build validation also planted a stale SQL
artifact and verified its removal. The existing compiled database-selector smoke
passed **85 checks with zero socket/fetch attempts**.

Evidence: [complete verification log](evidence/database-migrations-verification-2026-10-02.txt),
[compiled migration smoke](evidence/compiled-database-migrations-smoke-2026-10-02.json),
and [compiled selector regression](evidence/compiled-database-selection-migration-regression-2026-10-02.json).
The pinned dependency was installed from the official npm registry with lifecycle
scripts disabled. No live PostgreSQL, authentication, model/provider execution,
service provisioning, deployment, upload, publication or source commit occurred.
Real PostgreSQL 17 upgrade/restart durability and separately provisioned runtime
roles remain external readiness gates. Checksums detect historical SQL/ledger
drift; they do not continuously certify all unmanaged schema/data changes.

## Context-aware semantic-review checkpoint: 2026-10-02

Selected unchanged contracts/tests now feed the opt-in versioned semantic-review
contract, with findings restricted to changed after-side targets. The frozen
bounded package set binds config, fixtures, prompt, worker output, receipt,
registered persistence, jobs and comparison. Workspace execution rechecks every
selected package against exact local Git before allocation; offline/reopen
validation uses package integrity only. Matching context sets are required for
comparisons; known heldout context bytes block revision comparison. Feedback-based
model revision generation explicitly rejects this new evidence contract until its
snapshot-only synthesis inputs are extended.

The new [compiled authored SDK smoke](../scripts/smoke-context-semantic-review.mjs)
exercises same-file authored safe/violation decisions using unchanged contract/test
citations. Both findings are Unknown without those citations. It persists through
real PGlite, removes the source repository, reopens identical reviews/comparison,
and preserves fixture origins, Unknown human verdicts, unverified introduction,
unverified historical availability and no notification. This is application
plumbing verification, not live-model quality or an efficacy result.

Final source-frozen verification passed **954 tests across 68 files** with two
workers (557.92 seconds), typecheck, production build, static validation of 30
deployment YAML documents, and diff checks. The source/test/script/deploy tree
SHA-256 stayed exactly
`fc2d870bfae3243113998fc555e271e957a2b94e79d47d6f63fa80c86c61d1ad`
throughout the aggregate. No assertion or timeout was relaxed. Independent static
review identified cross-package hierarchy/object-consistency contradictions;
shared object checks and regressions now reject those across selected packages
and snapshot head entries. The repair was independently rechecked.

Evidence: [full verification log](evidence/context-semantic-review-verification-2026-10-02.txt),
[new compiled SDK/store/comparison smoke](evidence/compiled-context-semantic-review-smoke-2026-10-02.json),
and [compiled capture/CLI regression](evidence/compiled-context-capture-regression-2026-10-02.json).
Existing compiled semantic-workspace, revision-generation and paired-evaluation
smokes also passed. Golden tests preserve legacy review IDs/payload digests,
three historical generation contracts and snapshot-only paired/comparison reports.
All checks used authored local fixtures; no authentication, live model/provider
calls, new dependencies, deployment, upload, publication or source commit occurred.
External PostgreSQL durability, production isolation, model quality and historical
public availability remain unverified.

## Selected repository context capture-only checkpoint: 2026-10-02

The [selected-context capture contract](repository-context.md) adds bounded,
explicit Git paths at one exact review-head SHA, including unchanged contracts
and tests. It reuses snapshot byte/path validation and safe Git plumbing, stores
append-only context packages, and exposes capture/import/show/list/verify/cite
APIs and CLI commands. Imported receipts remain package-integrity-only. A typed
context anchor binds repository, head, package, blob, mode, source SHA-256 and
exact span. A separate preflight rejects wrong/future heads and contradictory
snapshot overlap.

The final source-frozen two-worker suite passed **885 tests across 62 files**
(540.39 seconds). Typecheck, production build, static validation of 30 deployment
YAML documents, and diff checks passed. The source/test/script tree SHA-256 was
unchanged before and after the final aggregate:
`57e4f7adfa058020d2dd04fc304feb6c319ba3aecf6315db821a57ed554c0947`.
The [verification log](evidence/repository-context-verification-2026-10-02.txt)
contains the actual commands' output and counts. Two final adversarial checks
cover nonblocking rejection of FIFO imports and binary/text contradictions; their
assertions and timeouts were not relaxed.

The [compiled authored-fixture smoke](evidence/compiled-repository-context-smoke-2026-10-02.json)
uses a checkout already on a future commit, captures earlier unchanged contract
and test bytes, rejects future-head snapshot binding, verifies locally, imports
with receipt downgrade, and reopens/cites after deleting the source repository.
It also checks idempotency, bounded summary pagination and tamper rejection.
The [legacy-compatibility check](evidence/repository-context-legacy-compatibility-2026-10-02.json)
runs the original `a4f64bd7` snapshot implementation and the refactored one on the
same exact committed change: all content and digest match, and the existing
semantic review/receipt/comparison contract files remain byte-for-byte unchanged.

**At that capture-only checkpoint, semantic acceptance was not integrated.**
The later context-aware checkpoint above adds an explicit versioned path;
historical review schemas still reject the new context anchor type. Merely
capturing or citing a source outside the frozen selection does not close a gap. Coverage remains
selected-paths-only and historical availability unproven. All new checks are
local authored application tests, not live inference, empirical effectiveness,
authenticated provenance, a deployed service or external PostgreSQL durability.
No credentials, provider requests, new dependencies, target-code execution,
upload, publication or source commit were used.

## Exact-head evaluation checkout checkpoint: 2026-10-02

The optional [evaluation checkout exporter](evaluation-checkouts.md) creates an
independent standalone repository from a caller-declared exact allowed-head set.
It verifies complete object inventory against the reachable closure, exact refs,
Git metadata bytes and full selected source/test tree. Future branch/tag/notes,
reflog-only and dangling objects are excluded in authored adversarial fixtures.
The production `all-local-refs-v1` transport is unchanged.

The full two-worker suite passes **875 tests across 60 files** (514.69 seconds),
including 48 new export/CLI cases. Typecheck, build, repeated compiled API/CLI smoke,
static validation of 30 deployment YAML documents and diff checks pass. See the
[verification record](evidence/evaluation-checkout-verification-2026-10-02.txt) and
[compiled development-fixture result](evidence/compiled-evaluation-checkout-smoke-2026-10-02.json).

This proves only local exact-head object/ref and committed-tree isolation under a
trusted, exclusively accessed store. Historical public availability stays
**unproven**; timestamps are declarations, not visibility proof. This is not an
execution sandbox, live model evaluation, deployment or empirical paper result.

## Local semantic-v2 governance checkpoint: 2026-10-02

The [local governance contract](semantic-rule-governance.md) adds explicit
`local-semantic-review` registration, experimental `local-shadow` selection,
suspension, retirement and atomic direct-successor replacement. Exact rule/scope
digests and the expected per-logical-rule event head bind each mutation. Revised
selection requires an accepted compatible current per-anchor comparison with
nonempty scored observations; root bootstrap stays explicitly unvalidated.
Selection uses exact repository identities and literal path scope and returns
exclusion explanations. It does not execute a review or publish anything.

The full suite passes **745 tests across 52 files** with two workers
(419.67 seconds). Type checking, production build, and static deployment validation
(30 YAML documents) also pass. The
[compiled authored-fixture smoke](evidence/compiled-local-semantic-governance-smoke-2026-10-02.json)
verifies that acceptance alone stays inert, root bootstrap remains unvalidated,
exact two-version supersession is explicit, and suspension, database reopen,
old-command retry, resumption and retirement preserve their contracts. It confirms
unchanged v1 active state, continued exact historical review reads and zero calls
to the blocked `fetch` boundary. The [reproducible script](../scripts/smoke-local-semantic-governance.mjs)
uses real local PGlite and the compiled application.

The [governance verification record](evidence/local-semantic-governance-verification-2026-10-02.txt)
records the aggregate checks for this slice. Prior counts below remain their own
checkpoints and do not by themselves verify the new governance code.

This remains local experimental eligibility. Fixtures and local-human declarations
are unauthenticated; neither a compatible comparison nor a selected local-shadow
version certifies semantic correctness. No live model/backend, production rollout,
external database durability, authenticated approval or empirical efficacy is
established by these contracts or by local authored tests.

## Mixed-anchor contract checkpoint: 2026-10-02

The new review fixture `schemaVersion: 2`, `semantic-review-v2` worker output and
`per-anchor-v3` receipt contract represent independent safe/violation/unknown
anchors within one target. Exact source/span validation and context gates apply
per judgment. Target coverage remains separate, and an unknown target does not
erase a supported anchor. Current `per-anchor-semantic-v3` comparisons score exact
feedback anchors while retaining target-level file cases, complete declared-scan
requirements, dropped positives and inconclusive gaps. Older prompts, receipts,
fixtures and reports keep their original rederivation; a new local accept requires
the current scorer.

Final typecheck, build and **722 tests across 48 files** passed with two workers
(376.84 seconds). Three compiled smokes, static validation of 30 deployment YAML
documents and diff checks also passed; the source/test/script digest remained
unchanged across the final suite. No deployment was performed.

The [mixed-anchor verification record](evidence/mixed-anchor-review-verification-2026-10-02.txt)
and [compiled mocked SDK → worker → store → comparison smoke](evidence/compiled-mixed-anchor-review-smoke-2026-10-02.json)
record the checks and their scope. The smoke separately cites captured local policy
for public/private reads, preserves the selected TP and corrects the selected FP
while target coverage remains unknown, then reopens the records identically.
All semantic decisions and feedback are authored.
This is structural contract verification, with no live model/backend execution or
empirical evidence of fewer false alarms, preserved recall or semantic correctness.
Earlier counts below belong only to their recorded checkpoints.

## Closed-loop application checkpoint: 2026-10-02

The single `closed-loop demo` entrypoint now connects real synthetic Git history,
authored PR evidence/mining proposal, future-target review, exact fixture feedback,
generated revision candidates, same-snapshot comparisons and local decisions.
The integrated checkout passes **573 tests across 41 files** with two workers,
plus typecheck, build, compiled first-run/rerun equality and deployment-manifest
validation. The report contains 33 hashed artifacts and verifies 28 persisted
records after closing and reopening PGlite. See the [quickstart](local-closed-loop.md),
[verification record](evidence/local-closed-loop-verification-2026-10-02.txt), and
[compiled result](evidence/local-closed-loop-compiled-2026-10-02.json).

These are fixture-only functional scenarios. Historical source labels remain
unknown, feedback is explicitly authored, model execution is not run, and no rule
is activated. Positive preservation and negative correction are checked at exact
selected feedback anchors; the separate regressed candidate is refused acceptance.
This result does not establish real model quality, developer feedback, historical
isolation, a live production backend or empirical efficacy.

## Prior application checkpoint: 2026-10-02

Feedback-driven revision generation now connects a frozen request to a bounded
candidate, the existing same-snapshot comparison, and a local decision. The final
local run passes **569 tests across 40 files** with two workers, plus typecheck,
build, compiled revision-generation and prior semantic-workspace smokes, and
30-document deployment-manifest validation. See the
[verification record](evidence/revision-generation-verification-2026-10-02.txt),
[compiled authored-SDK smoke](evidence/compiled-revision-generation-smoke-2026-10-02.json),
and [API/trust limits](rule-revision-generation.md).

The new smoke remains authored fixture execution (`modelExecution: not_run`),
preserves the human verdict as Unknown, blocks regression acceptance, and performs
no activation. Production backend/auth/isolation and live model quality remain
unverified. The following table and subsequent checkpoints are retained history.

## Earlier reproducibility checkpoint: 279 tests

| Check | Actual result |
| --- | --- |
| Dependency policy | Exact lock; official npm registry; lifecycle scripts disabled |
| `npm run typecheck` | Passed |
| `npm test` (two file workers) | **279 tests across 29 files passed** |
| `npm run build` | Passed; production JS plus SQL migrations |
| `node dist/cli.js demo` | **6 synthetic cases, 0 execution errors** |
| Compiled `workspace prepare → inspect → cleanup` | Passed across three processes; correct SHA, worktree removed, branch retained |
| Semantic v2 import/show/list, atomic rollback and legacy compatibility | Passed with real PGlite, strict schemas, source CLI and compiled CLI |
| Frozen Git snapshot capture/import/show/list | Passed with real Git/PGlite, source CLI and compiled CLI; unverified package imports remain integrity-only |
| Local v2 snapshot review → exact feedback → pending revision request | Passed with native ast-grep, real PGlite, source CLI and compiled CLI; fixture note leaves human verdict Unknown |
| Supplied v2 candidate → frozen regression comparison → explicit local decision | Passed with real PGlite, source/compiled CLI, preserved-positive/corrected-negative fixture accept and lost-positive fixture reject; no activation |
| PR evidence → mining request → supplied semantic-v2 candidate | Passed with 11 tests, unknown-only cases, exact source/statement bindings, rollback and separate-process CLI; compiled captured vLLM #8568 smoke has no synthesis or labels |
| `npm run validate:deploy` | **30 YAML documents** parsed and local constraints passed |
| `npm run experiment:vllm` | **5 retrospective seed cases**, all expected counts matched, 0 execution errors |

Runtime tested: Node **24.19.0**, Linux, Git. The inherited declared Node floor is
>=22; Node 22 and Windows were not tested in this checkpoint.

The 279-test total at that checkpoint consists of the recovered baseline's 76 tests in 12 files,
19 production workspace/CLI tests, 5 migrated Sandcastle public-provider contract
tests, 19 semantic-version schema/storage/CLI tests, 9 snapshot tests,
52 local semantic-review/runtime/storage/CLI tests, 26 GitHub PR evidence tests, and
62 local revision-comparison/storage/limits/CLI tests, and 11 local PR-mining
request/candidate/provenance/CLI tests.
Test count is coverage evidence, not proof that the lost implementation was recovered. See the
[semantic-slice full run output](evidence/semantic-rules-verification-2026-10-01.txt),
[earlier 95-test checkpoint](evidence/test-suite-2026-10-01.txt), and
[compiled workspace smoke](evidence/compiled-workspace-smoke-2026-10-01.json).
The [cleanup-safety full run](evidence/workspace-cleanup-safety-verification-2026-10-01.txt)
records the earlier 119-test checkpoint, followed by type checking and build.
The [snapshot-slice full run](evidence/change-snapshots-verification-2026-10-01.txt)
records the preceding 128-test checkpoint, type checking and production build.
The [local review full run](evidence/semantic-review-verification-2026-10-01.txt)
records the earlier 161-test checkpoint, type checking, production build and the
compiled review/feedback/request smoke. The
[coverage-integrity run](evidence/semantic-review-coverage-integrity-2026-10-01.txt)
records the earlier 206-test checkpoint, 52 focused review tests, type checking,
production build and a fresh compiled review/feedback/request smoke.

The first unrestricted-parallel run after adding this slice had 111 passes and
three **5-second timeouts** in existing workspace/disk-reopen tests. No assertion
failed; resource contention is a likely explanation, not an independently proven
cause. The [failure log](evidence/semantic-rules-unbounded-parallel-2026-10-01.txt)
is retained. The complete suite subsequently passed with `--maxWorkers=2`; this
bounded file-worker setting is now the canonical `npm test` default. Assertions
and timeouts were not weakened.

The default `npm test` command was then repeated successfully with that setting:
114 tests in 16 files, followed by a successful production build. The earlier
workspace CLI, deployment-manifest and retrospective vLLM rows retain their
already recorded checkpoint evidence; the semantic slice did not rerun remote
services or introduce new deployment claims.

The baseline suite still uses the real embedded PostgreSQL engine PGlite, native
JS/TS/Python AST parsing, persistence/reopen, CAS, feedback gates, permanent artifact
references, replay identities and official pg-boss integration with PGlite. SDK
contracts use mocks. The offline demo's precision/recall is calculated from authored
synthetic cases and fixed labels, not live model quality or business benefit.

## Semantic-version persistence slice

The v2 record separates semantics from optional detector assets and freezes exact
repository/path scope, source-case repository/full commit/path/source digest and
same-rule parent lineage. It reuses the existing append-only rule table and logical
version namespace. Supplied ProblemCases and the rule import in one transaction;
source mismatch, lineage error, conflict or holdout reference rolls back the import.

Tests cover semantic-only and multiple assets, scope boundaries and invalid schema,
digest identity and immutable SQL triggers, exact source binding, atomic rollback,
concurrent conflicts, disk reopen, v1 digest/shape compatibility and v1-only runtime
guards. The legacy evaluation/promotion readers reject future v2-linked rows even
when inserted directly into the database for a negative test. Scope is literal,
not a custom glob language. List is currently unpaginated for small local use.

Source references are checked against stored immutable case records, not actual
Git availability, provider identity, problem truth, source bytes or temporal
visibility. The example remains explicitly synthetic with an unknown label and
no reviewer. No model was invoked and no rule was activated. This slice does not
restore provider PR history, mining, review or feedback-driven evolution. See the
[contract and runnable example](semantic-rules.md).

The [compiled CLI smoke](evidence/compiled-semantic-rules-smoke-2026-10-01.json)
ran import/show/list, idempotent re-import, a child version and unchanged-parent
lookup across separate processes. A v1 offline demo then ran in the same database:
6 synthetic cases, 0 execution errors, resolve-only verdict still Unknown. The
semantic source stayed unknown/unreviewed, its rule stayed inactive, and the legacy
v1 reader rejected v2.

## Frozen local change-snapshot slice

The new [snapshot contract](change-snapshots.md) freezes exact full-SHA base tip,
unique merge base and head, raw changed-entry inventory, committed text bytes and
explicit binary/size/symlink/submodule coverage gaps. It uses installed Git and
the shared bounded subprocess policy without checking out or executing source.
The retained-text, explicit blob-read, JSON and aggregate Git-time bounds are
distinct and documented. Immutable content persists atomically in one existing
store; filesystem/time receipt data does not change its content identity.

Nine tests cover authored real-Git capture, branch movement/dirty checkout,
divergent and ambiguous ancestry, exclusions, invalid paths, missing objects,
byte/digest tampering, resource/encoded-package limits, immutable SQL enforcement,
idempotence, disk reopen, pagination and separate source CLI processes. The full
128-test run includes all existing 119 tests without weakening their assertions.

The [compiled CLI smoke](evidence/compiled-change-snapshots-smoke-2026-10-01.json)
passed capture, repeated capture, show, import after removal of the fixture source,
idempotent reimport, paginated listing, tamper rejection and v2 rule import into
the same database. Capture alone emits a separate local-check receipt; import/show
return integrity-only even when the input file declares local verification.

No provider history, model inference, PR review, feedback evolution, authentication,
remote PostgreSQL/S3, sandbox deployment or external publication was exercised.
Previous deployment/vLLM/workspace smoke results above retain their own earlier
checkpoint evidence rather than becoming fresh service-validation claims.

## Local semantic review, feedback and pending revision requests

The [local review contract](semantic-reviews.md) now connects exact stored v2 rules
and frozen snapshots in the same database. One run preserves changed-entry coverage,
real full-file ast-grep occurrences, duplicate-anchor aggregation and explicit
semantic fixture outcomes. Detector-less rules remain valid; no fixture, missing
context, zero hits and unsupported assets never become implicit safe results.
Before/after evidence anchors remain separate. Head findings retain unverified
introduction and notification eligibility, with incomplete repository context and
package-integrity-only snapshot provenance.

The new 33 tests comprise 21 runtime/contract tests, 10 real-PGlite persistence tests
and two separate-process CLI tests. They cover aggregation, exact Unicode/BOM/CRLF
anchors, missing/forged fixture evidence, unsupported paths/assets, scanner work
bounds, complete atomic persistence, conflicting/idempotent writes, append-only
SQL, exact feedback and pending-request selection, v1 compatibility, and read-time
tampering even with a recomputed outer payload hash. Public review creation rejects
injected result IDs and before-side findings. Fixture TP labels do not count as
human verdicts; only explicit caller-declared local-human labels participate, and
the caller's identity is not independently authenticated.

The [compiled CLI smoke](evidence/compiled-semantic-review-smoke-2026-10-01.json)
uses a fresh local PGlite database and separate compiled CLI processes. It confirms
two native asset occurrences aggregate into one finding; authored semantic fixture
output persists; a fixture note preserves exact text with a null label and human
verdict Unknown; a request freezes selected feedback and stays pending with
synthesis not_run. Repeating/reopening succeeds, and rule-version count remains
one after multiple requests. This is a local functional loop, not completed rule
synthesis or a production-learning claim.

No live model, authentication, full-repository Codex, OpenSandbox, provider history,
notification/publication, before/after causal-introduction analysis, authenticated
human approval, remote PostgreSQL or production governance was exercised. The
source/build/test result and compiled demo are the scope of this checkpoint.

### Deterministic coverage-integrity follow-up

Read validation now shares the builder's engine/language/filename eligibility
check. The regression reproduced an unsupported asset relabeled as a successful
zero-hit scan without changing the review ID. Nineteen added tests cover forbidden
state transitions, both unsupported engines, unknown/mismatched languages and
extensions, valid aliases, and real-PGlite tampering with recomputed payload hashes.
Existing budget coverage now also checks eligibility precedence after exhaustion.
Scanner spies verify that reads preserve valid zero-hit/error/budget/Unknown
outcomes without rescanning. The public builder already produced honest coverage;
this is read-validation hardening, not a demonstrated public-write exploit or
proof that recorded eligible scans executed completely.

## New workspace verification

Production source is under `src/workspace/` and is integrated into the main CLI.
Tests use the installed **@ai-hero/sandcastle@0.12.0** public API, not a mock
replacement or an upstream private test hook. Package provenance is retained in
[the registry record](evidence/sandcastle-package-provenance.json); the lock contains
the exact tarball integrity.

Verified with self-authored local repositories:

- Different immutable commits can be prepared concurrently in one repository,
  retain all available commits and allow independent edits without changing main
- Manifest provenance records base, comparison head, merge base and initial HEAD
- One identity admits one allocation and cannot be recycled after failure/cleanup
- Pre-existing branches, orphan directories, invalid IDs, shallow clones, filters,
  symlinked management paths and changed identities fail conservatively
- Clean cleanup removes only the worktree; output branches/commits and history stay
- Dirty, binary, untracked and ignored evidence is retained; earlier patch/status
  snapshots survive a later explicit cleanup
- Index `assume-unchanged`/`skip-worktree` flags preserve hidden tracked edits,
  including both flags together; unchanged flagged files are also preserved
- Case-folding repository configuration cannot hide a distinct untracked Linux
  path; subprocess policy does not alter stored repository configuration
- The source CLI and compiled CLI work across separate invocation processes
- Host hooks and external Git transports are disabled in the lifecycle bridge
- Provider-contract tests prove real full-history Git bundle transfer, live output,
  stdin/nonzero status, exact pre-abort reason, cancellation with process termination,
  subsequent reuse, and preserved failure artifacts

Provider execution uses a **local transport test double**, not OpenSandbox or any
security sandbox. Its executable scripts and repositories are authored by the test.
It is not a production backend. Cancellation does not promise automatic sync-out
of remote uncommitted bytes. Production lifecycle commands do not execute repository
code. [Detailed lifecycle, recovery and backend boundaries](workspaces.md).

Full history and Sandcastle's all-ref bundle can expose future fixes and other
attempt refs. An old checkout SHA alone does **not** establish time-isolated or
heldout research input; a future permitted-ref/commit-graph evidence policy is needed.

### Cleanup safety regression follow-up

Review of `c154ea3` reproduced two data-loss paths with authored fixtures: hidden
tracked edits under index visibility flags, and distinct untracked Linux paths
under `core.ignoreCase=true`. Both previously looked clean, were removed, and had
no corresponding bytes in cleanup evidence. The coordinator now preserves any
flagged index, records exact paths and an uncertainty reason, and repeats the
flag check in the bridge before close. Git subprocesses use case-sensitive path
handling. No index flags or persisted repository settings are silently changed.

The [compiled cleanup smoke](evidence/workspace-cleanup-safety-compiled-smoke-2026-10-01.json)
checks both flag types and case-distinct untracked binary bytes through separate
CLI processes. Each cleanup returns exit 2 and retains the exact bytes; intentional
flag restoration/commit permits a later clean close with branch retention. Direct
bridge guards are separately covered in source tests. A `core.ignoreStat=true`
synthetic check also preserved its automatically assume-unchanged tracked entries;
`core.fsmonitor` remains disabled by the subprocess policy.

These checks retain the trusted, exclusively managed Linux store and quiescent
writer assumptions. They do not establish an adversarial filesystem boundary or
prevent writes after the final pre-removal check.

## Historical records and unavailable source

1. Recovered Git base: `7bc18b4ac4cd932d8cde12d085b1d947c7816c4e`. Its original
   [2026-09-30 verification note](evidence/public-baseline-verification-2026-09-30.md)
   is archived as history. Historical npm audit and other checks are not newly
   verified by copying that note
2. A later local tree was reported as **425 passing tests in 38 files**, including
   22 real-service tests and compiled PostgreSQL/Garage smoke. That tree and its
   source archive are **unavailable after restart**. Those results do not apply to
   this checkout. The unavailable archive's recorded SHA256 was
   `c74e120df3aeba3c3d4423858bf0e89d44380678c149613e5e02e5257dbd9a7c`
3. The separate initial workspace proof passed 9 authored tests before integration.
   The sibling `workspace-proof/` and its archive are retained only as historical
   evidence. Maintained workspace code and tests are now in this repository

The unavailable later implementation is not recovered by these local slices.
Remaining gaps include provider PR-history ingestion, live semantic mining/review,
feedback-driven rule synthesis, production rule governance, before/after
introduction analysis, queued application jobs, authenticated case assessment,
real PostgreSQL/S3 restart checks, paper/protocol drafts, temporal-evidence/outcome
metrics, and optional JSON subprocess execution. Local frozen snapshots and the
bounded review/feedback/request loop above do not establish those capabilities.

## Local revision comparison checkpoint

The [full 268-test run](evidence/revision-comparison-verification-2026-10-01.txt)
includes 54 new storage tests, 5 aggregate-budget/limit/coverage tests and 3
separate-process CLI tests. Type checking, production build and diff checks pass.
The [compiled synthetic smoke](evidence/compiled-revision-comparison-smoke-2026-10-01.json)
records a preserved positive/corrected negative and an explicitly lost-positive
candidate. Counts include overlapping case and feedback entries, not independent
bug discoveries. The requests stay pending with synthesis `not_run`, and fixture
labels leave human verdicts Unknown.

The implementation freezes complete declared regression unions and selected
feedback anchors, pins exact paired reviews and source/case bindings, rederives
reports on read, and rejects acceptance on incomplete or regressed evidence.
Tests cover exact lineage/head/path/source/anchor binding, unknown and missing
coverage, finding-level FP boundaries, known holdout-source leakage, append-only
SQL, idempotence/concurrency, rollback/retry, disk reopen, and rehashed tampering.
Decisions remain explicit caller declarations with no mutable production catalog,
legacy v1 promotion or semantic certification. This is local fixture plumbing;
no live model synthesis, authenticated ground truth or held-out evaluation ran.

## Local PR mining request/candidate checkpoint

The [279-test aggregate run](evidence/pr-mining-verification-2026-10-01.txt) adds
11 mining tests across three files. Type checking, production build, deployment
manifest validation (30 YAML documents), and diff checks passed. Shipped synthetic
inputs also pass through separate CLI processes with ambient model configuration
present but unused. These checks cover the request/supplied-candidate slice; they
do not establish a live mining adapter or model quality.

The [compiled real-evidence smoke](evidence/pr-mining-vllm8568-smoke.json) reused
the previously captured public vLLM #8568 package without another network call.
It selected exact before/after `protocol.py` bytes, persisted two unlabelled
training cases and a supplied unverified semantic-v2 hypothesis, and verified
identical request/candidate reads across process reopen. The existing review
runtime produced two explicit semantic `not_run` targets and no findings; that
is not a safety or accuracy result. Both cases remain `expected: unknown`, with
no declared human reviewer; no rule is active.

The new records are immutable request provenance and candidate links. Source
cases, snapshots, PR evidence and rule versions use the existing registries.
Request/cases and candidate/rule writes roll back atomically. Source/statement
bindings and cases are rederived on reads; forged labels, exact provenance drift,
fixture-origin laundering and recomputed-digest tampering are rejected. Source
split restrictions remain intact. See [the contract and executable examples](pr-mining.md).

No live model mining, historical checkpoint reconstruction, authenticated labels,
regression certification, target-code execution or external publication occurred.

## Not verified or implemented here

- Real OpenSandbox backend, server deployment, isolation, resource/network policy,
  remote cancellation/termination, binary transfer and failure retention
- Official Codex SDK execution inside the workspace/sandbox, target account login,
  actual model inference, account quota or full-repository agent behavior
- Docker image build, Kustomize rendering, Kubernetes schema/admission checks,
  cluster startup, runtime network enforcement, gVisor or Temporal
- Remote PostgreSQL, real S3 conditional-write/read-back, multi-host recovery,
  restart/backup/PVC/node-failure drills
- vLLM native tests or GPU workloads; seed static replay is not heldout evaluation
- Independent real labels, cross-repository generalization, outcomes or ROI

No credentials were read or moved, no authentication was changed, and no model,
sandbox, remote deployment, repository publication, GitHub comment, PR or push was
performed for this integration. Apache-2.0 project licensing was restored as requested;
third-party licenses and notices remain intact.

## PR mining execution provenance, 2026-10-02

The trusted workspace generation path now connects strict mining worker output to
version-2 candidate receipts and atomic persistence. New imports require an opaque
in-process runtime capability; stored receipt reads reconstruct and check the
exact prompt, response and source-bound rule. Existing supplied/fixture payloads
and the supplied-only CLI are preserved. No new table or migration was needed.

Final typecheck, build and **437 tests across 37 files** passed with two file
workers (190.00 seconds). The compiled existing mining CLI example passed. Typed
worker acceptance tests compile fresh and use the actual pinned SDK with an
author-controlled executable. The new runtime/store suite exercises save/reopen,
rollback/retry, counterfeit authority, altered bindings, cleanup failure and
cancellation. These are explicitly fixture results with no model execution, and
no live model/backend/authentication/production isolation was verified.

See [the API and trust boundary](pr-mining-model-boundary.md) and
[the verification record](evidence/pr-mining-execution-verification-2026-10-02.txt).

## Semantic-v2 workspace review connection, 2026-10-02

The [supervised review API](semantic-review-model-boundary.md) now connects exact
semantic-v2 rules to the existing full-repository runner and immutable review /
finding store. It re-captures the snapshot from local Git before execution,
requires a verified head checkout and typed worker result, and grants persistence
only through a process-local runtime capability. Accepted decisions remain tied
to captured evidence; required and model-declared context gaps force Unknown.

Final typecheck, build and **530 tests across 39 files** passed with two file
workers (239.94 seconds). The final focused success/continuity and existing
comparison suite passed 66 tests. Deployment-manifest validation and diff checks
also passed. The [compiled authored SDK smoke](evidence/compiled-semantic-workspace-smoke-2026-10-02.json)
ran through temporary Git capture, exact-head workspace, fixed semantic worker,
immutable save and identical database reopen. It preserves fixture origin,
`modelExecution: not_run`, human verdict Unknown, verified cleanup and unverified
introduction/notification eligibility. Reproduce it after build with
`node scripts/smoke-semantic-workspace.mjs`.

New tests cover SDK-to-store success, forged authority and receipt bindings,
context gates, wrong/uncaptured/scope anchors, malformed protocol output, byte
limits, runtime observations, cleanup failures, cancellation and rollback/retry.
Read-only audit identified two compatibility edges, both repaired and tested:
legacy duplicate required-context gaps retain their exact payload, and revision
comparisons retain workspace-receipt provenance instead of relabeling it as
fixture-only evidence. Existing stored fixture identities remain unchanged.

See [the recorded checks](evidence/semantic-review-workspace-verification-2026-10-02.txt).
This proves authored application integration, not actual model execution or
production isolation. No live backend/model/authentication, deployment, upload,
publication, dependency install or commit occurred. Unchanged-file evidence,
introduction analysis, authenticated feedback, notifications and production
infrastructure remain separate work.

## Bounded repository PR-history ingestion, 2026-10-02

[PR-history ingestion](github-pr-history.md) adds explicit repository/creation-window/
status search, an integrity-only frozen plan, and bounded serial capture reusing
the existing official Octokit capturer. Immutable discovery plans and CAS-protected
local per-PR progress survive process restarts. Explicit mining requests reuse the
existing exact-source/unknown-case derivation, with creation and linkage in one
transaction. Saved reads revalidate evidence, snapshots and mining references.

Final source-frozen typecheck, build and **615 tests across 43 files** passed with
two file workers (331.35 seconds). The compiled offline CLI smoke passed preview,
import, partial exit 2, reopen/resume, exact mining linkage, show/list and zero-GET
completed resume. Deployment-manifest validation and diff checks also passed.

See the [verification record](evidence/github-pr-history-verification-2026-10-02.txt)
and [compiled smoke output](evidence/compiled-github-pr-history-smoke-2026-10-02.json).
No live GitHub/vLLM reads, authentication, model inference, dependencies, external
writes, publication, upload or commit were used. This verifies authored application
integration, not live GitHub behavior, probability sampling, historical checkpoints,
semantic ground truth, or production multi-process PostgreSQL operation.

## Live PR-history query correction, 2026-10-02

The [first live search attempt](evidence/github-pr-history-vllm-live-2026-10-02.json)
failed closed: two `created:` qualifiers returned 22,309 reported results and
out-of-window PRs from 2023 for a one-hour September 2024 window. No plan or
capture was produced. That original evidence remains unchanged.

The query now uses GitHub's documented single inclusive timestamp range, from the
requested lower bound through the exclusive upper bound minus one second.
Whole-second precision is explicit for bounds and returned creation timestamps;
nonzero fractions, including sub-millisecond fractions JavaScript would truncate,
are rejected. Exact local window, status, repository, identity, ordering and
completeness checks remain in place. No out-of-window row is silently retained
or removed to assert complete coverage.

Final typecheck, build and **627 tests across 43 files** passed with two workers
(337.21 seconds), including 52 focused history tests. The compiled authored CLI
smoke passed with an assertion on the real Octokit request query, and deployment
manifest validation and diff checks passed. The source and compiled module hashes
were unchanged throughout the final full-suite and live-preview checks.

After those checks, exactly one unauthenticated live GET from the compiled CLI
returned HTTP 200, reported total 1, and PR [#8568](https://github.com/vllm-project/vllm/pull/8568)
at the requested inclusive lower bound. The saved plan has one observed/selected
row and `all-reported-search-results-observed`; this describes that reported
search only, not complete repository history. See the [corrected query, exact
plan and verification evidence](evidence/github-pr-history-range-live-2026-10-02.json).

This query-validation step did not capture PR blobs, create a database, run a
model, execute target repository code, authenticate, upload, publish or commit.
Live capture/reopen/resume/mining validation is a separate subsequent step; the
offline smoke proves authored application behavior only.


## Detectorless semantic revision comparison, 2026-10-02

At this historical checkpoint, comparisons used `explicit-semantic-v2`: explicit, validated semantic target
judgments can score declared file cases with no detection assets or zero hits.
Selected feedback requires an explicitly adjudicated exact anchor, including safe
anchors; a file-level safe judgment or a cited excerpt alone cannot correct an FP.
Missing evidence/context/anchors and unknown/not-run states remain inconclusive,
while the base/candidate regression union retains dropped positives.

Final typecheck, build and **648 tests across 44 files** passed with two workers
(332.54 seconds). The new compiled detectorless comparison/store/CLI smoke and
existing compiled revision-generation/semantic-workspace smokes passed. Static
deployment validation and diff checks passed; no deployment was performed.
Legacy report/decision rederivation and execution-prompt bytes remain compatible;
new acceptance requires current scoring. Re-running pre-update authored demos
requires fresh DB/output destinations because the explicit safe fixtures changed.

See the [verification record](evidence/detectorless-comparison-verification-2026-10-02.txt),
[compiled smoke output](evidence/compiled-detectorless-comparison-smoke-2026-10-02.json),
[comparison contract](local-revision-comparisons.md), and
[methods review](../paper/method-draft.md). These checks use authored semantic
fixtures and establish application behavior only. No external requests, credentials,
live model inference, dependencies, publication, upload or source commit were used.
That checkpoint retained one shared decision per target. The mixed-anchor contract
above removes that representation limit; the older run does not verify the new
per-anchor behavior.

## Optional evaluation workspace integration

The [evaluation workspace policy](evaluation-workspaces.md) connects the immutable
export to independently derived Git storage and the existing Sandcastle execution
lifecycle. [Final verification](evidence/evaluation-workspace-verification-2026-10-02.txt):
999 tests across 72 files passed with maxWorkers=2; typecheck, build and both
compiled workspace/export smoke checks passed. The compiled authored runtime
rejects source future commits/tags/dangling objects while preserving baseline bytes.
No live model/backend was run, and historical public availability remains unproven.


## Governed local semantic review execution, 2026-10-02

The [governed coordinator](governed-semantic-reviews.md) connects immutable local
selection manifests to the existing trusted application review jobs. It freezes
full registry heads/exclusions, checks every attempt at an atomic admission point,
and preserves admitted historical execution across later transitions. Stale
pending jobs and retries cannot bypass suspension. Explicit digest replay remains
available and is labeled non-governed in CLI output.

Final frozen source/test suite: **1,177 tests across 80 files passed** with
`maxWorkers=2` in 715.38 seconds. Typecheck, production build, worker `--check`,
30-document static deployment validation and diff-check passed. The
[compiled smoke](evidence/compiled-governed-semantic-reviews-smoke-2026-10-02.json)
passed 16 checks with zero network attempts. A read-only review's historical-read
budget and transient-database-retry findings were fixed and regression tested.

The lifecycle tests exercise authored SDK programs through real asynchronous
pg-boss callbacks and local PGlite: root selection, review, suspension, exact
comparison-backed supersession, successor review, deduplication, retries and
reopen. See the [complete check record](evidence/governed-semantic-reviews-verification-2026-10-02.txt).
No live PostgreSQL, credentials, model/backend, installation, deployment, upload,
publication or commit occurred; no semantic correctness certification is claimed.
