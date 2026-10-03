# Real PostgreSQL verification: 2026-10-03

The user-selected cloud checkout at commit
`237056acaaa3c21684fd63772eaca119e2af5f3a`, tree
`3e21d1d39b5da1a63b608508edac2dfee772712a`, exercised compiled application code
against a real PostgreSQL 17.11 server. The reproduction script was a local
addition to that baseline. This is bounded infrastructure verification with
synthetic inputs, not a model-quality evaluation or deployed application.

## Environment and evidence

The temporary official `postgres:17` image used digest
`sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`.
Docker network mode was `none`, port bindings were empty, and host clients used
`/tmp/flyrewheel-real-pg-7cah9p/socket`. The container-local data directory in its writable layer persisted across
an actual KILL/start of the same container. The worker health server bound `127.0.0.1` on an
ephemeral port. No credentials were copied and no model call was made.

[Structured evidence](evidence/real-postgres-2026-10-03.json) contains the complete
prepare/restart and upgrade result objects, raw-file hashes, baseline commit/tree,
and reproduction-script hash. Recorded script hashes identify historical snapshots
at evidence assembly, not a match to the current scripts. Source changes or pending
aggregate tests are not covered by an older recorded pass.

The [independent review](https://github.com/leixy2004/FlyReWheel/pull/4#issuecomment-5973838169)
identified an incidental timing dependency in study lease recovery. The current
prepare script waits, with a bounded timeout, for the database to report lease
expiry before reclaiming; the separate queue expiry delay remains unchanged.
The current study script emits `retainedBlockStructurallyEqual`, reflecting its
parsed-JSON deep-equality assertion. The historical `retainedBlockByteEquivalent`
field means structural equality, not serialized byte equality; archived evidence
and hashes remain unchanged, with an interpretation correction in the structured evidence.

| Layer | Observed result | Boundary |
| --- | --- | --- |
| Real PostgreSQL migrations | 15 migrations, four concurrent pool initializers, zero on repeat | Dedicated fresh database |
| Claims and fencing | One winner among four application claimants and four study claimants; recovered study fence 2; non-winning application owners and stale study owners rejected | Authored application/study identifiers |
| Real pg-boss replay | One callback, six observations, zero errors; duplicate rejected | Offline synthetic replay, no inference |
| Worker process crash | Actual child SIGKILL; same job completed with retry count 1 | Controlled claim/lease recovery scenario |
| Compiled worker service | `/healthz` and `/readyz` 200; replay six observations/zero errors; SIGTERM exit 0 | `startWorkerService` in a child process; runtime blocked |
| Database process restart | Actual container KILL/start; asserted domain/checkpoint records and two completed jobs preserved; zero migrations reapplied; duplicate rejected | Same container writable layer, not volume replacement or distributed failover |
| Study driver crash | Actual SIGKILL after the first block; database-clock lease expiry; another process completes only block two; a third process reopens the identical report without more calls | Official SDK with 24 authored executable calls, zero real model calls |
| Upgrade and rollback | 014→015; failing batch removed its table and retained 14 history rows; corrected retry applied only 015; one sentinel preserved; zero on repeat | Controlled failing SQL, not a production migration rehearsal |

## Reproduction

Use only an explicitly authorized disposable PostgreSQL 17 server with a local
Unix socket. The script fixes database names to `flyrewheel_verify` and
`flyrewheel_verify_upgrade`; both must be newly created, empty databases owned
by the test server's local `postgres` role. It does not provision a server or
configure authentication. Do not reuse an existing application database. Keep
network mode `none`, no port publication, and no external credential access.

From the repository root, after the normal dependency setup:

```sh
npm run build
PG_VERIFY_SOCKET=/absolute/path/to/disposable/socket
PG_VERIFY_EVIDENCE=/absolute/path/to/writable/prepare-restart.json
PG_UPGRADE_EVIDENCE=/absolute/path/to/writable/upgrade.json
timeout 120s node scripts/verify-postgres.mjs prepare "$PG_VERIFY_SOCKET" "$PG_VERIFY_EVIDENCE"
# Stop the designated disposable database process with KILL and start it again,
# preserving that container and its data directory. Wait until its Unix socket accepts connections.
timeout 120s node scripts/verify-postgres.mjs verify-restart "$PG_VERIFY_SOCKET" "$PG_VERIFY_EVIDENCE"
timeout 120s node scripts/verify-postgres.mjs upgrade "$PG_VERIFY_SOCKET" "$PG_UPGRADE_EVIDENCE"
timeout 180s node --import tsx scripts/verify-postgres-study.ts verify "$PG_VERIFY_SOCKET" /absolute/path/to/study.json
```

The restart phase verifies that PostgreSQL postmaster start time changed; calling it without a restart was rejected. The rollback phase verifies that the deliberately failing SQL reached the real driver and produced `MIGRATION_FAILED`, preserving error redaction. Outer timeouts bound stalled database operations.

For the recorded run the coordinator used `docker kill --signal KILL` and
`docker start` on the designated test container between the first two phases.
`prepare` requires empty migration history; do not rerun it on the recorded
populated database. `verify-restart` reads and extends the evidence produced by
that exact prepare run. `upgrade` requires its separate empty database. Internal
`claim-child` and `service-child` modes are launched by the script itself.

## Independent multiprocess extensions

[Concurrency evidence](evidence/postgres-concurrency-2026-10-03.json) records four
independent Node processes. Concurrent enqueue accepted one job and rejected three
duplicates. Each of two claim rounds had one winner and three busy results. After
an explicit cleanup-safe failure made the job retryable, the former winning owner
was fenced and the new owner completed attempt two. This tests real former-owner
fencing; the older `staleApplicationOwnerRejected` field in the prepare evidence
only tested a non-winning owner. Its original raw record and script are retained
with this interpretation correction. This extension does not claim crash or lease
expiry recovery, queue-handler execution, or model execution.

[Migration fault evidence](evidence/postgres-migration-faults-2026-10-03.json)
records SIGKILL of an actual migration process while a real transaction held the
production advisory lock. Two independent migration processes waited for that
lock. The victim paused in JavaScript after executing the appended synthetic
migration SQL, before commit: this is not mid-query cancellation. Probe, ledger
and checksum tables rolled back; the waiters then applied 16 and zero migrations
respectively (15 production migrations plus one synthetic probe). The final ledger
had 16 unique entries, the probe one row, and no remaining experiment locks.
Source and compiled migration SQL hashes matched. The assembly hash identifies
the unchanged harness; the recorded historical HEAD excludes the then-untracked
script and is not a frozen-tree acceptance claim.

Both scripts refuse populated databases. The concurrency script requires its
fixed database to be absent and creates it; the migration script creates its own
fixed database if absent and requires it to be empty with no other sessions.
They retain the resulting databases for inspection and never delete them.

```sh
timeout 120s node scripts/verify-postgres-concurrency.mjs verify "$PG_VERIFY_SOCKET" /absolute/path/to/concurrency.json
timeout 120s node scripts/verify-postgres-migration-faults.mjs "$PG_VERIFY_SOCKET" /absolute/path/to/migration-faults.json
```

Independent reviews found no P0/P1 blocker. Concurrent-child shutdown acknowledges
closed database resources before final process cleanup; it is not evidence of
graceful process exit. These bounded scenarios do not prove every interleaving.

## Remaining gates

This evidence closes the tested single-server migration, claim and restart
scenarios. It does not validate every failure interleaving, production least-
privilege roles, backup/restore, replica failover, or long-duration operation.
PGlite and mocked SDK tests remain separate evidence categories. The compiled
service explicitly reported `applicationRuntime: blocked` and
`modelExecution: not_run`; real isolated workspace execution, provider identity,
model quality, S3 and k3s deployment remain unverified. Current working-tree
aggregate tests are pending. No efficacy result or W0/W1/W2 study outcome follows
from successful infrastructure assertions.
