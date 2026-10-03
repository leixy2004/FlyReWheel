# Next integration candidate: W0 preparation

This independent draft branch starts at the frozen, validated PR #16 head
`0471c0b2e69c187c7907a9d1ade396b310cb6f3d`. It does not change that head, its draft
state, or public main. Any change to PR #16 readiness or main remains outside
this integration work pending the user's separately requested approval.

## Fixed inputs

| Input | Exact commit | Scope |
| --- | --- | --- |
| PR #16 | `0471c0b2e69c187c7907a9d1ade396b310cb6f3d` | Earlier integrated baseline |
| PR #14 | `528d4bb1d21aaa6588bf9b88c6ecc2e761724c2f` | Bounded source provenance producer |
| PR #17 | `04155f2d4fafa7063e55caedaa3f2353b85fc268` | Three real W0 source packages and acquisition audit |
| PR #18 | `f02c9c483abd79533b29e52f41aca51f979c1320` | Offline import and mining-request preparation; includes #14/#17 ancestry |
| Plan checker entrypoint fix | `e777ec0302ec960b5aa552ececf1855ac41e8672` | Independently reviewed alias-launch fix |
| PR #9 update | `8c98a48acdbddfa393107d95497f48715f118359` | Runtime diagnostics, OCI metadata and permission planning |

Original task branches are not rebased or edited. Later full-repository W0 context
work and newer task heads are excluded until explicitly added. The small plan
checker entrypoint fix is reviewed and recorded separately in this branch's merge
history and draft PR; it changes entrypoint recognition, not plan authorization.

## Stage-specific evidence

The original first acquisition failed and yielded zero packets. That historical
record remains intact. The later PR #17 attempt produced **three real source
packages**, using 45 GETs plus three earlier requests: **48/50 cumulative**.
This integration performs no new acquisition requests. Source packages cover
selected changed paths with pinned identity and license evidence; they do not
prove complete repository context or historical discussion visibility. Current
API statements remain untrusted metadata, not historical W0 labels. W1/W2 source
contents are outside this work.

PR #18 uses existing import, mining request and prompt-builder APIs offline.
Integration reproduction in a fresh PGlite store persisted three evidence objects,
three pending requests and eight unknown cases, with zero candidate/rule/feedback
rows. It closed and reopened the store and reproduced all ten committed JSON
exports byte-for-byte. An additional negative run with a new output path and an
existing database rejected with EEXIST; all 1,148 existing database-file hashes
were unchanged. A new empty output directory may remain on this rejected path,
as documented for failed preparation. PGlite is not real PostgreSQL.

Templates explicitly have model=null and executable=false. No model mining,
human labels or evaluation result follows from preparing them. Semantic
eligibility and full repository context remain unresolved; the fixed samples are
not replaced because their apparent defect-rule yield is low.

Runtime evidence records two model-capable CLI invocations failing before any
model turn, followed by initialization diagnostics. Earlier per-attempt headings
are historical; they do not reduce the cumulative invocation count to one.
OCI metadata sizes and planning results are not a pulled image, running service,
successful inference or deployment. This integration does not invoke the model,
change authentication/network/security settings, or execute a permission plan.

## Verification and remaining limits

Typecheck and build passed after the fixed inputs merged without conflict.
Eight related local test files passed (171 cases), covering collector diagnostics,
W0 package/receipt validation, offline preparation and the local plan checker.
After the entrypoint fix, all 14 plan-checker tests also passed locally, including
authored loopback TCP negative tests (not a live sandbox health check). The frozen candidate's full hosted CI result
are recorded with exact SHA/tree in the draft PR, rather than borrowed from an
older head. No redundant local full suite is launched while hosted CI validates
this candidate.

The earlier PG head's 1571-pass/2-fail result and PR #16's local/hosted
1658-pass result remain distinct historical records. Neither is relabeled as
verification of this next candidate. Independent static reviews found no blocking
identity, W0 leakage or interface issue. One nonblocking preparation cleanup risk
remains: database initialization occurs before its try/finally cleanup region;
initialization failure may leave a resource to process teardown. No such failure
occurred in the successful reproduction.
