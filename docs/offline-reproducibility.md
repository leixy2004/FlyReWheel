# Offline preparation and inspection, with an explicit execution stop

This is a runnable path from the three saved HTTPX W0 source packages to a local
PGlite store, immutable mining-job files and blocked preflight reports. It stops
before queueing or executing those jobs. A separate optional example exercises
an authored paired evaluator; its inputs are not HTTPX study data.

Verified at commit `4be3720f55dc3ac054f7b701ae6ff681fded68a6`, tree
`c7e74132c472f5e299329e841d6cef7c15936bef`, in
`/workspace/FlyReWheel-integration-context`. This local smoke is independent of
pending hosted CI and does not borrow any earlier full-suite result.

## Prerequisites and isolated paths

Use Linux, Git, Node.js 22+ and the repository's already installed dependencies.
This run reused existing dependencies and successfully ran `npm run build`;
installation, downloads and the full test suite were not run. Actual environment:
Node 24.19.0 and npm 11.9.0. Run commands sequentially from the repository root.

```sh
RUN_ROOT=$(mktemp -d /tmp/flyrewheel-offline-repro-XXXXXX)
mkdir "$RUN_ROOT/home"
offline() {
  env -i PATH="$PATH" HOME="$RUN_ROOT/home" TMPDIR="$RUN_ROOT" \
    LANG=C.UTF-8 QE_ENABLE_MODEL=false QE_S3_ENABLED=false "$@"
}
offline npm run build
```

All executed CLI/preparation processes used that allowlist: no ambient
DATABASE_URL, PG variables, credentials, proxy variables or NODE_OPTIONS were
inherited. Empty HOME isolates account configuration. This is environment hygiene,
not an operating-system network sandbox. The selected commands do not acquire
sources or invoke models. Every store explicitly uses a local PGlite `--db`.
Do not pre-create the `db` or `prepared` subdirectories: preparation requires new
paths and refuses reuse. Existing recorded outputs should be preserved; create a
new root for a new reproduction.

## Prepare frozen real-source inputs without mining

```sh
offline node --import tsx scripts/prepare-w0-mining.ts \
  --db "$RUN_ROOT/db" --out "$RUN_ROOT/prepared" \
  > "$RUN_ROOT/preparation.json"
```

The script reads the fixed local packages for PRs 3035, 3031 and 3036, verifies
their pinned bytes and provenance consistency, imports existing evidence, derives
requests and closes/reopens the store. It makes no upstream request. Expected
`prepared/` output is ten JSON files: three `request-input-N.json`, three
`request-N.json`, three `generation-template-N.json`, and `ledger.json`.

Actual reproduced ledger counts:

| Database content | Rows |
| --- | ---: |
| `qe_github_pr_evidence` | 3 |
| `qe_pr_mining_requests` | 3 |
| `qe_problem_cases` | 8 |
| `qe_pr_mining_candidates` | 0 |
| `qe_rule_bundles` | 0 |
| `qe_feedback` / `qe_semantic_review_feedback` | 0 / 0 |

The ledger reported `reopenedAndVerified=true`, `idempotenceVerified=true`,
`humanLabels=0`, `modelExecution=not_run`, `configuredModel=null` and
`evaluationReady=false`. All eight source-case expectations remain unknown.
Source packages are real captured material; neither import nor a pure prompt
builder supplies a model proposal or independent label. These original
changed-source templates also do not consume the later full-context or Ruff
behavior artifacts merely because those artifacts exist elsewhere in Git.

## Export jobs, inspect prerequisites, then stop

The timestamp below is the actual authored attempt timestamp used in the smoke.
It is at or after request creation and is not a historical source cutoff.
`workspace-id` is a logical identifier for a future trusted resolver, not a local
path or evidence that a runnable workspace has been provisioned.

```sh
for PR in 3035 3031 3036; do
  offline node dist/cli.js application-jobs prepare-mining \
    --db "$RUN_ROOT/db" --request "$RUN_ROOT/prepared/request-input-$PR.json" \
    --workspace-id "httpx-w0-$PR" --candidate-created-at 2026-10-03T23:00:00Z \
    --attempt initial --job-out "$RUN_ROOT/job-$PR.json" \
    > "$RUN_ROOT/prepare-$PR.json"
  offline node dist/cli.js application-jobs preflight \
    --db "$RUN_ROOT/db" --file "$RUN_ROOT/job-$PR.json" \
    > "$RUN_ROOT/preflight-$PR.json"
  offline node dist/cli.js application-jobs status \
    --db "$RUN_ROOT/db" --file "$RUN_ROOT/job-$PR.json" \
    > "$RUN_ROOT/status-$PR.json"
done
offline node dist/cli.js application-jobs bootstrap-check > "$RUN_ROOT/bootstrap.json"
```

All ten operation invocations exited 0, but **exit 0 means the inspection ran**,
not that execution is ready. Each preflight returned `status=blocked`,
`execution=not_run`, `modelExecution=not_run`, `workspaceVerification=not_run`
and `jobStateChecked=false`. Each separate local status returned
`state=not_started`, `attempts=0`, `queueState=null` and `result=null`.
`prepare-mining` creates a job file and persists its immutable request; it does
not enqueue, claim, run or create a candidate. Local status reads domain storage,
not a PostgreSQL queue. `bootstrap-check` returned `status=disabled`.

