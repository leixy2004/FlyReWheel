# Optional evaluation workspace execution

`exact-allowed-head-closure-v1` is an explicit, opt-in Git input policy. It connects
an [immutable evaluation export](evaluation-checkouts.md) to the existing
Sandcastle workspace, supervised runner, fixed worker protocol, and application
receipts. It does **not** establish historical public availability. Commit dates,
caller declarations, and successful execution are not a time machine.

Production requests without this option still use `all-local-refs-v1`. Their
serialized request, generation, and receipt shapes remain unchanged. No live
backend, credentials, network access, model execution, or deployment is enabled
by selecting an evaluation export.

## Trusted preparation and selection

Use trusted bootstrap code to create and register a separate attempt repository:

```ts
import { exportEvaluationCheckout } from './workspace/evaluation-checkout.js';
import { prepareEvaluationWorkspace } from './workspace/evaluation-workspace.js';

await exportEvaluationCheckout({ repoPath: source, storePath, manifest });
const prepared = await prepareEvaluationWorkspace({
  exportId: 'experiment-a', storePath, manifest,
  repoPath: '/absolute/independent/new-attempt-repository',
  runId: 'evaluation-a', attemptId: 'one',
});
```

The new repository path must not already exist, must be independent of the export
store, and must be outside existing repositories with a canonical existing parent.
Allocation failures leave evidence for manual recovery; preparation never recycles
an attempt or repairs/replaces a damaged baseline. Register the returned workspace
identity and `prepared.evaluation` in trusted bootstrap code. Jobs can select only
an optional logical `evaluationExportId`; they cannot supply a repository path,
export store, manifest, backend, executable, or credentials.

A configured `resolveWorkspace(selection, signal)` returns the legacy workspace
identity for ordinary jobs, or `{ workspace, evaluation }` for evaluation jobs.
The latter binding must match the requested logical export ID, repository ID,
and exact selected checkout SHA. Missing, unexpected, or mismatched bindings fail
before model execution. A deployment must explicitly provide this resolver and
its allowlisted registry; no filesystem registry is loaded from job JSON.

For direct supervised runner calls, set both
`historyPolicy: 'exact-allowed-head-closure-v1'` and
`evaluation: prepared.evaluation`. A legacy policy cannot silently execute a
registered evaluation workspace, and an evaluation binding cannot authorize an
ordinary workspace. Mining, semantic review, and revision-generation adapters
carry the optional binding through their context, prompt, generation identity,
workspace request, and receipt. Their trusted persistence paths retain it, and
application outcome acceptance checks the requested export ID. Offline paired
evaluation derives the recorded history policy from the receipt and rejects
a contradictory arm declaration; it never relabels this policy as all-local-refs.

## Admission and transfer checks

1. Reinspect the immutable export against the original visibility declaration and
   bind its request digest, instance-specific completion-record digest, repository,
   checkout, allowed-head set, and logical all-object inventory
2. Initialize a new independent Git repository and import an explicit, bounded
   self-contained pack of only allowed objects. No source clone optimization,
   hardlinks, alternates, remote fetch, or baseline worktree is used
3. Use the existing Sandcastle manager to allocate its normal attempt worktree in
   the derived repository. The baseline is read-only; even direct ordinary
   workspace preparation refuses a recognizable exported baseline
4. Reinspect the baseline and independently compare **all** derived objects,
   including dangling/unreachable objects, with the bound inventory before launch
   and before/after Sandcastle transfer. Require the exact synthetic allowed refs
   plus that attempt's branch; extra refs pointing even to allowed objects fail.
   Require pack/index pairs, independently verify existing reverse indexes with
   Git's read-only `index-pack --verify`, and reject shared/indirect ref storage
5. Reuse Sandcastle's normal bounded bundle transfer. Its `--all` export is safe
   only because this separate source has the admitted refs and exact object set;
   the production transport algorithm is not replaced
6. In the standalone runtime clone, require only the known Git origin aliases and
   attempt branch (including origin/HEAD's exact symbolic target), independently verify all-object inventory, full strict fsck,
   exact checkout/tree bytes, absence of indirect object storage, and clean state.
   The runtime observation must echo the exact request binding
7. The fixed worker input also carries the binding and attempt branch. The worker
   repeats runtime admission immediately before starting its supervised SDK/CLI
   process. Unsupported old worker images cannot accept this protocol extension

The existing byte/time limits, execution lease, stop verification, bounded frozen
artifact collection, destruction verification, process-local persistence
capabilities, and recovery rules still apply. A failed runtime verification cannot
start the worker; cleanup still uses the existing lifecycle. A failed host check
cannot reserve a backend. This is admission of input history, not continuous
attestation after repository code or the agent starts modifying its attempt.

## Package checks and limitations

Review already recaptures its frozen snapshot and selected repository-context
packages from local Git. Evaluation mining additionally recaptures its snapshot;
evaluation revision recaptures selected snapshots and repository contexts.
Revision evaluation is conservatively restricted to one repository and explicitly
allowed snapshot heads. Objects needed by a package but absent from the allowed
closure cause rejection rather than a fallback to the original source repository.

This binds admitted Git inputs, not the factual or historical accuracy of PR
comments, annotations, chosen evidence, prompts, or a model's training knowledge.
All exported ancestors remain visible regardless of timestamps. Public historical
availability remains **unproven** and timestamps still do not establish visibility.
An authored backend exercises plumbing only and records `modelExecution: not_run`.
It is not an isolation boundary or an empirical paper/model result.

The OpenSandbox adapter carries the binding to its fixed verifier and worker
input. Actual production use still requires its existing external lifecycle
and isolation authority, immutable compatible image, credential-isolated gateway,
and verified network/storage/resource restrictions. No live cluster was tested.
Do not expose the original source repository or baseline store to the evaluator.
Linux, SHA-1, regular selected-tree files, and the conservative export size limits
are the currently supported boundary. Concurrent hostile filesystem writers are
outside the cooperative trusted-store contract.

## Reproducible development verification

`tests/evaluation-workspace.test.ts` exercises authored source histories, actual
Sandcastle bundle creation, independent Git clone admission, mutation rejection,
binding mismatches, cleanup, baseline preservation, and legacy request identity.
`tests/evaluation-storage.test.ts` covers hidden orphan packs, reverse-index bytes,
shared packed refs, and default-policy compatibility.
`tests/application-evaluation-binding.test.ts` exercises all three application
profiles with authored runtime outputs and trusted persistence. The compiled
`scripts/smoke-evaluation-workspace.mjs` exercises this path without a model, network,
credentials, or live backend. The [compiled smoke result](evidence/compiled-evaluation-workspace-smoke-2026-10-02.json)
and [final aggregate verification](evidence/evaluation-workspace-verification-2026-10-02.txt)
record 999 passing tests across 72 files, successful typecheck/build, and both
compiled workspace/export smoke checks. These are authored development checks only.
