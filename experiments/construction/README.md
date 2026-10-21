# Offline construction configuration and authored replay

This module validates construction configuration and demonstrates consumed slots,
failed attempts and deterministic candidate retention without login or network.
It is **authored development mechanics only**, not an empirical freeze, a real
constructor, source eligibility judgment, model run or independent annotation.
The existing working checkout was 17879c1; earlier methodology branches were not
present locally and are not assumed integrated.

`contracts.ts` provides a strict Zod configuration schema. It binds repository,
protocol/instructions, constructor version, ordered unique roster, source packet
digests, exposure declaration and resource limits. Unknown model/provider/version/
seed/decoding values remain `constructor.kind=unconfigured` with explicit missing
fields. Only an authored-fixture constructor and origin can freeze here. A fully
filled model configuration still cannot execute; there is no network/model adapter.
The first remaining source exposure must follow the configuration freeze; W1
exposure blocks it. Declared timestamps/digests are not authenticated exposure proof.

`runner.ts` accepts authored receipt objects and the explicit raw-response envelope below. Each submitted PR must form an
ordered prefix of non-rejected roster slots, with no duplicate or replacement.
A completed empty proposal is `no_rule`; no supplied receipt is `not_run`; an
interruption or malformed candidate is `failed`. Every raw receipt survives in
`inputs.json`, including failed runs; cap-excluded candidates stay in the report.
Byte limits are enforced. Token and time limits are declared for a future executor,
not measured or claimed enforced by this offline replay.

Candidates sort by UTF-8 path, before/after side, line span, then canonical digest.
Only the first is retained provisionally. Family keys bind repository and semantic
fields but establish neither independence nor semantic equivalence. The raw-response path now rejects duplicate JSON keys and validates spans against
digest-bound authored packet bytes. It does not independently screen semantic
compound rules or establish semantic support. Exact family grouping and authored
episode routing are described below; no candidate is marked admitted. Existing core canonical JSON is reused.

The authoritative register is `.construction-attempts/` relative to this module's
checkout, independent of cwd/output directory, with no CLI path override. Repository
identity binds exactly one freeze; each PR binds an immutable original receipt.
Changing output directories or copying reports cannot register a different receipt.
Exact receipt replay is allowed without a new construction. Invalid bound receipts
consume their identified slot; later corrections are rejected. Every registered
slot must appear in a current report, including failures. `replay()` alone is a pure,
unregistered authored projection; only `writeReplay`/`verifyReplay` use the register.

A run reserves its slots before computing its report. A process interrupted after
reservation can recover only those exact stored receipts. Missing/partial or corrupt
registry files fail closed; they are not silently deleted or repaired. Output
folders use exclusive creation and preserve failure records. As the registered
prefix grows, verification rejects older shortened projections; recover the complete
current prefix instead of concealing later failures.

This is a local trusted-filesystem guarantee, not an authenticated distributed
registry. Changing repository aliases, copying the whole checkout/registry, deleting
records as their owner or modifying code is outside the guarantee. A cohort lock serializes registration/verification; busy or interrupted locks are
never automatically taken over. A crash while holding that lock needs an explicit
operator integrity audit before any lock removal, not a new output directory.
Completed registrations can be recovered automatically after report interruption.
Atomic exclusive file creation also prevents competing receipt replacement. There is no fsync power-loss durability claim.
`authored/` repository names are required for authored freezes, while real-source
and model configurations remain blocked. Names and declarations cannot authenticate
whether maliciously relabeled bytes are synthetic. No output grants empirical admission.

## Reproduce without network

Run from repository root with existing dependencies. Use new output paths:

```sh
node --import tsx experiments/construction/replay.ts authored /tmp/construction-example
node --import tsx experiments/construction/replay.ts verify /tmp/construction-example
node --import tsx experiments/construction/replay.ts recover authored/example /tmp/construction-recovered
node --import tsx experiments/construction/replay.ts draft /tmp/construction-draft.json
node --import tsx experiments/construction/replay.ts check /tmp/construction-draft.json
npx vitest run tests/construction-freeze.test.ts tests/construction-registry.test.ts --maxWorkers=1
npx tsc --noEmit
```

