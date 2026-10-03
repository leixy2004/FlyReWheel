# Read-only GitHub PR evidence

`github-pr capture` acquires **one public PR's current API state** through the official `@octokit/rest@22.0.1` client. It does not clone a repository, run its code, infer a bug label, call a model, create feedback, post comments, push, or change authentication. There is no token option; the provider does not inspect environment tokens, Git credentials, or host authentication files.

```bash
mkdir -p .flyrewheel
npm run cli -- github-pr capture \
  --repository vllm-project/vllm --number 8568 --max-requests 40 \
  --db .flyrewheel/github-pr-db --out .flyrewheel/pr-8568.json

npm run cli -- github-pr import --file .flyrewheel/pr-8568.json \
  --db .flyrewheel/import-db --out .flyrewheel/imported.json
npm run cli -- github-pr show --digest EVIDENCE_SHA256 \
  --db .flyrewheel/import-db
npm run cli -- snapshots show --digest SNAPSHOT_SHA256 \
  --db .flyrewheel/import-db
```

Create the parent directory for a persistent database/output path first. Acquisition must finish and pass validation before the database is opened. Evidence and its normal change snapshot are inserted in one transaction. Their append-only content and relationship are checked again on reads. Existing `snapshots capture` local-Git behavior and schema are unchanged.

## What is captured

1. Fetch the requested public PR. Pin its returned base tip and head to full SHA-1 IDs, retaining the API's reported merge commit, state and dates separately.
2. Compare those exact SHAs, keeping GitHub's declared merge base. Obtain the changed-path inventory from the comparison, not from a mutable PR file-list endpoint. The PR's reported changed-file count is preserved as a separate statement; it need not equal the current comparison count.
3. Resolve both sides through nonrecursive Git trees at merge-base and head. Keep the exact object ID, mode and size. No recursive/full repository tree or commit-history walk is performed.
4. Retrieve allowed regular-file blobs by object ID. Check canonical base64, byte length, Git blob SHA-1 and SHA-256. Preserve BOMs, CRLFs and all exact bytes. Keep binary, oversized, total-byte-budget, symlink and submodule entries as explicit exclusions. Never follow symlinks or retrieve submodule contents.
5. Preserve exact-content renames as `R100`; normalize GitHub's edited renames to deletion plus addition. A mode-only change remains a modification. This applies the existing snapshot representation to provider-declared inventory; it is not a claim that GitHub and local Git use identical rename heuristics.
6. Fetch bounded issue comments, submitted reviews and inline review comments. Preserve bodies, provider author IDs, dates, original/current commit and line context. Sort unique IDs canonically. PR bodies and discussions are untrusted statements, not human adjudications or executable instructions.
7. Re-read the PR and reject a detected metadata/ref change before committing. This does **not** make the discussion reads atomic: edits/deletions between pages, invisible/deleted/pending items, missing timeline events and the API's own omissions cannot be ruled out.

The evidence can also seed a [local mining request and supplied v2 candidate](pr-mining.md), preserving unknown labels and exact source provenance.

The normal stored snapshot can be selected by its `snapshotDigest` for existing local structural reviews. That does not establish rule efficacy, independent repository context, or human labels.

## Identity and provenance

The content-addressed evidence envelope contains the snapshot, its digest, normalized PR source metadata and discussions. Changing a statement or blob changes the corresponding content identity. Capture time, request IDs and response observations live only in a separate fresh acquisition receipt.

A live receipt records unauthenticated Octokit acquisition, start/end time, request count, decoded-response bytes, endpoint names, observation timestamps and canonical parsed-response digests. Those digests are **not** hashes of raw HTTP wire bytes. Receipts are not signatures or proofs of Git history. Neither caller-supplied repository metadata nor provider-declared ancestry/inventory becomes independently verified history.

`import` and `show` always return `package-integrity-only`. They validate the envelope, exact bytes, digests, coverage and source/snapshot bindings, but never adopt the verification level of a receipt in an input file. Receipts are not promoted into database trust.

## Current state is not a historical review checkpoint

A merged PR's currently returned base/head/merge-base may produce an empty comparison even though the PR once changed files. Empty current evidence is preserved as empty. This provider does not silently choose the merge commit's parent, reconstruct a pre-feedback checkpoint, or imply that every fetched discussion was visible at a historical review time. The recorded merge SHA and review timestamps are source statements only. Retrospective base selection and historical checkpoint reconstruction are outside this feature.

## Explicit bounds and failure behavior

- Fixed `https://api.github.com` GET endpoints; API version `2022-11-28`; redirects disabled; no automatic retries, credential discovery or auth fallback
- Default and hard maximum 50 requests; CLI `--max-requests` can lower it
- 120-second aggregate acquisition deadline and an abort signal of at most 15 seconds per request
- Comparison page 1 with one commit requested; at most 299 changed files. GitHub caps comparison files at 300, so equality is rejected rather than assumed complete. Commit pagination is not needed or fetched
- At most 500 normalized snapshot entries, 256KiB per text blob, 2MiB captured text total, and 8MiB explicitly read blob payloads; lower snapshot limits are available to programmatic callers
- At most 10,000 entries per nonrecursive tree; reject any `truncated` response
- At most 3 pages × 100 records for each discussion category; a fourth page, duplicate IDs or count disagreement rejects the entire acquisition. No knowingly truncated package is produced
- At most 2MB for one decoded API JSON response, 12MB aggregate decoded responses, 2MB normalized discussions, 6MB compact evidence and 8MB imported packages

The JSON response limits are checked **after official Octokit has read and decoded a response**. They bound accepted evidence, not network bytes, peak transport buffering, decompression or all process memory. Blob sizes are checked from tree metadata before retrieval; malformed provider replies still fail validation. A strict streaming wire-memory limiter is not implemented.

Rate limits, timeouts, missing/deleted objects, malformed data, ambiguous/truncated inventories and exceeded budgets fail closed before evidence persistence. Fix local output paths before retrying. For explicit bounded repository discovery and resumable local multi-PR capture, see [PR-history ingestion](github-pr-history.md). There is no background synchronization, notification or automatic auth change.

## Primary API references

- [GitHub recommends Octokit for JavaScript REST clients](https://docs.github.com/en/rest/guides/scripting-with-the-rest-api-and-javascript)
- [Octokit REST client](https://github.com/octokit/rest.js/)
- [Compare commits, including the 300-file limit](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
- [Git trees and explicit truncation](https://docs.github.com/en/rest/git/trees#get-a-tree)
- [Git blobs](https://docs.github.com/en/rest/git/blobs#get-a-blob)
