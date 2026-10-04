# Offline W0 mining preparation

Three frozen real source packages from PR #17 are imported through the existing
`QualEvoStore.importGithubPrEvidence` and `createPrMiningRequest` components.
This is user-authorized exploratory preparation, not an executed mining experiment,
formal preregistration, human annotation, or evaluation corpus. Original acquisition
receipts and quarantine statements remain unchanged; this later preparation has a
separate scope. No upstream requests were made (cumulative budget remains 48/50).

## Reproduce without network or model access

From the repository root with installed dependencies:

```sh
research_run=$(mktemp -d /tmp/flyrewheel-w0-prep.XXXXXX)
node --import tsx scripts/prepare-w0-mining.ts --db "$research_run/db" --out "$research_run/out"
diff -u experiments/temporal-pilot/w0-first-three/mining-preparation/ledger.json "$research_run/out/ledger.json"
npx vitest run tests/w0-mining-preparation.test.ts --maxWorkers=1
npx tsc --noEmit
```

Both `--db` and `--out` must be new directories with existing parents. The command
rejects existing paths, pins the exact original package bytes, validates source/tree/
license consistency, creates a local PGlite store, checks idempotent requests, closes
and reopens the database, and verifies all eight cases and request/evidence identities.
No ambient database settings are used. The binary database is not committed; JSON
exports and the source package hashes reproduce its contents. A failed run may leave
a partial isolated directory; retain it for diagnosis and use a new directory to retry.

## Deliverables and limits

- `request-input-*.json`: existing mining request input format, source `supplied`.
- `request-*.json`: persisted request with exact evidence, snapshot, source and
  statement bindings; pending and synthesis not_run.
- `generation-template-*.json`: pure existing builder output, with the required
  internal placeholder model removed. `model: null` and `executable: false` mean a
  model/configuration is unresolved. These are templates, not executable job payloads.
- `ledger.json`: per-PR preparation, eligibility, missing evidence and zero-proposal
  record, plus verified database counts (3 evidence, 3 requests, 8 unknown cases,
  0 candidates/rules/feedback).

Before sources bind to mergeBase; after sources bind to head. Only the selected
changed sides are available. Root tree identities are not complete repository
checkouts. The prompt states fullRepositoryAvailable=false and toolUse=none.
The pull statement is current, untrusted API metadata. Reviews/comments are not
selected and no claim of historical feedback is made. The existing API assigns
training split for these isolated W0 cases; expected remains unknown throughout.
CreatedAt is the fixed preparation authorship timestamp, not an evidence cutoff.
Rule IDs/version names reserve possible future proposal identities and do not create
rule versions.

Independent native agents read only the frozen W0 packages and implementation.
Their exploratory findings: PR 3035 bumps the documentation tool mkdocs-material,
3031 bumps the lint tool ruff, and 3036 bumps setup-python in two CI workflows.
No runtime-library code or test assertions change. The pinned-version policy comment
in requirements is already satisfied on both sides, so these bumps do not establish
a repair of an unpinned dependency. Neither approval nor upstream release notes are
project defect labels. All three samples remain; none is replaced for low yield.

Each has formal semantic eligibility unknown and defect-rule support not established.
Zero exploratory proposals means the assistants found insufficient support for a
reusable defect rule in this reading. It is not a model's insufficient_evidence
response, an annotation, a measured mining yield, or performance evidence. Full repo
context, project checks and independently verified defect/intent evidence remain
missing. No model, workspace backend, W1/W2 source, or new upstream read is used.