`check` exits **2** for the intentionally blocked draft. The generated draft uses
explicit authored placeholder roster/digests and `UNCONFIGURED` repository; it is
not the HTTPX cohort or an execution configuration. `authored` uses a fixed synthetic
clock and two invented PR IDs solely for reproducibility. `verify` recomputes the
report and checks reserved inputs, freeze binding and output digest without rewriting evidence (it briefly acquires the cohort lock).
It cannot authenticate who originally wrote the artifacts.

## Authored episode selection

`episode-selection.ts` adds a two-stage offline selector: `selectIndices` first
binds the complete authored plan and all review cells, then `selectEpisodes` accepts
separately bound synthetic feedback. Cells bind plan, rule and packet digests;
duplicate exact-rule families and replacement cells are rejected. Missing/malformed
earlier work blocks an index, and Unknown feedback cannot select a later finding.
All raw cells, later findings and missing matrix entries are retained. Selection now rereads and briefly locks the authoritative construction register; persisted index calls go through
`episode-registry.ts`, which binds the first plan/cell request and final feedback
across calls in a fixed checkout-local register. Neither proves actual exposure times. There is no empirical execution path.

```sh
node --import tsx experiments/construction/episode-replay.ts /tmp/authored-episode-example
npx vitest run tests/episode-selection.test.ts --maxWorkers=1
```

The demo saves `index-lock.json`, `feedback.authored.json` and `episode-report.json`
in a new exclusive directory. Synthetic PR 2 is selected; synthetic Unknown feedback
blocks the episode despite a later finding. Repeating this demo is a software test,
not an additional independent experiment. It never reads real W1 or source files.

## Persisted index and feedback

The example CLI now uses `.episode-attempts/`, keyed by declared authored repository,
with no output-path override. `index-request.json` permanently fixes the original
plan/cells/time in this local register; `index.json` is its derived selection.
Changing the plan, cells or declared lock time conflicts even if new digests are
computed. `feedback-request.json` fixes final feedback, including Unknown or an
explicitly finalized empty list (missing). Replacing either decision is refused.
Before finalization, recovery reports `not_finalized`; it does not invent judgments.

```sh
node --import tsx experiments/construction/episode-replay.ts --recover authored/episode-linked-demo-v1 /tmp/episode-recovered
```

Recovery derives missing reports only from preserved requests, checks existing
artifacts and never reruns review/construction. Validation failures leave their
request and failure records. Partial JSON, conflicting artifacts or surviving locks
stop recovery; there is no automatic repair or lock takeover. As with construction,
this is one trusted checkout's append-only policy, not authentication, protection
against owner tampering/aliases/another checkout, or power-loss durability.
Direct selection still does not persist an index; only the registered wrapper
locks index/feedback choices. Both entrypoints validate construction provenance. All registered reports remain `empiricalAdmission: false`.

Episode families now come from the complete authoritative construction replay.
Freeze/report digests and exact family membership must match, including every
retained PR/candidate digest. These are provisional retained candidates, not
independently admitted semantic rules. See the
[combined closeout matrix](../../paper/local-research-closeout.md) for the exact
completed and incomplete boundaries and validation evidence.

The linked demo uses `authored/episode-linked-demo-v1`, a new explicit fixture
version; earlier unlinked registry artifacts are preserved, not rewritten or
silently migrated. Legacy plans without construction bindings fail validation.
Construction must have a disposition for every slot before selection. All exact
families enter the plan; cap-excluded candidates and omitted families cannot enter
or disappear through caller-supplied hashes. Recovery rechecks the same authority.
Declared freeze times do not prove actual construction completion timestamps;
empirical chronology still requires independent evidence.

## Raw-response ingestion and pinned line anchors

`raw-response.ts` adds an offline input path without changing the frozen research
protocol or enabling real-source/model execution. Use:

