# Actual W0 capture through the existing environment proxy

Published plan: `e982c18d04fba192a9a5b0946c2565490128f9a2`, before this attempt.
Execution used Node's official process-local `--use-env-proxy` switch, the
unchanged environment-provided proxy/NO_PROXY settings, anonymous official
Octokit, and unchanged TLS validation. No new proxy, credential, OS networking,
trust-store configuration, retries or direct fallback were introduced.

The fixed #3035 diagnostic returned HTTP 200 with the frozen mergedAt and merge
commit identity. The gate then allowed the original chronological selection:

| PR | Capture GETs | Changed paths | Captured source sides | Excluded sides |
| --- | ---: | ---: | ---: | ---: |
| 3035 | 13 | 1 | 2 | 0 |
| 3031 | 13 | 1 | 2 | 0 |
| 3036 | 19 | 2 | 4 | 0 |

Accounting: original failures 2 + new diagnostic 1 + capture 45 = **48/50 GETs**.
The remaining two requests were not used. All commit, tree, blob, license and
current PR/discussion reads are represented in the package receipts. The
collector's compact accepted-package byte count is 151,890; the pretty-printed
artifact sizes and SHA-256 values are separately recorded in artifact-manifest.json.

The three package files are actual API observations, not authored fixtures.
Each retains before/after changed-path bytes, provider-declared identities,
nonrecursive source-tree responses, pinned-head license content, and observation
hashes. LICENSE.httpx.md preserves the identical 1508-byte license included in all
three packages. The artifact manifest links each PR and pinned license source.
Retain these notices and provenance with any authorized copies.

These are user-requested research evidence on an isolated review branch and remain
quarantined from rule construction and evaluation. The automated validator's
publicationAllowed/redistribution fields deliberately grant no release permission.
They are not an assertion that merely saving this requested evidence is a license
interpretation. Current discussion is not a historical W0 checkpoint; temporal
source availability, lineage independence and semantic eligibility remain unknown.
There are **zero human labels, zero mined rules, zero model calls and no measured
review effectiveness**. Successful data capture does not establish those outcomes.

Offline package validation passed for all three. Independent native agents checked
identities, tree/path relationships, request accounting, and license/source blob
hashes using git hash-object. offline-validation.json records reproducible
validator output. No W1/W2 PR content or unselected PR endpoint was requested.
The two previous failed-run records remain unchanged in the parent directory.

The proxy-enabled attempt succeeded, but this does not prove that client proxy
configuration was the sole cause of either earlier failure.
