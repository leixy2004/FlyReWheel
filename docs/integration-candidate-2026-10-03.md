# Integration candidate: 2026-10-03

This branch combines fixed, reviewed development checkpoints in the selected user
cloud environment. It is a draft integration candidate, not a main merge, release,
production deployment, completed empirical pilot, or successful model connection.

## Inputs

| Work | Exact input commit | Review |
| --- | --- | --- |
| Handoff main | `237056acaaa3c21684fd63772eaca119e2af5f3a` | Baseline application source |
| PostgreSQL verification and recovery corrections | `e296ae8f17f569f0b694464273dcc45ef28c41e2` | PRs #4 and #8 |
| Runtime image and connectivity attempt record | `0e503679cb59dfa9e09e79877dcce0bad48ed427` | PRs #6 and #9 |
| Temporal metadata, validation, and W0 failed acquisition audit | `671e57dd0f41099260d9d50c8cbac15b631a6c9f` | PRs #5, #7 and #10 |
| Worker entrypoint path fix | `f1f2f61523eb82cafd2af09827ca6e73b8cb6792` | Issue #13, independent implementation/review |
| Bounded pull request CI | `2f19dc3427249a2253061b5570d8ebde7fb56829` | PR #12 |

Each input is merged without rewriting its source branch. Ongoing collector work
and any later branch updates are excluded until explicitly added as new inputs.
The entrypoint fix for issue #13 is integrated separately and recorded in this
branch's commit history and draft PR.

## Evidence boundaries

The real PostgreSQL 17.11 scenarios cover migration rollback, lock contention,
queue recovery, owner fencing, same-container database restart, and authored study
checkpoint recovery. Their execution snapshots and limitations remain in their
original evidence files and PR records. They do not prove every interleaving,
replica failover, backup recovery, or production least-privilege operation.

The bounded runtime image and no-model container smoke were exercised in a
separate cloud session at their recorded source snapshot. A later official CLI
connectivity attempt failed during configuration loading before a model turn.
It does not establish inference access, model quality, or deployed application
readiness. This integration does not rebuild the image or repeat that invocation.

The HTTPX frame contains public metadata. W0's first acquisition attempt stopped
on its first failed request and produced zero source packets. Frame validation
and authored source-package tests do not turn that into successful collection;
independent labels and empirical effectiveness remain unestablished. W1/W2 source
contents were not acquired by this work.

## Regression record

The earlier PG-only frozen head `3fdb63bb767622c9177a3f4d6283126496154277`
finished with exit 1: 95 files / 1571 tests passed, one file / two tests failed.
Both compiled-entrypoint tests exposed silent exit 0 when the launch path traversed
a symlink. A physical-dependency focused run passed 89 tests, but did not fix the
entrypoint defect or replace the failed full run. See
[the original final result](https://github.com/leixy2004/FlyReWheel/pull/4#issuecomment-5974009784).

Issue #13 requires path-aware main detection and explicit direct, relative,
symlink and import regression coverage for both source and compiled entrypoints.
Final aggregate results belong to an exact candidate commit/tree and are recorded
in its draft PR with the test command, exit code, counts, duration and log hash.
A focused test pass must never be presented as a full-suite pass.

The new CI workflow is read-only and bounded. Its presence is not evidence that a
hosted run succeeded; inspect the actual GitHub run result separately. No merge to
public main is performed by this candidate. `/goal` was not enabled because this
session exposed no callable goal-setting interface or control socket.