```sh
node --import tsx experiments/construction/replay.ts raw INPUT_JSON NEW_DIRECTORY
node --import tsx experiments/construction/replay.ts verify NEW_DIRECTORY
node --import tsx experiments/construction/replay.ts recover authored/REPOSITORY RECOVERED_DIRECTORY
```

`INPUT_JSON` contains exactly `{ "frozen": <existing authored freeze>, "inputs":
[<receipt>, ...] }`. Each receipt contains `pr`, `packetDigest`, `outcome`
(`completed` or `interrupted`), `rawResponse` (the original JSON text, **not** an
already parsed object), and `sourcePacket`. Do not supply `candidates` in the same
receipt. The complete ordered attempted prefix is required, including failures.
The outer JSON also rejects duplicate keys; an ambiguous/unparseable envelope
cannot identify a trustworthy slot and is rejected before registration.

A source packet has exactly these fields:

```json
{
  "schemaVersion": 1,
  "kind": "authored-construction-source-packet",
  "repository": "authored/REPOSITORY",
  "pr": 1,
  "beforeCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "afterCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "files": [{
    "path": "source.ts", "side": "after",
    "content": "guard();\noperation();\n",
    "sha256": "<SHA-256 of the UTF-8 content bytes>"
  }]
}
```

The example commit IDs are synthetic declarations. `packetDigest` must equal the
existing `digestOf(packet)` canonical JSON digest in both the receipt and frozen
roster. Repository, PR, before/after revisions and every file are thereby bound.
Each file-side pair must be unique. Content is strict UTF-8 with its own SHA-256;
packets contain at most 256 files and 2,000,000 content bytes. No repository paths
are opened, no sources are acquired and no commit provenance is authenticated.
The actual 38-PR roster, complete permitted source packets and independently
verified exposure ledger are still missing integration inputs. Real-source
configurations continue to fail closed.

`rawResponse` is exactly `{"candidates":[...]}`. Candidates use the existing
[path/side/start/end/scope/applicability/invariant/exception/requiredContext
schema](candidate.ts), plus required `quote`. Positive safe-integer line spans
must be ordered, exist on the specified side, and match `quote` exactly. Quotes
include each selected line's existing LF/CRLF terminator; a final unterminated
line has none. Empty files have no addressable lines. No trimming or newline
normalization occurs. Nested and escaped duplicate keys, unsafe spans, extra
fields (including a separate compound `invariants` array), wrong quotes and
ambiguous sources fail the **whole attempt**, even when another candidate is valid.
Natural-language compound invariants are not automatically detected or admitted;
that remains independent semantic screening work.

The original raw text and source packet survive in `inputs.json` and the fixed
attempt register. Malformed/budget-exceeded/interrupted responses consume their
identified slot with a failed disposition; correcting their text in another
output directory conflicts with the register. Empty proposals yield `no_rule`;
missing receipts remain `not_run`. Recovery reuses the original receipt only.
A valid response still uses the existing deterministic candidate cap, and reports
`semanticSupport: not_assessed`, zero model calls and `empiricalAdmission: false`.
Response budgets count the original UTF-8 response bytes, with bounded JSON depth;
CLI envelopes have a separate 8 MB cap. Source hashes and declarations do not
prove exposure history, source truth, independent annotation or efficacy.

## Roster and exposure declaration binding

A separate validator now checks supplied roster, configuration and exposure
ledger declarations without opening any research inputs automatically:

```sh
node --import tsx experiments/construction/replay.ts bind-exposure INPUT_JSON NEW_DIRECTORY
node --import tsx experiments/construction/replay.ts verify-exposure NEW_DIRECTORY
```

`INPUT_JSON` has exactly `config`, `roster` and `ledger`. `config` is the existing
configuration schema; this interface does not change its frozen protocol fields.
The strict exported `RosterManifestSchema` and `ExposureLedgerSchema` in
[exposure-binding.ts](exposure-binding.ts) define the other inputs:

