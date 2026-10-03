# First three chronological W0 PRs

The selection is fixed before source acquisition: HTTPX PRs 3035, 3031, 3036,
ordered by the existing frame's mergedAt timestamp and then PR number. No title,
change, bug category or review outcome was used for selection.

The plan commit is `4f8921b94682c1c497d7340cabd8f8e1fe7d6a82`. Its initial push
failed when the saved cloud GitHub connection returned HTTP 401. A later, single
read-only recheck of that same connection succeeded. The plan was then pushed
and its remote branch fetched before the first upstream request. This ordering
is a recorded operational sequence, not independent research preregistration.

## Latest bounded attempt

The existing environment proxy was enabled only for the Node process after its
plan was published. Diagnostic HTTP 200 unlocked the fixed three-PR capture;
all three packages passed offline and independent native-agent audits. Total
upstream usage is 48/50 GETs. See `proxy-attempt-1/README.md` and its manifest.
These packages remain quarantined, with no labels or rule-mining result.

## Earlier failed acquisition (preserved)

`capture-run/run.json` records one attempted GET:
`GET /repos/encode/httpx/pulls/3035`. It failed with `GITHUB_READ_FAILED`; no
validated HTTP response diagnostic was retained. Octokit's console reported
500/UNKNOWN, which does not establish an actual server HTTP 500 response.
The entire run stopped. PRs 3031 and 3036 remain unattempted, accepted evidence
bytes are zero, and there are no source, discussion, license or model packages.
There was no retry, credential change, alternate transport or fallback route.
`status.json` retains both the initial authentication blocker and the later result.

## Offline tooling

The capture adapter reuses `captureGithubPrEvidence`. The batch shares at most
50 GET attempts and 300 seconds; any failure stops without replacing PRs.
The collector's existing per-request and per-PR limits still apply. The CLI
requires the published plan's SHA and checks local remote-tracking history;
this is not live remote attestation. It refuses to overwrite an earlier run.
Do not rerun it automatically after a failure.

```sh
npx vitest run tests/w0-first-three.test.ts tests/w0-source-package.test.ts --maxWorkers=2
```

`source-package-requirements.json` defines the next complete package boundary.
`validateW0SourcePackage` in `scripts/validate-w0-source-package.ts` checks the
required schema and internal provenance consistency offline. It rejects missing
license or tree identities, altered hashes, nonselected PRs, explicit synthetic
provenance and imported integrity-only receipts. Its tests use authored in-memory
objects, including simulated live-shaped declarations; they are not API captures,
human labels or evidence that the validator can authenticate an invented response.

BaseTip is the current PR base tip and is metadata only. MergeBase is the actual
comparison base and must not be substituted for baseTip. Each is distinct from
head in the schema, with its own commit/root-tree observation. A root license
must be bound to the captured head, its tree entry and exact content bytes. That
check does not interpret license terms or establish coverage of before-source.

The capture adapter now requires actual identity/license sidecars from the existing
collector and validates each full package before acceptance. Missing or inconsistent
sidecars fail closed. See `docs/w0-source-producer.md` for the producer and the
specific diagnostic input needed before another real attempt.
All current-observation content (including title/body/head/discussion) stays
quarantined and cannot become rule input merely because acquisition succeeded.
No W1/W2 source, diff, discussion, labels or model-output endpoint is authorized.
No independent human annotations, mining or real models were executed.

The prepared validator also requires a bounded acquisition audit linking original
receipt events and every added identity/license observation. Passing it means
consistency of the supplied records, not proof of actual network activity. The
endpoint allowlist supports declared commits, root trees, reachable retained
subtrees and changed blobs. Unretained or unreachable trees are rejected. The current failed run cannot pass this complete-package
validator and must not be converted into a synthetic success artifact.

Final targeted verification: 2 files / 34 tests passed (9 capture-control tests,
25 source-package tests), including independent `git hash-object --stdin` and
base64 with real line breaks. Independent review checked receipt multiset counting
and fail-closed endpoint scope. The package audit enforces its own 50-entry limit;
it does not yet prove a combined budget across multiple source packages. Future
sidecar acquisition must retain the existing batch-wide budget and add a shared
run audit before that stronger claim is made.
