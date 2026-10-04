# Reproduce the offline CLI without accounts

Run from the repository root on Linux with Git and Node.js 22+ (verified with
Node 24). Install locked dependencies with `npm ci --ignore-scripts` before going
offline; installation itself may download packages. These research commands use
the source checkout and `tsx`. `node dist/cli.js evaluation native ...` deliberately
rejects with a source-checkout prerequisite; it has no production fallback.

| Path | What you can reproduce | What it does not establish |
| --- | --- | --- |
| Authored native study below | Local Git export, PGlite checkpoint, fixed simulated SDK responses, completed-result reopen | Real model behavior, human labels, empirical benefit |
| Frozen real W0 below | Six context bindings and an immutable blocked record, including reopen | Semantic eligibility or live source/export verification without a local registry |
| [W0 mining preparation](application-operations.md) | Persisted requests, exported jobs, blocked preflight and not-started status | Enqueue, mining execution or a generated rule |
| [Deployment checks](deployment.md) | Local manifest/renderer validation | Cluster admission, isolation or working production lifecycle |

## Use a new local directory

Run all blocks in the same shell. Existing manifests/results are immutable. Keep
the generated directory for sequential reopen; use a new root for a fresh run.
Do not open the same PGlite directory from concurrent processes.

```sh
RUN_ROOT=$(mktemp -d /tmp/flyrewheel-offline-XXXXXX)
mkdir "$RUN_ROOT/home"
offline() {
  env -i PATH="$PATH" HOME="$RUN_ROOT/home" TMPDIR="$RUN_ROOT" \
    LANG=C.UTF-8 QE_ENABLE_MODEL=false QE_S3_ENABLED=false "$@"
}
printf 'Artifacts: %s\n' "$RUN_ROOT"
```

The environment excludes ambient database URLs and credentials. This is
environment hygiene, not a network sandbox. The commands below do not fetch
upstream source, invoke real models, start workers or allocate a runtime.

## Complete and reopen an authored demonstration

```sh
offline node --import tsx src/cli.ts evaluation native init-authored \
  --directory "$RUN_ROOT/authored" > "$RUN_ROOT/init.json"
offline node --import tsx src/cli.ts evaluation native run \
  --manifest "$RUN_ROOT/authored/manifest.json" \
  --checkpoint "$RUN_ROOT/authored/checkpoint" > "$RUN_ROOT/authored-first.json"
offline node --import tsx src/cli.ts evaluation native run \
  --manifest "$RUN_ROOT/authored/manifest.json" \
  --checkpoint "$RUN_ROOT/authored/checkpoint" > "$RUN_ROOT/authored-reopened.json"
cmp "$RUN_ROOT/authored-first.json" "$RUN_ROOT/authored-reopened.json"
```

Expect `study.execution=completed`, `providerModelCalls=0`,
`independentHumanLabels=0` and identical output across processes. The authored
study exercises 12 simulated calls across diagnosis/proposal/gate/future. Completed
reopen reuses saved results; changed bindings, dirty exports or changed checkpoint
artifacts are rejected. Preserve the authored source/export directory with its
checkpoint because each reopen verifies it. JSON output is captured directly from
`node`, without npm's command banner.

## Preserve the real W0 blocked state

Extract the six saved context files and provenance from this exact local Git
commit. This freezes their recorded bytes; it does not re-fetch HTTPX or prove
historical visibility. No external workspace or registry is required for this
metadata-only path.