- Roster: `schemaVersion: 1`, `kind: construction-roster-manifest`, matching
  `origin` and `repository`, and ordered `entries`. Each entry contains the exact
  configuration roster fields plus declared `beforeCommit` and `afterCommit`.
- Ledger: `schemaVersion: 1`, `kind: construction-exposure-ledger`, matching
  origin/repository, `rosterDigest: digestOf(roster)`, `declaredAt`,
  `firstRemainingSourceAt`, `firstW1At`, and exactly one same-order entry per PR.
- Each ledger entry contains `pr`, `classification` (`development-exposed`,
  `remaining` or `unknown`), nullable `firstSourceAt` and `evidenceDigest`,
  `priorRejected`, nullable `rejectionReason`, and `missingEvidence`.
  Rejected slots require a reason; other slots must have no rejection reason.
- Configuration `exposure.auditDigest` must equal `digestOf(ledger)` and its
  timestamp summary must match. Thus its digest transitively binds the ordered
  roster, declared commits, source-packet digests and complete exposure ledger.

Unknown exposure, missing exposure evidence and incomplete non-rejected source
packets remain in the output with `status: incomplete`. Prior rejections and
already exposed development cases are retained rather than filtered away.
`firstRemainingSourceAt` must match the earliest supplied `remaining` exposure;
recorded source times cannot be later than the ledger declaration. A supplied
W1 timestamp produces a blocker; no W1 file is opened to establish that field.
A self-consistent ledger reports `bound-declarations-only`, never execution ready.

Output preserves `inputs.json` and a digest-bound `report.json` in a newly created
directory. A validation failure preserves inputs with `failure.json`; existing
output directories are never overwritten. Verification recomputes bindings and
rejects changed reports. This output is not the construction attempt register,
not a freeze, not an admission decision and not authenticated evidence. If an
owner changes all inputs and recomputes every digest, that is a new declaration;
without an externally trusted expected digest, it cannot be distinguished from
an authentic original. `verify-exposure` verifies internal consistency only.

Tests use 38 **invented** rows to cover the intended roster scale. The schema
accepts 1–10000 rows and does not certify membership in the actual retained cohort.
No actual 38-PR roster or exposure history was loaded. Required real inputs remain
an authorized W0-only roster projection, complete permitted source-packet bindings,
prior rejection records and independently audited exposure evidence. Both authored
and public-source declarations can be checked, while existing real-source freezes
remain blocked. Source digests/commit IDs are not resolved or authenticated, and
all reports retain `executionReady: false`, `empiricalAdmission: false`, zero model
calls and zero independent labels.

## Authored screening of the fixed first candidate

The screening interface binds supplied assessor results to the already-retained
construction candidate. It performs no semantic judgment or human authentication:

```sh
node --import tsx experiments/construction/replay.ts screen-lock REQUEST_JSON
node --import tsx experiments/construction/replay.ts screen-finalize authored/REPOSITORY RESULTS_JSON
node --import tsx experiments/construction/replay.ts screen-recover authored/REPOSITORY
```

The lock request contains exactly `plan` and `lockedAt`. `ScreeningPlanSchema` in
[screening.ts](screening.ts) requires `kind: authored-construction-screening-plan`,
`origin: authored-fixture`, the registered authored repository, its exact
`construction.freezeDigest` and `construction.reportDigest`, and two distinct
predeclared assessor IDs. All construction slots must have a disposition before
screening. The lock derives choices from the authoritative construction register;
it never accepts a caller-selected replacement candidate. No-rule, failed and
previously rejected construction slots stay in the selection. Cap-excluded
candidate digests stay visible but cannot receive screening results.

`RESULTS_JSON` is an array. Each result binds `origin: authored-fixture`, the
selection `lockDigest`, `pr`, retained `candidateDigest` and a predeclared
`assessorId`. It supplies `verdict` (accept/reject/unknown), `atomicity`
(single/compound/unknown), `scope` and `sourceSupport`
(supported/unsupported/unknown), `rationale` and nullable `evidenceDigest`.
Accept requires all positive criteria and an evidence digest; that digest is a
binding declaration, not verified semantic evidence. Results for a later candidate,
foreign assessor or non-candidate slot, duplicate assessments and contradictory
accept fields fail validation.

