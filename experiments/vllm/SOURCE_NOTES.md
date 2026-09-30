# vLLM historical bugfix case inputs

Five real merged fixes from the public `vllm-project/vllm` repository support a low-cost static candidate replay and a later semantic-verification experiment. Selection performed on 2026-09-30. No issues, comments, pull requests, commits, or other material were published upstream.

## What is included

- `cases.json`: machine-readable case metadata, immutable source URLs and commit/blob IDs, complete changed-path lists, suggested Python AST patterns, expected candidate counts, bounded semantic input scenarios, and per-case limitations
- `fixtures/pr-N/before/` and `fixtures/pr-N/after/`: full, unchanged selected upstream Python files at the squash commit's first parent and the squash commit itself
- `fixtures/pr-N/LICENSE`: unchanged Apache-2.0 license copied from that exact fixed commit; upstream source headers and notices are preserved
- `evidence/`: compact immutable commit metadata and complete patches, PR summaries, relevant upstream test source, issue summaries, and byte-integrity verification

The original PR base/head refs are also retained in the manifest. They are not substituted for production before/after snapshots: several PR bases differ from the actual merge parent.

## Cases and supported expectations

1. [PR #2570](https://github.com/vllm-project/vllm/pull/2570), merged 2024-01-24: optional `max_tokens=None` reached an unguarded numeric comparison. Added `is not None` guard. An upstream direct unit test and GPU regression test are retained as evidence
2. [PR #2664](https://github.com/vllm-project/vllm/pull/2664), merged 2024-01-30: Ray engine encoding used a direct actor method call. Added a Ray `.remote()` branch while preserving the ordinary direct call in `else`. The PR provides a concrete error report; it adds no tests
3. [PR #8568](https://github.com/vllm-project/vllm/pull/8568), merged 2024-09-26: a present `tools` key with a null or empty value incorrectly activated automatic tool choice. Changed key-presence checking to a value check. Direct upstream tests cover absent/null/empty tools and explicit invalid choice
4. [PR #9034](https://github.com/vllm-project/vllm/pull/9034), merged 2024-10-15: a zero count in `[-num_new_tokens:]` returned the entire cache because negative zero is zero. Added an earlier zero-count return. The selected method is only one part of the four-file serving fix; the GPU streaming integration test is evidence for the broader regression
5. [PR #14352](https://github.com/vllm-project/vllm/pull/14352), merged 2025-03-18: serializing and revalidating a request exposed default `top_logprobs=0`, which incorrectly required `logprobs=true`. Added a positive-count condition. [Issue #14351](https://github.com/vllm-project/vllm/issues/14351) provides a minimal reproduction; the PR adds no tests

The proposed AST patterns have expected before/after counts of `1/0`, `1/1`, `1/0`, `1/1`, and `1/0` respectively. A separate adapter worker verified those counts over all ten full source snapshots with the actual Python AST scanner, with no parse failures. The root experiment's replay output remains the authoritative reproducible execution record.

The two persistent post-fix candidates are intentional. An isolated call or slice still looks suspicious, while its surrounding branch/guard makes it safe in the documented scenario. Static matching alone must not classify those candidates as bugs. No alternative pattern was substituted merely to force a post-fix zero.

## Integrity, scope, and limitations

All ten selected source files and five exact license copies match GitHub's Git blob SHA-1, with SHA-256 also recorded in `evidence/source-integrity.json`. Their combined size is 424,862 bytes; the largest source file is 60,903 bytes. Each is well below the 1 MiB per-file bound. The root directory at every selected fixed commit contained `LICENSE` and no separate `NOTICE`/`COPYING`/`COPYRIGHT` file.

Case selection only read and parsed source. No vLLM package was imported, and no repository script, upstream test, Ray actor, model, or GPU workload was executed. The JSON semantic inputs are bounded hand-authored scenarios supported by the actual source and upstream reports/tests; they are not independent runtime ground truth. Executing them later requires an explicitly isolated local harness and careful disclosure of mocking/extraction limitations.

All five fixes and labels were inspected to design their own patterns. These are retrospective seed regression replays. Neither a later date nor a different fix turns a seed's own before/after pair into heldout generalization. `cases.json` records a possible future chronological partition, clearly inactive; a fresh hidden corpus is preferable. Keep PRs #8568 and #14352 in the same conservative lineage group because both change the same ChatCompletionRequest source file. Do not tune a rule against a heldout case and continue calling it heldout.

Public source provenance was acquired through read-only official GitHub connector calls and GitHub REST. Commit evidence was minimized to SHAs, dates, titles, file identities and patches; unrelated profile fields, emails, and signatures were omitted.
