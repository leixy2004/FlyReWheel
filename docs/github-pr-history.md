# Bounded repository PR-history ingestion

This is an explicit local acquisition workflow for a selected repository/time window.
It discovers PR numbers with the official Octokit client, freezes a small plan, then
calls the existing [single-PR capturer](github-pr-evidence.md) serially. It does not
run a model, synthesize rules, execute repository code, start a background crawler,
modify GitHub, authenticate, upload anything, or create another queue.

## Preview, inspect, import, capture

A small vLLM development example (choose the creation window and status deliberately):

```bash
npm run cli -- github-pr history preview \
  --repository vllm-project/vllm \
  --created-from 2026-09-29T00:00:00Z \
  --created-before 2026-09-30T00:00:00Z \
  --status merged --max-pulls 3 --max-pages 1 \
  --out vllm-history-plan.json

# Inspect pulls and discovery.coverage before importing the local selection.
npm run cli -- github-pr history import \
  --file vllm-history-plan.json --db .flyrewheel/history-db

# BATCH_SHA256 is the exact digest returned by preview/import.
npm run cli -- github-pr history capture \
  --batch BATCH_SHA256 --db .flyrewheel/history-db \
  --max-pulls 1 --max-requests 50 --out capture-run.json

npm run cli -- github-pr history show \
  --batch BATCH_SHA256 --db .flyrewheel/history-db
npm run cli -- github-pr history list \
  --repository vllm-project/vllm --db .flyrewheel/history-db
```

Preview needs no database and captures no blobs/discussions. Import only persists
the declared selection, with all PRs initially `pending`. Reimporting the same
plan is idempotent and preserves its existing local progress. A different discovery
observation produces another content-addressed plan. List uses digest ordering,
`--after` and `--limit`; its cursor is not a claim that another page exists.

Creation times are ISO-8601 with whole seconds. The window is inclusive at
`--created-from`, exclusive at `--created-before`, and at most 366 days. It filters
PR creation, not merge or closure time. Status is required: `all`, `open`, `closed`
(including merged), or `merged`. Captured current state must still satisfy the
frozen filter. Status movement outside the filter is recorded as `out-of-filter`;
it never silently substitutes another PR.

The API query uses GitHub's documented single inclusive range,
`created:FROM..LAST_SECOND`, where `LAST_SECOND` is the exclusive before bound
minus one second, normalized to UTC. For example, `[15:17:18Z, 16:17:18Z)`
becomes `created:15:17:18Z..16:17:17Z` with the full date on both endpoints.
One-second windows have identical range endpoints. The implementation requires
whole-second creation bounds and returned creation timestamps; nonzero fractions,
including sub-millisecond fractions that JavaScript would truncate, fail closed.
Zero-only fractions and equivalent UTC offsets are accepted without changing the
stored filter. Every response still passes the exact local `[from, before)`
and status filter. A result at `before`, before `from`, or from another repository
rejects the preview; none is silently dropped to manufacture a complete plan.

GitHub search is requested in creation-time ascending order. Retained rows are
ordered by creation time, then PR number. Equal-time rows beyond a page/PR cap can
have unstable membership; the saved plan fixes the exact selected order. Only
locally constructed numbered API requests are used, never Link-header targets.
Duplicate rows, backwards time ordering, inconsistent pages, changed reported
totals, foreign identities and out-of-filter results reject discovery.

## Completeness is explicit and limited

The plan records pages/rows read, reported total, next-page presence, stop reason,
`incomplete_results`, the search result cap, and coverage notes. A PR selection cap,
page cap, provider-incomplete search, omitted results, or reported total over
GitHub's 1,000-result search cap yields `partial-search-results`. An uncapped,
consistent response can say only `all-reported-search-results-observed`. Search
indexing and non-atomic API changes still preclude complete repository-history or
historical-checkpoint claims. Narrow the explicit window if more coverage is
needed; this workflow does not automatically split windows or crawl onward.

The selected PRs are a bounded development observation, **not a probability
sample, paper evaluation cohort, semantic ground truth, or reconstructed
pre-feedback review checkpoint**. The existing capture's current base/head and
merge-base semantics are unchanged. A merged PR can have an empty current
comparison. It is stored as empty, never replaced with an invented historical
diff; empty or excluded sides cannot seed a mining source selection.

## Durable progress and recovery

The database stores the immutable plan plus per-PR `pending`, `capturing`,
`captured`, or `failed` progress, attempt count, last attempt time, bounded failure
category, optional sanitized `failureDiagnostic`, exact `evidenceDigest`, exact `snapshotDigest`, and explicitly linked
mining request digests. Progress updates use compare-and-swap revisions. Only one
PR per batch may be active. This is a synchronous local operator workflow, not a
scheduler, queue, lease service, or promise of exactly-once network acquisition.

Run `capture` again to process pending PRs; completed evidence is verified from
local storage and reused without fresh GETs. Failed PRs stay failed until the
operator explicitly adds `--retry-failed`:

```bash
npm run cli -- github-pr history capture \
  --batch BATCH_SHA256 --db .flyrewheel/history-db \
  --max-pulls 2 --max-requests 50 --retry-failed
```

A process/database failure can leave `capturing`. First stop any other operator,
inspect `show`, then explicitly use `--recover-interrupted`. This records the
interruption and retries that PR. Never use recovery against a still-active
process. A crash between evidence persistence and progress persistence can leave
an unlinked immutable evidence record; retry reuses the same content if unchanged.
If current API content changes, retry can create a different exact evidence ID.