Finalization explicitly fixes the whole result request, including an empty array
(final missing assessment). Missing, Unknown, disagreement and rejection never
select another candidate. Matching positive declarations yield only
`accepted-authored-only`. Every report keeps `independentLabels: 0`,
`assessorIdentityVerified: false`, `empiricalAdmission: false` and zero model calls.
Distinct assessor IDs do not establish independent people or authentic judgments.
`lockedAt` is a declared time checked against the construction freeze; it cannot
prove actual wall-clock ordering or that an assessor had not already seen outcomes.
Before finalization, recovery reports `awaiting-assessments` without inventing data.

The fixed checkout-local `.construction-screenings/` register reserves the first
plan and final result request before deriving outputs. New output directories or
processes do not reset choices. Exact replay is allowed; changed plans/results
conflict, including attempts to correct an invalid finalized request. Recovery
revalidates the original construction binding and reconstructs missing derived
artifacts only from preserved requests. Partial/corrupt records, conflicting
reports and interrupted locks fail closed; no automatic lock takeover occurs.
As with the existing registers, this is a trusted local filesystem mechanism,
not protection against owner tampering, repository aliases, copied checkouts or
power loss. No fsync durability or authenticated study identity is claimed.

This interface does not change the frozen protocol, automatically admit a family
into an empirical study, or upgrade the existing provisional authored family/episode
interfaces to a screened-production route. Actual independently collected screening
judgments, identity/independence evidence and semantic-support evidence remain
missing. All screening tests use invented construction and assessor inputs; no W1
metadata or content is loaded by the selected test set.

### Screened authored families and episodes

After `screen-finalize`, export the authoritative selection:

```sh
node --import tsx experiments/construction/replay.ts screen-families authored/REPOSITORY
```

The output contains `construction`, `screening: {lockDigest, reportDigest}`,
`families`, and full `screeningRows`. Only `accepted-authored-only` members enter
families; rejected, missing, unknown and disputed rows remain in `screeningRows`.
An empty family list is a valid diagnostic output, but cannot start an episode.
Family order is derived from the earliest accepted construction member, never a
cap-excluded alternative from the same PR.

Copy the returned `construction`, `screening`, and `families` into an
`authored-episode-selection-plan` with the same repository, a declared `frozenAt`
after the screening lock, and the authored target `prs` roster. Each review cell
must bind `digestOf(plan)` (including screening), its family/rule and target packet.
Use the existing cell and feedback schemas in `episode-selection.ts`:

```sh
# REQUEST_JSON is exactly {plan, rawCells, lockedAt}.
node --import tsx experiments/construction/replay.ts episode-index REQUEST_JSON
# FEEDBACK_JSON is an array bound to the returned index digest and findings.
node --import tsx experiments/construction/replay.ts episode-finalize authored/REPOSITORY FEEDBACK_JSON
node --import tsx experiments/construction/replay.ts episode-recover authored/REPOSITORY
```

These commands reserve their first requests, including failures and missing
feedback, through the existing episode registry. Repeated identical requests are
idempotent; corrections or reselection are refused. Recovery revalidates the
screening and construction records. Once a screening directory exists, omitting
the screening binding is refused, including for older episode plans: complete
screening before creating an episode in that repository. Repositories without
screening retain the legacy provisional authored workflow. This is a local
workflow guard, not tamper resistance against the filesystem owner.

All judgments, target packets and findings here remain authored declarations.
Times do not prove actual assessment chronology; assessor IDs do not establish
independence. No empirical admission, real model call, or human label is inferred.
The local authored chain now has CLI entry points through episode feedback and
recovery. Real use still requires permitted source/roster/exposure inputs and
independent screening/support evidence; adding more synthetic gates cannot supply
those inputs or authorize the currently blocked real-source path.
