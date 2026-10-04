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

## Native study command chain

Before main registration, use the identical source command chain directly with
`node --import tsx experiments/matched-revision/native-evaluation-cli.ts native --help`.
Replace `npm run cli -- evaluation` in the examples with that entrypoint.

After main registers the existing command module, the same source CLI provides
`evaluation native init-authored`, `init-w0`, and `run`. The deployment build
intentionally excludes research fixtures; compiled deployment commands explain
that this offline research flow requires the source checkout and `tsx`. They do
not fall back to production execution.

An authored eligible run creates a tiny independent Git export and frozen
packet/future inputs, then uses the existing native study and checkpoint store:

```sh
npm run cli -- evaluation native init-authored --directory /tmp/new-authored-study
timeout --kill-after=5s 150s npm run cli -- evaluation native run \
  --manifest /tmp/new-authored-study/manifest.json \
  --checkpoint /tmp/new-authored-study/checkpoint --timeout-ms 120000
# Repeat the identical command in a new process to reopen the checkpoint.
```

All labels, replies and SDK script behavior in this lane are authored. The script
is fixed repository code; JSON cannot choose an executable or transport. Model
settings and resource limits are retained from the strict native configuration.
Stage identity, full `evaluation` context and `purpose: offline-study` enter native
request digests, study identity, immutable checkpoint input and final reports.
Legacy studies without this context retain their existing identity algorithm.
The resolver verifies the prepared exports before claim/reopen and each native
call. Finished results are reused exactly, without repeating authored SDK calls;
changed bindings, dirty exports and altered checkpoint artifacts fail closed.
No schema migration is needed: the existing store retains the additional context
inside its validated JSON manifest and receipts.

The context semantics are explicitly `verified-source-provenance-only`. Native
workers still operate on selected evidence in a separate authored directory;
verification does not claim full-repository execution or prove that all supplied
selected evidence was extracted from that repository. Actual packet/future
contracts and schedule validation still apply. This path never grants model,
monetary, or deployment lifecycle authority.

For the real W0 artifacts, extract the six original context files and provenance
ledger from the fixed GitHub commit, without fetching the upstream source:

```sh
npm run cli -- evaluation native init-w0 \
  --contexts /local/context-3035-before.json /local/context-3035-after.json \
    /local/context-3031-before.json /local/context-3031-after.json \
    /local/context-3036-before.json /local/context-3036-after.json \
  --provenance /local/provenance-ledger.json \
  --source-commit 2cb82efbefc764f2b0b04f5ec64da3601da0ef64 \
  --out /local/new-w0-bridge-manifest.json
npm run cli -- evaluation native run --manifest /local/new-w0-bridge-manifest.json \
  --checkpoint /local/w0-blocked-checkpoint
# Repeat the same run command to reopen its byte-identical blocked record.
```

The data environment may add `--registry /local/six-prepared-exports.json` to
`init-w0`. All six full bindings must match exactly once; every actual registry
selection is then verified on run and reopen, including diagnostic job digests.
Without a local registry the result explicitly says export workspace verification
was not run; it verifies only frozen context/ledger identities.

Real W0 remains non-executable because its ledger records no formal rule families,
independent human annotations, developer feedback, or frozen revision packet/future
cases. These exact blockers, all six bindings, original artifacts, source commit,
and the manifest identity are persisted. The blocked branch allocates no database,
SDK, worker or model and cannot be turned into an eligible study by adding stage,
resource, executable or label fields. Actual semantic eligibility requires a
separately valid input contract; missing labels are never fabricated.

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