HTTP 403/429 stop the invocation rather than retrying or switching authentication.
403 is classified as `forbidden-or-rate-limited`; 429 as `rate-limited`.
Other acquisition failures are recorded per PR and can continue within the same
fixed budget. Raw provider bodies and credential-bearing request objects are not
saved as errors. Local persistence/CAS failures stop with the active item intact
for explicit inspection/recovery. Invocation exit code is `2` if any selected PR
remains pending/failed; `0` means all selected PR captures are complete (an empty
plan is also complete); argument/storage failures exit `1`.

New HTTP capture failures can retain `failureDiagnostic.status` and the following
allowlisted response metadata, when valid and present: `requestId` (at most 128
characters, four or five colon-separated hexadecimal groups),
`rateLimitRemaining` (request count), `rateLimitReset` (Unix seconds), and
`retryAfterSeconds` or `retryAfterAt` (canonical HTTP-date converted to UTC ISO-8601).
Numbers must be nonnegative safe integers. Malformed/oversized fields are omitted;
arbitrary headers, response bodies, request objects, URLs, tokens and raw error
causes are never copied into diagnostics. A transport error with no HTTP response
does not gain an HTTP status just because Octokit assigns it an internal status.

These are bounded observations, not proof of the reason for a denial or a fresh
acquisition receipt. Even a 403 with rate-limit metadata retains the ambiguous
`forbidden-or-rate-limited` category; no automatic retry or authentication change
is introduced. Old rows without diagnostics still load unchanged. Their missing
headers cannot be reconstructed, so a previously saved 403 remains undiagnosed.
Diagnostics describe only the latest failed attempt and are cleared when an
operator explicitly starts another attempt, rather than carried into its result.

All saved/imported/shown batch state is `package-integrity-only`. Discovery-plan
imports reject progress and fresh-acquisition receipts. `run.freshCaptures` holds
only receipts produced by successful capturer calls during that invocation.
Prior successful rows, resumed rows and imported claims never acquire a fresh
receipt. On read, evidence, snapshot, repository/PR/filter and linked mining
request bindings are revalidated.

## Explicit PR-granularity mining requests

Use `github-pr show --digest EVIDENCE_SHA256 --db ...` to inspect one captured
package, then author the existing [mining-request input](pr-mining.md), including
its exact evidence digest, selected captured before/after paths, selected PR or
discussion statements, objective, actor and requested rule identity. Save that
JSON and link it through the batch:

```bash
npm run cli -- github-pr history mining-request \
  --batch BATCH_SHA256 --number PR_NUMBER --file mining-request.json \
  --db .flyrewheel/history-db
```

This calls the existing immutable mining request/unknown-case derivation. The
request and its local batch link commit atomically; failed validation, link caps
or a revision conflict roll back both. It rejects evidence from another batch PR.
At most 20 explicit mining requests may be linked per PR; identical requests are
idempotent. No automatic source/statement selection, defect labeling, synthesis,
feedback, activation, evaluation, or queue job is introduced. Existing supervised
mining/runtime APIs and the existing pg-boss queue remain separate.

## Fixed bounds

- One explicit public repository and at most a 366-day creation window
- Preview: default 5/max 25 selected PRs, default 2/max 10 pages, 5 rows per page
- Preview: 30-second aggregate deadline, at most 10 seconds per GET; 2MB per decoded
  response and 4MB aggregate decoded JSON; 500KB plan input/output ceiling
- Capture: default 2/max 5 PR attempts per invocation; default 50/max 200 aggregate
  GETs; default/max 50 GETs per PR; default 120/max 300 seconds aggregate capture
  time, with the existing 120-second per-PR and 15-second per-GET ceilings
- Existing capture bounds remain in force, including blob/tree/discussion/change
  limits, exact-byte verification and all-or-nothing evidence validation
- At most 12MB accepted compact evidence per invocation; the manifest/CLI result
  returns identifiers and receipts, not all captured source payloads
- API origin fixed to `https://api.github.com`, API version `2022-11-28`, GET-only,
  no ambient token use, no redirects, automatic retries, login or auth fallback

JSON budgets apply after official Octokit decoding. They do not establish a
streaming network-byte, decompression or peak-memory bound. The aggregate deadline
bounds acquisition; local database validation/commit time is additional.

## Verification

`tests/github-pr-history.test.ts` exercises the pinned official client through an
authored fetch transport, including search caps/filtering/order, malformed
responses, pagination attacks, persisted reopen/resume, failures/recovery,
aggregate/per-PR budgets, exact mining linkage and import trust boundaries.
`tests/github-pr-history.cli.test.ts` exercises separate CLI processes and input
guards. To verify the built distribution and copied migration offline:

```bash
npm run build
node scripts/smoke-github-pr-history.mjs
```

That script uses only authored fixture responses. It checks preview, import,
partial exit code, process restart/resume, explicit mining linkage, show/list and
zero-GET completed resume. It makes no live GitHub/model/authentication call.

Primary references: [GitHub search REST limitations and search endpoint](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests),
[inclusive ranges and second-precision timestamp search syntax](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax#query-for-dates),
[issue/PR date and state search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests),
[official Octokit method](https://github.com/octokit/plugin-rest-endpoint-methods.js/blob/main/docs/search/issuesAndPullRequests.md).
