# Local authored governance loop

This executable example joins the existing local feedback/revision demo to explicit local-shadow governance and an actual persisted governed semantic review. All responses and developer scenarios are authored fixtures. Human finding verdicts remain `Unknown`; no model, provider, authenticated developer approval, production activation, or external notification is exercised.

Use the repository's supported Node environment with dependencies already installed and Git available. From the repository root, choose a new output directory under a temporary parent:

```sh
npm run build
parent=$(mktemp -d)
mkdir "$parent/home"
env -i PATH="$PATH" HOME="$parent/home" TMPDIR="$parent" \
  QE_ENABLE_MODEL=false QE_S3_ENABLED=false \
  node dist/cli.js closed-loop governance-demo --out-dir "$parent/demo"
# Repeat exactly this invocation in a new process to verify persisted replay.
env -i PATH="$PATH" HOME="$parent/home" TMPDIR="$parent" \
  QE_ENABLE_MODEL=false QE_S3_ENABLED=false \
  node dist/cli.js closed-loop governance-demo --out-dir "$parent/demo"
```

For source execution, replace `node dist/cli.js` with `node --import tsx src/cli.ts`. The command accepts only `--out-dir` and uses explicit file-backed PGlite at `demo/source-loop/db`; ambient database configuration is not used. The clean environment prevents inherited credentials/provider settings. Dependencies must be preinstalled; these commands do not install them.

The sequence is:

1. Run the existing authored local loop: root rule, positive/negative review fixtures, two fixture feedback records attributed to that root, compatible accepted revision, and regressed rejected revision. Acceptance alone does not select a rule.
2. Explicitly register and bootstrap the root in local-shadow governance, then save a root review plan.
3. Register both successors and explicitly supersede the root with the compatible direct successor using its accepted decision. Selecting the regressed candidate with its rejected decision must fail. These successful operations persist exactly five governance events.
4. Execute the old plan request: its stale governance binding must block before admission or workspace resolution. Create the current plan selecting only the accepted successor.
5. Run that plan through the existing dispatcher, governed admission, workspace adapter and SDK authored executable. Assert a persisted semantic-review outcome, completed execution receipt, admission matching both plan and selection digests, and review rule digest matching the accepted successor. A finished job alone is insufficient.
6. Validate the completed job and persisted receipt against the exact rule, snapshot, admission and job-derived workspace. Finalize that workspace with the existing cleanup API even on a replay that skips workspace resolution. Then reopen PGlite and compare review, history and status. Verify fixture verdicts remain `Unknown` and the legacy production-active pointer remains null.

`demo/report.json` is an immutable success report. `artifacts/` contains root/current plans, five governance events, stale/current status, feedback attribution and the executed review. `source-loop/` retains the source loop's immutable provenance, evidence, reports and database. `runtime/` contains the fixed authored executable and one execution/request marker. A successful rerun must reproduce saved artifacts and reuse the completed job without another authored execution or revision generation.

`demo/last-run.json` records the latest acquired-lock attempt as `running`, `succeeded` or `failed`, with an observation time and failure message where available. A historical success report is not proof that the latest invocation succeeded: check the process exit and last-run status. Failures before claiming an output directory/lock do not modify its checkpoint. Tampered immutable artifacts cause refusal, not overwrite.

A completed database outcome can be finalized after a handled failure before workspace cleanup or before artifact export. Replay reuses that outcome without worker execution and requires verified `closed-clean` workspace finalization and the retained branch at the exact snapshot SHA before reporting success. Active execution leases, missing or changed workspaces, dirty workspaces and `cleanup-unverified` states still refuse success. If a crash removed a worktree before its `closed-clean` manifest was saved, existing cleanup deliberately refuses automatic recovery.

This is committed-outcome finalization, not general interrupted-execution recovery. An interruption can leave `.running`, or exclusive runtime request/execution markers without a committed result. Preserve the failed directory for inspection and run into a fresh empty output directory; do not delete markers and claim an automatic resume. Abrupt process death can leave `last-run.json` at `running`.

The authored backend is explicitly `authored-test-no-isolation`. It uses the existing semantic review `full-repo-shell-v1` request policy, but its fixed executable emits a predefined response and makes no tool/provider calls. Cleanup verification is derived from worker process-group evidence, not merely promise completion. This demonstrates application wiring with real local PGlite and authored SDK execution, not real PostgreSQL, an isolated live runtime, a real-model review, scientific effectiveness, or operational production readiness. Historical admitted results remain readable; stale-plan blocking here occurs before admission and does not assert retroactive revocation.

Focused verification:

```sh
npx vitest run tests/local-governance-loop.test.ts --maxWorkers=1
```

The test invokes the actual source CLI in fresh processes, checks persisted execution/admission and replay, then verifies immutable-report tampering fails and records a failed attempt. Failure-injection tests cover committed outcomes before cleanup and after cleanup but before artifact export, followed by fresh-process CLI replay. Grouped negative checks retain active leases, missing workspaces, moved retained branches and unverified cleanup without issuing a success report. An injected failure before the atomic domain/outcome commit verifies that no executed review is persisted and a reopen cannot promote the runtime execution marker into success. A separate check refuses unrelated nonempty output directories without modifying their contents.
