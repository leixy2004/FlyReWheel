# Remaining allowance: PR 3034 source identity checks

Following the instruction to use useful next-in-order public reads within the
existing bound, consumed exactly the remaining **2 REST GET attempts**. The
previous artifact-manifest records 48/50, comprising two original failures, one
successful diagnostic and 45 capture reads. Request 49 checked the fixed merge
commit; request 50 checked its fixed root tree. Both returned HTTP 200 with matching
identities, 6,192 total response bytes. The shared REST total is now **50/50**;
no further request is permitted under that allowance. The 1,050-request proposal
has not been activated. No retry, redirects, credentials or upstream writes.

`ledger.json` records both attempts, timestamps, exact URLs, byte counts and
response hashes. `response-49.json` and `response-50.json` are quarantined provider
observations, not a complete source package. Incidental commit text was not used
for screening or rule admission. `capture-script.mjs` preserves the exact one-off
procedure; do not rerun it. Exclusive ledger creation also refuses rerunning in
this directory. The immutable original manifest remains a pre-inspection record;
`offline-admission.json` appends the disposition of all 38 W0 rows: original three
unresolved, PR 3034 source incomplete at budget exhaustion, following 34 unattempted
because of that same global stop. No replacement, case skipping or W1 inspection.

## Permission versus accounting

These were ordinary anonymous public read-only GETs using Node's existing
process-local environment-proxy support, unchanged TLS and environment routing.
No current tool permission denial occurred. Earlier stored records describe an
initial connection authentication failure and an ECONNREFUSED diagnostic; they are
not evidence of a current tool-policy denial. No denied action was retried here.
The six earlier exact-SHA Git transfers used their separately recorded full-context
stage; their internal HTTP exchange count is unknown and is not folded into or
represented as zero in the REST ledger. No new Git source transfers occurred.

## Exact proposal and remaining needs

The frozen proposal remains **30 GETs/remaining PR, 1,050 GETs total**, 2 MiB decoded
response bytes/request, 20 MiB/PR, 350 MiB cumulative decoded received bytes and
350 MiB retained bytes total, 60 seconds/request, zero retries. All errors,
truncation, duplicate and discarded bytes count; deletion does not restore budget.
It is a proposal, not permission to exceed 50. These two reads already belong to
PR 3034; any later approved extension must include them in its per-PR accounting
and explicitly define the relationship to the old overall ceiling.

The smallest next acquisition step would be **one GET** to
`https://api.github.com/repos/encode/httpx/pulls/3034` to bind PR number, mergedAt,
merge commit and observed base/head identities. Current narrative fields must
remain quarantined. It cannot be performed now because remaining REST allowance
is zero; one request alone would not complete admission. No generic public-read
permission is missing. Any continuation needs a concrete increase of the explicit
request ceiling, not adoption of the whole 1,050-request proposal by implication.

Thereafter required evidence remains distinct baseTip/mergeBase/head commits and
root trees, pinned-head license membership, complete changed paths and before/after
bytes with rename/absence/truncation accounting, and source-bound contracts,
applicability/exception context and supported defect/repair evidence. Exact counts
for a complete package cannot be known before its changed paths are obtained.
No current discussion, merge event or passing tool substitutes for that evidence.

Offline, the license blob found in PR 3034's merge root is
`ab79d16a3f4c6c894c028d1f7431811e8711b42b`. Git blob hashing of the retained 1,508-byte
LICENSE.httpx.md matches it, so those bytes need not be downloaded again. This is
merge-root license evidence only; it does not prove membership in the still-unknown
PR head root. Receipt hashes and byte sizes, frozen frame identities and the full
38-row roster were checked offline. The deterministic manifest check and all three
planning tests pass. No semantic rule, real label, model run or efficacy result was
produced.
