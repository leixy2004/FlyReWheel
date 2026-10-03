# W0 source producer and diagnostic boundary

`captureGithubPrEvidence` now accepts `includeSourceProvenance: true`. It reuses
the existing anonymous Octokit client, read helper, shared request allowance,
response-byte limits and deadline. The default mode keeps the original return
shape and request behavior. No credential, proxy, TLS or transport policy is changed.

Provenance mode retains the existing merge-base/head commit responses and adds a
baseTip commit metadata request if needed. BaseTip is explicitly current-tip
metadata, not a source input. It retains every nonrecursive tree actually read
for changed paths, finds a single root LICENSE/LICENCE/COPYING candidate at the
pinned head, then reads that file through the same API client. All added GETs,
including failed requests, consume the same budget. Multiple candidate licenses,
missing files, symlinks, excessive sizes, invalid text, or hash/size/tree mismatch
fail the entire package; no guessed license or partial success is returned.

The W0 runner enables provenance mode, verifies the frozen merge identity before
source acquisition, and checks the returned request count against the actual
shared allowance consumed. Its strict validator links API observations to the
receipt, requires retained subtrees to be reachable from comparison roots, and
binds each captured or absent change side to its tree path. Successful packages
remain quarantined; verified license bytes do not establish license interpretation,
historical rights, human labels, rule mining or permission to publish.

Reproduce the offline verification with existing installed dependencies:

```sh
npx vitest run tests/github-pr.test.ts tests/github-pr-diagnostics.test.ts tests/github-pr-failure-classification.test.ts tests/w0-first-three.test.ts tests/w0-source-package.test.ts --maxWorkers=2
npx tsc --noEmit
```

All mocked HTTP bodies and live-shaped consistency fixtures are authored test
data. One integration test runs the actual collector with mocked HTTP responses
through the complete W0 runner and validator; it performs no network requests.

## Recorded real failure

The unchanged run in `experiments/temporal-pilot/w0-first-three/capture-run/run.json`
contains exactly one attempt: anonymous REST GET
`https://api.github.com/repos/encode/httpx/pulls/3035`.
The saved class is `GITHUB_READ_FAILED`. HTTP status, request ID, retry-after and
rate-limit response fields are absent. The Octokit console's 500/UNKNOWN can be an
SDK transport-error wrapper; it is not an observed HTTP 500. The earlier gh 401
was a different operation and cannot explain this anonymous request.

The old collector deliberately discarded the raw cause. TLS, DNS, connection,
API rejection and authentication cannot be distinguished retrospectively from
that saved record. No new upstream request or route substitution was attempted
while implementing this producer; real source-package count remains zero.

Future authorized failures now retain only a small fixed classification and
allowlisted error code. A real HTTP response is required for HTTP classifications.
Transport classification inspects at most three own data-property code/cause
links, emits no raw messages, URLs, headers, bodies or nested error objects, and
never triggers retries. Unknown codes stay `transport-unknown`.

## Input needed before another real attempt

Provide the original environment/network diagnostic for that request, specifically
a sanitized underlying error code or evidence of an HTTP response. The current
artifact cannot supply it. If no original diagnostic exists, a new diagnostic
request would require explicit authorization to perform one bounded GET using the
same instrumented anonymous transport; it has not been authorized or run here.
Do not switch to gh-authenticated reads or another route after this failure.

The existing CLI refuses to overwrite the saved capture-run directory. Any later
authorized run must preserve this record and use an explicitly agreed new output
location/attempt record. Neither a diagnostic authorization nor this producer PR
unfreezes W1/W2 content access.
