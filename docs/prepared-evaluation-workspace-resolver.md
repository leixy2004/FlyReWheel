# Prepared evaluation workspace registry

`createPreparedEvaluationWorkspaceResolver` supplies the existing trusted
`resolveWorkspace` dependency with a concrete evaluation-aware registry. It returns
`{workspace, evaluation}` for an exact authorized selection. The ordinary prepared
workspace resolver continues to reject evaluation exports.

The strict administrator configuration requires `schemaVersion: 1`,
`purpose: 'offline-study'`, and `entries`. Each entry contains:

- `selection`: `workspaceId`, `jobDigest`, `repository`, `kind`, `baseSha`,
  `headSha`, `expectedSha`, and the required logical `evaluationExportId`.
- `workspace`: canonical absolute `repoPath`, `runId`, and `attemptId`.
- `manifestDigest`: `digestOf(prepared.record)` from the existing preparation.
- `evaluation`: the complete binding returned by `prepareEvaluationWorkspace`.

Only trusted composition code loads this registry. Queue jobs cannot supply paths,
registry configuration, visibility manifests, or executable modules. A purpose
marker does not grant runtime or model authorization. Default worker behavior and
bootstrap requirements remain unchanged.

## Existing preparation and composition

With a retained export store and its original visibility manifest, use a new,
independent derived repository for the attempt:

```ts
const workspace = { repoPath: derivedRepoPath, runId, attemptId };
const prepared = await prepareEvaluationWorkspace({
  ...workspace, exportId: selection.evaluationExportId, storePath, manifest,
});
const registry = {
  schemaVersion: 1, purpose: 'offline-study',
  entries: [{ selection, workspace, manifestDigest: digestOf(prepared.record),
    evaluation: prepared.evaluation }],
};
const resolveWorkspace = createPreparedEvaluationWorkspaceResolver(registry);
const resolved = await resolveWorkspace(selection, signal);
// Trusted deployment composition may inject resolveWorkspace into the existing
// dispatcher or worker bootstrap, with separately authorized runtime dependencies.
```

Use the actual job digest and exact intended checkout in `selection`. Preparation
is separate: resolution never creates exports or worktrees, acquires leases,
executes code, fetches objects, or widens `allowedHeads`. Save the registry outside
queued input and reopen it with the same constructor after a process restart.

Each lookup reopens the workspace manifest and checks its pinned digest, complete
binding, clean ready worktree and exact SHA. It then calls the existing evaluation
verifier to inspect the immutable baseline and the derived repository's exact
object/ref closure and tree bytes. Missing provenance is explicitly rejected;
ordinary workspace fallback is forbidden. Returned bindings are deep copies.
Execution still performs its own lease-time verification; resolution is not a
lease and does not guarantee the repository remains unchanged afterward.

## Bounded CLI inspection

Integration must import `registerEvaluationWorkspaceCommands` from
`./cli-evaluation-workspace.js` in `src/cli.ts` and call it with the existing
`evaluation` command. This lane leaves that shared-file registration to the main
integrator. After registration, preparation, and saving the exact registry and
selection JSON, the default CLI can perform a read-only lookup:

```sh
timeout --kill-after=5s 90s npm run cli -- evaluation workspace resolve \
  --registry /absolute/path/registry.json \
  --selection /absolute/path/selection.json \
  --timeout-ms 30000 --out /absolute/path/new-inspection.json
```

The registry is limited to 2 MB and the selection to 16 KB. `--out` refuses to
replace an existing report; omission prints JSON. The result retains the complete
selection and binding and their source digests. `--timeout-ms` is an acceptance
deadline: no late result is accepted, but an active verification step finishes
under its existing per-process bounds before cancellation is reported. The outer
shell timeout bounds this invocation independently. It is not cleanup evidence.
No database, model, SDK transport, worker, or queue is opened by this command.

This inspection does not accept stage/model/resource fields in selection JSON;
unknown fields are rejected rather than discarded. Those settings belong to the
separately validated execution configuration.

## Native study chain: currently disconnected

The existing `runSdkNativeStudy` is an authored selected-evidence study driver.
Its inputs are frozen packet/future blocks and schedule/configuration, not W0
workspace selections. Native proposal/gate/future requests have stage and role
settings but no evaluation binding; the authored transport has its own working
directory. Existing checkpoint identities therefore do not bind these exports.
Do not pass a resolver result through this interface and describe it as an
evaluation-aware native run.

The remaining bridge must explicitly bind verified export provenance into study
and per-call identities and reverify it on reopen, while preserving stage and
resource settings. That requires coordinated native contract changes. Six valid
exports alone do not supply frozen revision episodes, gate/future cases or human
labels. No such objects or model results are synthesized by this command.

Existing authored native recovery can be checked independently with:

```sh
timeout 90s node node_modules/vitest/vitest.mjs run \
  tests/matched-revision.sdk-native-contracts.test.ts \
  tests/matched-revision.sdk-native-schedule.test.ts \
  tests/matched-revision.sdk-native-recovery.test.ts --maxWorkers=2
npm run experiment:matched -- --study-status STUDY_DIGEST --db EXISTING_PGLITE_DIR
```

The first command uses authored local executables and PGlite. The second only
inspects an existing checkpoint. Neither proves a real W0 native run. Model
authorization, deployment authority, and operational admission remain prerequisites
for any future production path.

## Checkout and evidence boundaries

The dispatcher selects **before** context for PR mining. An after-side registry
entry cannot satisfy a different before-side selection. A direct existing mining
adapter can use its explicit after context, preserving the same evaluation binding.
Mining/revision snapshot recapture still requires the snapshot's base/head objects
to exist inside the authorized closure. A before-only export that lacks the after
commit must fail; do not expand its manifest or remove evaluation to make it pass.

Data PR #27 at `d778aba7c1abcd029bb90ce94d7f6f4e9f583cd8` records inspection of the
six retained W0 exports under
`experiments/temporal-pilot/w0-first-three/evaluation-preparation/`.
The corresponding unchanged visibility manifests and bindings are in
`experiments/temporal-pilot/w0-first-three/full-context/context-<PR>-<side>.json`.
The retained store is `/tmp/flyrewheel-w0-full-context-attempt-1/exports` in the data
environment. That environment must perform the real-export positive lookup using
this resolver; these retained objects are absent in the independent review environment.
Do not refetch upstream or transfer local source artifacts to reproduce that check.

Tests here use authored local Git fixtures and the actual export/preparation and
verification functions. They are not real W0 execution, a model run, an isolation
test, or evidence of historical public availability. Runtime readiness and verified
lifecycle authority remain independent requirements.