```sh
SOURCE_COMMIT=$(git rev-parse HEAD)
W0=experiments/temporal-pilot/w0-first-three
for PR in 3035 3031 3036; do
  for SIDE in before after; do
    git show "$SOURCE_COMMIT:$W0/full-context/context-$PR-$SIDE.json" \
      > "$RUN_ROOT/context-$PR-$SIDE.json"
  done
done
git show "$SOURCE_COMMIT:$W0/evaluation-preparation/provenance-ledger.json" \
  > "$RUN_ROOT/provenance.json"
offline node --import tsx src/cli.ts evaluation native init-w0 \
  --contexts "$RUN_ROOT"/context-*.json --provenance "$RUN_ROOT/provenance.json" \
  --source-commit "$SOURCE_COMMIT" --out "$RUN_ROOT/w0-manifest.json"
offline node --import tsx src/cli.ts evaluation native run \
  --manifest "$RUN_ROOT/w0-manifest.json" --checkpoint "$RUN_ROOT/w0-checkpoint" \
  > "$RUN_ROOT/w0-first.json"
offline node --import tsx src/cli.ts evaluation native run \
  --manifest "$RUN_ROOT/w0-manifest.json" --checkpoint "$RUN_ROOT/w0-checkpoint" \
  > "$RUN_ROOT/w0-reopened.json"
cmp "$RUN_ROOT/w0-first.json" "$RUN_ROOT/w0-reopened.json"
```

Expect `execution=blocked`, `executable=false`, six evaluation bindings,
`nativeStudy=null`, `resources=not_allocated` and
`workspaceVerification=not_run-no-local-registry`. Exit 0 means the blocked record
was successfully saved/checked, not that W0 ran. Its four blockers are absent
semantic rule families, independent human annotations, developer feedback, and
frozen revision packets/future cases.

An administrator with **six existing matching exports** may supply `--registry`
to `init-w0`; [the resolver contract](prepared-evaluation-workspace-resolver.md)
explains exact binding and re-verification. A registry does not remove semantic
blockers. Archived absolute registry paths cannot be reused after cleanup.

## Before models or deployment

A model run needs separately authorized access and spending, an explicitly chosen
model, supported frozen settings, enforced byte/time/call limits, cost admission,
and an implemented trusted transport. These authored commands cannot be enabled
for real models with an environment switch. Research additionally needs real
rules, independent labels, feedback, future cases and a frozen evaluation scope.

Deployment additionally needs real PostgreSQL/queue configuration, explicitly
prepared workspace bindings, and a trusted lifecycle authority proving isolation,
fencing, bounded execution and cleanup. The default application worker remains
blocked; HTTP health or `bootstrap-check` is not execution readiness. Consult
[application operations](application-operations.md), [deployment prerequisites](deployment.md)
and the [actual OpenSandbox trial boundary](../deploy/opensandbox/README.md) before
requesting a separately authorized live run. No deployment command is needed here.

## Evidence and further commands

The frozen baseline `9f51467` passed [123 files / 1849 tests, typecheck and build](https://github.com/leixy2004/FlyReWheel/pull/24#issuecomment-5975239966).
Its [independent default-CLI and legacy-checkpoint audit](https://github.com/leixy2004/FlyReWheel/pull/24#issuecomment-5975140204)
includes zero duplicate authored SDK calls on old-version reopen. These results
belong to that head, not automatically to later changes.

Separate pinned evidence: [six real exports and blocked reopen, `1565fade`](https://github.com/leixy2004/FlyReWheel/blob/1565fade76e4fe640bcfc810415e491d7ac6e13b/experiments/temporal-pilot/w0-first-three/evaluation-preparation/bridge31/README.md),
and [official-tool rendering/schema checks, `d5f0b49`](https://github.com/leixy2004/FlyReWheel/blob/d5f0b49db7da7cb53c5c8528433c8b3fc295651f/docs/evidence/kubernetes-offline-2026-10-04/README.md).
These pinned implementations/evidence are now incorporated in the [converged task branch](converged-application-2026-10-04.md). Their historical results remain bound to their original commits and do not establish a live deployment or a pass for the current tree.

For the earlier request/preflight/scorer chain and its 13 command receipts, retain
the [historical guide at `9f51467`](https://github.com/leixy2004/FlyReWheel/blob/9f51467e9135389bc86f616a6c303c86a22ee95c/docs/offline-reproducibility.md)
and [integration record](integration-context-composition-2026-10-03.md). Product
fixture commands remain in [local closed loop](local-closed-loop.md) and
[paired scoring](paired-review-evaluation.md); neither supplies real W0 labels.
