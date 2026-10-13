# Real vLLM PR input compatibility for mining preparation

Verified product code: `7fae21e57ad0a592befd635df237d9ac5e29e856`. This commit archives evidence only. No product compatibility defect was found and no product code was changed.

The official [commit-to-PR API](https://api.github.com/repos/vllm-project/vllm/commits/953d9c820b0d8f9a55ee455814287536a498498c/pulls) returned one association, without a next-page link: [vLLM PR #29666](https://github.com/vllm-project/vllm/pull/29666), merged at `2025-11-28T12:40:47Z`, with merge commit `953d9c820b0d8f9a55ee455814287536a498498c`.

This PR's captured base/merge-base is `3cb32e5d6e227fe91d93902e302ef6f667308e04` and head is `72c2b149c376ad6020c3f9022493e75d4a7adc35`. They differ from the previous direct-parent commit pair. The package came from the existing GitHub PR collector and actual public responses; no commit diff was repackaged as PR evidence.

## Acquisition result and transport limitation

The compiled `github-pr capture` command failed twice on its first GET: once with an isolated environment and once with Node's `--use-env-proxy` using existing routing configuration. Octokit logged status 500 and request ID UNKNOWN. Those logs do not establish that GitHub itself returned HTTP 500; the underlying Node transport cause was not diagnosed. Neither failure created evidence or a database.

The same existing `captureGithubPrEvidence` collector then succeeded through its existing injectable fetch interface backed by **live Python urllib public GETs**, using the existing environment proxy route. These were real HTTP responses, not fixtures or a replay. No authentication, credential fallback, new permissions, protocol changes or collector gate changes were introduced. The receipt's Octokit transport label identifies the collector client; the actual HTTP transport for this run was the Python bridge, not native Node fetch.

Acquisition completed at `2026-10-13T10:27:10.776Z`: 40 collector GETs, 9 changed paths, 18 captured sides, 131,744 bytes and zero excluded sides. Discussions comprised 1 issue comment, 8 reviews and 7 review comments. Existing pagination logic completed all three discussion streams within its limits; final PR metadata matched the initial observation. There were no missing/excluded changed sides. This is a non-atomic current API observation with provider-declared ancestry/inventory, not proof of historical availability or complete repository history.

## Compiled CLI verification

Seven successful CLI processes exercised import, choices, prepare, list-before-freeze, existing request freeze, separate-process show, and empty candidate list. Preparation did not persist a request. Reopened frozen JSON exactly matched the original frozen request.

The explicit source selection was before/after `vllm/utils/async_utils.py`; statement selection was the PR and [review comment 2571154566](https://github.com/vllm-project/vllm/pull/29666#discussion_r2571154566). Source commit bindings, Git blob SHA-1 and content SHA256 were checked against the captured bytes. Statement digests were recomputed from the actual captured PR/comment records. The requested rule identity and investigation objective were authored for this compatibility check; comments remain untrusted source statements, not labels or real feedback submitted to FlyReWheel.

- Evidence digest: `da82756031a6e8e92a2730305f5373878437df049754cb401151fa32b6349110`
- Request digest: `db84efa156d26b4f943749da496a8f6ce2fc2075ed655fd5466afae7fe1429bf`
- Inventory: all 18 sides and 17 statement choices exposed.
- Request state: `pending`; synthesis: `not_run`; no candidate created.

The [structured record](vllm-pr-29666-mining-preparation-2026-10-13.json) retains the full authored request and frozen bindings, acquisition receipt, all public endpoint observations, CLI argv/output hashes and failed native capture diagnostics. Source blobs, full response bodies and databases are intentionally not committed. All raw artifacts remain in the local validation output directory; the archive does not claim they are checked into the repository.

## Reproduction

From the repository root, build if necessary, then use the archived [live collector helper](vllm-pr-live-capture.mjs) and [public transport helper](vllm-pr-public-fetch.py):

```sh
node docs/evidence/vllm-pr-live-capture.mjs "$NEW_OUTPUT_DIRECTORY"
node dist/cli.js github-pr import --file "$NEW_OUTPUT_DIRECTORY/evidence.json" --db "$LOCAL_DB"
node dist/cli.js mining choices --evidence-digest "$EVIDENCE_DIGEST" --db "$LOCAL_DB"
node dist/cli.js mining prepare --evidence-digest "$EVIDENCE_DIGEST" --db "$LOCAL_DB" \
  --id vllm-29666-real-input --rule-id vllm-async-typing-investigation --rule-version draft-1 \
  --objective 'Investigate whether the selected async utility typing changes and review discussion support a reusable rule; preserve uncertainty and do not treat comments as labels.' \
  --actor local-compatibility-validation --source supplied --created-at 2026-10-13T00:00:00Z \
  --before vllm/utils/async_utils.py --after vllm/utils/async_utils.py \
  --statement pull review-comment:2571154566 --out "$REQUEST_FILE"
node dist/cli.js mining request --file "$REQUEST_FILE" --db "$LOCAL_DB"
node dist/cli.js mining show --digest "$REQUEST_DIGEST" --db "$LOCAL_DB"
```

Set variables explicitly; use the evidence/request digests returned by that run. The output directory must not already exist. The helper makes bounded unauthenticated real requests for this one PR only and records every response hash. It preserves the collector's limits and rejects redirects. GitHub metadata can change, so future capture digests may differ. These archived helpers were path-normalized for portability and syntax-checked; the actual acquisition used their equivalent local paths. They are not a new product transport capability.

The requested endpoint—one real PR request-preparation compatibility verification—is complete. Native Node public acquisition remains an environment-specific limitation. No model was called, no rule was mined or activated, no vLLM code was executed, and no production readiness or semantic quality is claimed. No push, deployment, credential reads, W1 data access or frozen research changes occurred. Existing code tests were not rerun because product code was unchanged.
