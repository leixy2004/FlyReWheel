# HTTPX temporal metadata frame

## Selection frozen before acquisition

Recorded 2026-10-03, before the first acquisition request for this frame.
Repository: `encode/httpx`. Selection rationale: a publicly accessible Python HTTP
client with a bounded scope suitable for later human annotation. Selection is not
based on known favorable review outcomes. Existing vLLM development cases and
fixtures are not included. The JSON `frozenBeforeAcquisition` flag records the
collector's declaration of this ordering; these files provide no independent
pre-acquisition timestamp or external preregistration evidence.

The complete frame consists of all merged pull requests whose GitHub-reported
`mergedAt` falls in the UTC interval 2024-01-01T00:00:00Z through
2024-09-30T23:59:59Z. No filtering by author, changed path, title, label, outcome,
issue linkage, or apparent rule opportunity is permitted.

| Window | UTC interval | Intended later role |
| --- | --- | --- |
| W0 | 2024-01-01 through 2024-03-31 | Rule construction |
| W1 | 2024-04-01 through 2024-06-30 | Experimental feedback, independently adjudicated |
| W2 | 2024-07-01 through 2024-09-30 | Independent future evaluation |

These roles are proposed uses of a metadata inventory. Chronological membership
does not establish rule availability, lineage independence, or eligibility.

## Acquisition rules and reproducibility

Run `node scripts/capture-temporal-frame.mjs` from the repository root. The script
uses the already-connected `gh` CLI and the official `api.github.com` GraphQL read
API; it does not change authentication or print token values. Its fixed search is:

```
repo:encode/httpx is:pr is:merged merged:2024-01-01..2024-09-30 sort:created-asc
```

GraphQL selects only the PR number, merge timestamp, and merge commit SHA, parent
SHAs and tree SHA, plus pagination/count fields. It does not request PR titles,
bodies, comments, labels, diffs, source files or model outputs. All pages are
retained in the count audit. Results must match the reported total, have unique
PR numbers, valid UTC-window membership and full parent lists. The script rejects
search totals beyond GitHub's 1,000-result search ceiling, changed total counts,
missing merge metadata, or incomplete pagination instead of calling a partial
frame complete. A failed run records its bounded metadata progress and failure
class. Zero-yield windows remain explicitly counted. Acquisition has a maximum
of 10 API requests and 60 seconds per request; no retry or alternate credential
route is attempted on an API failure.

The JSON output contains exact query, script hash, acquisition timestamps, page
counts and selected identifiers. Commit/tree identifiers are GitHub-declared
metadata, not a locally verified clone or a historical public-visibility proof.
A rerun overwrites the output with a newly timestamped observation; preserve the
original version in Git before deciding to rerun.

## Independent W0 commit identity lookup

`node scripts/verify-temporal-source-identities.mjs` checks all 38 W0 merge commit
objects through a separate official GitHub GraphQL lookup. The verifier pins the
original frame SHA256 and queries only commit OID, tree OID, and complete ordered
parent OIDs, in at most four requests of ten commits each. It does not query W1
or W2 objects, PR content, source files, discussions, or labels. It uses existing
`gh` authentication, with no retries or credential changes.

`source-identity-verification.json` records the exact queries, timestamps, script
and frame hashes, expected and observed identities, and all selected members,
including failures or members not checked. The recorded run matched all 38 W0
identities in four requests. This independently checks lookup consistency within
GitHub's metadata, not local Git object integrity, historical public availability,
source eligibility, or experimental efficacy. A rerun overwrites this evidence;
preserve the recorded result in Git first.

## Boundaries and next gates

This freezes a metadata sampling frame only, not the complete pilot or a research
preregistration. Human annotators are unassigned. Reviewer/revision models,
research budgets, annotation protocol assignments, lineage audits and source
availability cutoffs are not configured or executed. There are no TP/FP labels,
review judgments, generated rules or efficacy estimates. Every frame member,
including future zero-yield, failed and unknown samples, must remain accounted
for when later acquisition and annotation are separately undertaken. W0 rules
must be frozen before opening W1 labels; W2 source/labels must not become rule
construction or feedback inputs.