All three preflights listed the same six missing prerequisites:

- `disabled`: reviewed execution configuration is not enabled.
- `model_required`: no explicit model selection.
- `generation_limits_required`: no generation byte/time limits.
- `runtime_required`: no reviewed runtime configuration.
- `lifecycle_authority_required`: missing injected lifecycle verification/cleanup authority.
- `workspace_resolver_required`: missing trusted resolver for prepared exact identities.

Their bound mining base SHAs were respectively
`dd5304d3eb97f0aad7126a45f3fd7041dfee0ac2`,
`b871b4b8b29aca2e675645fae0c9f8e7d2a5e7d5`, and
`ea3071642d12ed546d901861a5901da6fad37073`.
These are binding checks, not live verification of those workspaces.

**Stop here for real W0 inputs.** This document deliberately has no enqueue,
worker-start, model-enable, acquisition or credential-configuration command.
Trusted code capabilities, deployment verification, model/spending authorization
and configured budgets require a separate completed gate; configuration JSON
alone cannot supply them. Human annotation, W0 rule freeze, lineage/availability
checks and later-stage exposure remain missing study gates. W1/W2 source and
labels are not opened. This is not a complete real-study command chain.

`application-jobs recovery` is intentionally omitted: unlike the local `status`
used here, recovery can reconcile an expired claim. Do not use it as a supposedly
read-only readiness shortcut on an existing operational database.

## Separate authored evaluator smoke

This optional sequence first creates every required input file, then scores it.
It has no connection to the prepared HTTPX database or jobs.

```sh
offline node dist/cli.js evaluation demo --directory "$RUN_ROOT/authored-evaluation" \
  > "$RUN_ROOT/evaluation-demo.json"
offline node dist/cli.js evaluation score \
  --dataset "$RUN_ROOT/authored-evaluation/dataset.json" \
  --annotations "$RUN_ROOT/authored-evaluation/annotations.json" \
  --runs "$RUN_ROOT/authored-evaluation/runs.json" \
  --out "$RUN_ROOT/authored-score.json" > "$RUN_ROOT/evaluation-score.json"
```

Both exited 0. The demo generated `dataset.json`, `annotations.json`, `runs.json`
and `report.json` with mode `authored-synthetic-no-model-no-human-annotation`.
Rescoring produced the same report identity
`paired_evaluation_b4ef714a908c1fca5cd43ef3ea0d60158a688cd0e452223df7ed7415dcd81f5f`.
Each arm retains two PRs/two units, five synthetic positive instances, one negative,
one unknown and one disputed instance. The authored comparison gains one positive
and loses one while removing one false-alert instance. These are fixture assertions,
not findings about H/U/M, HTTPX, live models or review improvement. No matched
live-model runner, real model, annotator or target-repository code was executed.

## Local evidence and limits

The actual run root was `/tmp/flyrewheel-offline-repro-1l0oh5fv`.
It retains 13 command records, per-command JSON/stdout and empty stderr, fresh
PGlite data and generated outputs. All 13 commands exited 0. The separately
executed build also exited 0. No real PostgreSQL, network acquisition, deployment,
authentication operation or model call occurred. Only this document is added to
tracked source; temporary artifacts are local evidence and may later be removed.

| Artifact under that root | SHA-256 |
| --- | --- |
| `commands.json` | `456b1afdc066e7eea7aed7b1b20c99aacfe1f4b48728e7967545eb5ce0539a3b` |
| `prepared/ledger.json` | `f061ba536fcb2f986a01a283e31e32d90d6f9c6087016d18af68f66e48fdb223` |
| `authored-score.json` | `2e006426a82bef4ede489c2e4406ffaafbf3a6ef7660b6a5ba916b07eb7c97a6` |

For contract details see [application operations](application-operations.md),
[paired evaluation](paired-review-evaluation.md) and the
[methods/artifact mapping](../paper/executable-artifact-map.md).

## Source-CLI native study and reopen

PR31 adds the default source-entrypoint chain below (research modules intentionally
require the source checkout; the compiled bridge rejects without execution):

```sh
npm run cli -- evaluation native init-authored --directory /tmp/new-authored-study
npm run cli -- evaluation native run --manifest /tmp/new-authored-study/manifest.json --checkpoint /tmp/new-authored-study/checkpoint
# Run the same command in a fresh process to reopen the completed checkpoint.
```

At integrated source `b71ac155`, actual default CLI initialization, run and fresh
process reopen passed with byte-identical output. This uses authored local Git,
PGlite and a fixed simulated SDK, with zero model calls. `evaluation native init-w0`
accepts six frozen context files, provenance, source commit and optionally an
existing administrator registry; its `native run` persists a non-executable blocked
checkpoint. The actual CLI metadata-only check retained six bindings and four
semantic blockers, with workspace verification explicitly not run because no local
registry was supplied. Full evidence and command-log hash are in the
[integration record](integration-context-composition-2026-10-03.md#frozen-functional-candidate-native-evaluation-bridge).
