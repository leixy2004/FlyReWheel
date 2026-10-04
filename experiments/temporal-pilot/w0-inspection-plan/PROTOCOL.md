# Remaining W0 inspection plan v1

This is a prospective development screening plan frozen after three exploratory
cases, not a preregistration of the original capture or an efficacy study. Base:
`e410339414f42292f14f938d877a58308e997c25`. No acquisition is authorized by this
file. The committed manifest and protocol must be pushed and their remote commit
recorded before any further source inspection. No new source, W1/W2 content,
models, human recruitment or real labels were used to prepare this plan.

## Cohort and order

Use the existing 70-row metadata frame; W0 is mergedAt >= 2024-01-01T00:00:00Z
and < 2024-04-01T00:00:00Z. All 38 W0 PRs remain in the denominator. Sort by
mergedAt ascending, breaking ties by numeric PR number. No titles, labels,
comments, diffs, apparent fix type, predicted rule yield or later results rank
cases. The first three (3035, 3031, 3036) remain exposed and rejected for current
semantic admission owing to insufficient retained evidence, not proven devoid of
useful rules. The remaining 35 are pending, not zero-yield or negative examples.
Their non-exposure is a declaration about this planning task, not an independently
verified claim about every collaborator or model pretraining.

After separately authorized acquisition, inspect pending cases serially in this
order. Process the entire remaining roster within the frozen limits, regardless
of whether the first useful rule appears early or none appears. No quota of
successful rules, substitutions, favorable-case oversampling or early stop on
success. Resource monitoring occurs after each case and cannot use rule yield.
A W0 supported rule is provisional for later episode admission: absence of W1
feedback or W2 opportunities does not by itself reject W0 source eligibility.
Do not inspect W1 to decide whether to keep, refine or replace a W0 rule.

## Required public evidence and admission

Reuse [source-package requirements](../w0-first-three/source-package-requirements.json)
and the existing collector/identity validator without weakening their checks.
For each PR, retain an original acquisition receipt with actual capture time,
request URL/ref, response status and bytes digest; frame merge commit, parents and
tree must match. Obtain distinct baseTip, mergeBase and head commits/root trees,
with pinned tree membership and original LICENSE/LICENCE/COPYING bytes plus blob
SHA1 and SHA256. Never substitute mergeBase for baseTip or equate merge time with
review-time visibility. Preserve file statuses/renames and exact before/after
changed-file bytes or explicit absence, diff completeness and truncation flags.
Any failed identity, license or completeness check leaves the case unadmitted.
Current titles, bodies and discussion returned incidentally by the collector stay
quarantined as provenance only. They do not rank cases or establish historical
contracts, feedback or semantic eligibility; a current success narrative cannot
admit a rule. Do not separately request discussion or outcome endpoints.

The common source allowlist is changed paths at the pinned mergeBase/head plus directly
referenced local contracts, callers/callees, tests, configuration and dependency
locks needed to resolve a specific semantic premise. Before each context request,
record the unresolved premise and exact path/ref; traversal is one dependency edge
from a changed path, no whole-repository search or archive. Obtain both relevant
sides where behavior differs. A dependency/action/tool whose behavior is decisive
requires its exact-version public contract or implementation and a reproducible
behavior witness. External repositories, unpinned documentation, build images and
package downloads are outside this proposal: record that evidence as missing and
stop that case at unresolved. A version bump or passing linter is not a defect.

A supported W0 rule needs source-bound scope/applicability, substantive invariant,
exception boundary, exact issue anchors and a supported defect-to-repair argument
or independent contract evidence. Record invalidation/control/data-flow context
and alternative explanations. Where execution is necessary but unavailable,
retain unresolved; this plan authorizes no behavior execution. Freeze the rule
text/digest, evidence packet and complete attempt roster before W1 exposure.
Use the existing [screening, framePR and constructionAttempt records](../../../paper/experiment-protocol/record.schema.json)
and [guarded-family admission criteria](../../annotation/GUARDED-FAMILY-v1.md).
The manifest's screening objects use the existing screening shape; they are not
complete study records. No new framework or fictional construction events.

