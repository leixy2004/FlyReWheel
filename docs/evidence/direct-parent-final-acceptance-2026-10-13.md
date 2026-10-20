# Final independent acceptance of fc20317

Verified product-code HEAD: `fc203176b7cce417076856d41b6939748806ebff`.
Branch: `codex/explicit-review-continuation`. No source changes or new commits during acceptance; the worktree was clean. This later archival commit contains evidence only and does not change the verified product-code HEAD.

## Result and limits

The fixed direct-parent capture task passed. This is not a statement that FlyReWheel is complete or production-ready. No further expansion was performed.

Scope survives literally in capture, snapshot import, reopened persistent snapshots and inventory. Review/finding and JSON/CSV batch exports carry the exact snapshot digest; feedback carries review/finding bindings, and the revision request freezes the feedback digest. These references resolve to the same limited snapshot. Reports do not duplicate a full-history assertion or the entire snapshot. Snapshot digest: `a7f698832d0601c7fb842f88bc34f27d46fc0e3f5d393da30679609263cd3b61`.

The native capture's `local-direct-parent-check` receipt becomes `package-integrity-only` on import/readback while preserving evidence scope and snapshot digest. The old capture still rejects the real shallow store; its Git/history gate modules have no changes from parent `7477781`. PR evidence and paired-research schemas reject direct-parent snapshots. Evaluation recapture rejects them before history access. Existing contract regression tests passed.

Independent original-object verification read two original commits, all 400 reachable tree objects (201,611 bytes), and all 18 changed blob sides (131,744 bytes). It recomputed Git object identities and matched changed paths/modes/blob bytes to the official GitHub provenance. Original head is `953d9c820b0d8f9a55ee455814287536a498498c`, parent `33b06a6f24be632e99c19cadb5004a27cf9605a0`. The parent's original ancestor header and shallow/promisor markers remain unchanged. No missing objects were synthesized or fetched.

The original 30 successful CLI output files match their recorded SHA256 hashes and the committed evidence command list. A fresh compiled CLI flow in a separate database completed another 30 successful calls plus the expected legacy-capture rejection. Both flows' digest chains and snapshot contents agree. The original 30 are not counted as newly executed calls in this acceptance.

## Executed commands and counts

Working directory: the repository root. The commands below normalize machine-specific paths; they describe the completed acceptance run, not a new run during archival. Node was v24.19.0. Set `NODE_BIN_DIR` to the directory containing that Node/npm installation and `ACCEPTANCE_HOME` to an empty absolute directory. Each npm/Node invocation used a clean environment equivalent to:

```sh
env -i PATH="$NODE_BIN_DIR:/usr/bin:/bin" HOME="$ACCEPTANCE_HOME" LANG=C.UTF-8 TZ=UTC <command>
```

The regression command was:

```sh
npm test -- tests/direct-parent-snapshot.test.ts tests/git-evidence.test.ts tests/change-snapshot.test.ts tests/change-snapshot.cli.test.ts tests/github-pr.test.ts tests/github-pr-storage.test.ts tests/paired-evaluation.test.ts tests/evaluation-workspace.test.ts tests/semantic-review.test.ts tests/semantic-review.storage.test.ts tests/revision-inspection.storage.test.ts tests/revision-comparison.storage.test.ts tests/revision-explanation.test.ts tests/governed-review-offline.test.ts tests/review-batch.test.ts tests/review-batch-export.test.ts tests/application-job-history.test.ts
```

Result: **17 files, 249 passed, 0 failed, 0 skipped**, one run, 147.11 seconds. No fixes or reruns were needed. The original local log is not bundled; its SHA256 and exact counts are recorded in the [archived audit](direct-parent-final-audit-2026-10-13.json).

Additional executed product commands, all exit 0 (paths parameterized):

```sh
npm run typecheck
npm run build
node scripts/verify-vllm-direct-parent.mjs "$VLLM_SOURCE_DIR" "$VLLM_GIT_STORE" "$NEW_FLOW_DIR"
```

`VLLM_SOURCE_DIR` is an absolute path to the verified official source directory containing `provenance.json` and the exact blob files it names. `VLLM_GIT_STORE` is the original bare Git object store; `NEW_FLOW_DIR` is a new, nonexistent absolute output directory whose parent exists. Source preparation and fixed Git identities are documented in the [prior native verification](../vllm-native-capture-verification.md) and [direct-parent feature documentation](../direct-parent-snapshots.md). The driver is [checked in](../../scripts/verify-vllm-direct-parent.mjs); it performs no acquisition or model call.

A separate one-off local audit also exited 0. It recomputed commit/tree/blob Git hashes using local `git cat-file`, checked the original parent headers and preserved shallow/promisor markers, validated snapshot packages and research rejection, then verified every recorded CLI output SHA256 and the review/feedback/export digest chain in both flows. Its results are in the [archived audit](direct-parent-final-audit-2026-10-13.json). The one-off script and full temporary outputs are not included, so this summary does not claim those files can be opened from the repository. Re-running the checked-in driver requires the real input objects described above.

The audit archive retains the fresh run's 30 command records with parameterized input paths, relative output names and original output hashes. `original-flow` and `fresh-flow` are logical artifact roots, not committed directories. Output hashes describe the original run; replayed receipts and runtime metadata may differ. Raw logs, databases, source blob contents and large object stores were deliberately not copied. Archival did not rerun code tests or the CLI flow.

## Product functionality commits

| Commit | Product functionality |
| --- | --- |
| `4de5084` | Explicit context-selected review continuation |
| `fa843e3` | Durable review batches and selective retry |
| `695705d` | Batch JSON/CSV export and recovery selection |
| `3e9dc82` | Immutable application-job attempt history |
| `db09bab` | CLI batch execution with offline fixtures or explicit trusted bootstrap |
| `8f4633f` | Prepared resolver and presence-only runtime preflight |
| `44a59e5` | Development-owned workspace lifecycle and evidence |
| `10a0a02` | Feedback discovery and evidence links |
| `c044e73` | Feedback-driven revision explanation and scoped eligibility |
| `db205be` | Fixture-bound governed review plan execution |
| `fc20317` | Verified direct-parent capture with digest-bound limited scope |

`da486ab` is a test-helper correction. `d02d1bb`, `6c22f5f`, `665aa54`, `0edff99`, and `7477781` are verification/evidence commits, not additional product capabilities. No claim is made about an unavailable old-session `b42a32a`.

## What remains unproven or unsupported

Real model mining, model-generated revisions and semantic review quality have not been demonstrated by these tests. The vLLM rules, responses, feedback and acceptance decisions are authored compatibility fixtures; no real developer feedback was collected. There is no empirical defect-detection or improvement claim.

Direct-parent evidence is not supported by the existing full-history research/evaluation/model-recapture interfaces. Its supported boundary is fixed-pair local capture and structural/offline product flows. Merge commits, nonregular/binary changed content and changes exceeding limits fail rather than produce incomplete evidence. Full vLLM history was not acquired.

Existing runtime adapters/preflight do not amount to a verified production deployment, production credentials, service operation, notification delivery, or real provider execution. None was exercised here. No push, publication, external comments, model calls, credential reads/copies, W1 reads, vLLM installation or target-code execution occurred. There are no remaining blockers for this fixed-pair capture acceptance; the broader product and real-model/production validation remain separate work.