Current-capture development is primary. Keep capture, experimental freeze,
exposure and judgment times distinct; historical as-of claims require additional
visibility evidence and are not inferred here. Later annotation must reuse the
[source-only protocol](../w0-first-three/evaluation-preparation/ANNOTATION-TEMPORAL-PROTOCOL.md):
common source/rubric bytes, two independently locked raters and separate
adjudication, retaining Unknown/disputed/missing distinctions. Exposed assistants
are not independent blinded human raters. Context changes require a new common
packet and independent restart, preserving old locks. Actual finding correctness,
W1 common feedback, W2 independent lineages, legal-neighbor subtype and mechanism
membership remain separate future gates; this plan creates none of them.

## Proposed acquisition limits, not an execution permission

For the 35 pending PRs only: at most 30 GET requests per PR and 1,050 total;
2 MiB decoded response bytes per request, 20 MiB per PR, 350 MiB cumulative decoded response bytes
received (also a ceiling on retained raw evidence), and 60 seconds per request. Stop reading at the byte cap, mark
truncated evidence unusable, and count bytes already received. These conservative
caps can leave many cases unresolved; they are not a completeness guarantee.
Count identity, license, pagination and context requests, failures and redirects
against both budgets. Failed, truncated, discarded and duplicate bytes still count;
deleting files never restores the budget. No retries or automatic redirects, alternate transports,
credential changes or permission escalation. Reused exact pinned artifacts consume
zero new requests but retain their provenance/exposure. Requests spent on the
already inspected three are historical, not retroactively charged or recaptured.

Record each attempt's case/order, purpose, URL/ref, timestamp, status, byte count,
receipt digest and cumulative counters. Missing or ambiguous accounting pauses
all work. A per-case cap or unavailable necessary artifact closes the case as
unresolved/budget_exhausted, preserving it, then proceeds to the next fixed case
only if authorized and global limits remain. Any access/approval denial stops
acquisition globally with access_blocked; do not retry a denied action. Global
request/byte exhaustion stops all further requests; remaining rows are explicitly
not attempted due to that limit. All 38 rows stay visible. No budget transfer can
raise a per-case cap. No downloaded executable is run.

Continue only while permissions, scope, identity integrity and accounting remain
valid and both limits permit the next request. Unexpected W1/W2/outcome exposure,
identity mismatch, unsafe endpoint or scope ambiguity pauses the study for audit;
quarantine accidental bytes and record deviations without using them for selection.
At completion or any global stop, freeze the ledger and all supported/provisional/
no-rule/failed/not-run attempts. Report attempted/completed/missing/rejected counts
against 38, never label unassessed cases as safe or Unknown judgments. A change in
scope/budget/order requires a new version with actual timing and prior exposure
and does not erase this prefix; this plan never automatically continues into W1.

## Missingness ledger and reproduction

`manifest.json` preserves all metadata identities and the three prior admission
rows. Pending rows have missing source/contract evidence, no label and no
construction result. Update screening status using existing enum values: pending,
eligible, ineligible, unresolved, budget_exhausted, access_blocked; append reasons,
missing artifacts, actual exposure/attempt times, receipts and prior versions.
A no-rule conclusion after completed inspection differs from inaccessible source.
Prior rejections are unresolved insufficient-evidence decisions, not semantic
negative labels. Any later reconsideration must retain that original decision.

Offline regeneration/check (no network, no source packages, no dependencies):

```sh
node scripts/freeze-w0-inspection-plan.mjs --check
node --test tests/w0-inspection-plan.test.mjs
```

Run without `--check` only to regenerate the planning manifest from the pinned
metadata, prior admission report and this protocol. It never edits an operational
ledger. A changed input hash or roster fails instead of silently selecting again.
Remaining needs: authorize a bounded acquisition separately, provide permitted
exact pinned semantic context, audit exposure and provenance, establish W0 rules,
and later independently approve feedback/annotation/evaluation stages. No real
family, label, effect, human participant or model run is claimed by this plan.
