# Offline cleanup reconciliation and prevention

No new control service, sandbox, Docker allocation or model was started for this
follow-up. The consumed admission and historical receipts are unchanged.

## Current cleanup evidence

Independent read-only reconciliation at **2026-10-04 08:24:16 UTC** is recorded in
[cleanup-reconciliation.json](cleanup-reconciliation.json). Successful inventories
show no containers, the exact task network absent, and only the two preexisting
images. The exact introduced execd image is absent; port 41381 is not listening
and `/tmp/flyrewheel-control-a5nug5rs` does not exist. Recorded service/supervisor/
driver PIDs are absent. No active process matches their recorded groups, sessions
or observable descendant relationships.

PID 15007 remains `esbuild`, state Z, PPID 1, PGID/session 14999. It is dead process
table residue, not active execution. The group remains present, so the historical
`driverStopped=false` and `cleanup-unverified` stay in force. No signal was sent
to it or PID 1. New supervision cannot adopt an orphan already owned by PID 1.
These observations cannot reconstruct unrecorded historical escaped descendants.

## Prevention implemented in the task supervisor

The installed esbuild 0.28.2 `lib/main.js` starts its service at line 2272 and
unrefs the child and pipe handles at lines 2303–2308. A Node/tsx leader can exit
without waiting for that service. Previously `stop_group` polled only its direct
Popen leader: signals could stop the remaining child but could not reap it after
adoption by PID 1.

The dedicated trial supervisor now enables and reads back **its own** Linux
child-subreaper attribute before spawning either control service or driver. Failure
blocks those spawns. This changes no shared init, security or network settings.
On driver cleanup, Popen first collects the leader status; only afterward does
`waitpid(-driver_pgid, WNOHANG)` collect adopted descendants in that exact group.
It never uses `waitpid(-1)`, which could steal the control supervisor's status.
Reaping is bounded and uses the existing TERM/KILL cleanup windows. Success still
requires group disappearance; unverified disappearance still downgrades cleanup.

This follows the Linux [subreaper](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html)
and [waitpid](https://man7.org/linux/man-pages/man2/waitpid.2.html) semantics.
It handles orphaned esbuild while this supervisor survives, including parent-pipe
EOF and ordinary termination. It cannot guarantee reaping after supervisor
SIGKILL, or for descendants that deliberately escape the tracked group. Compiling
the driver before a future admission could also remove the runtime compiler;
that alternative was not implemented and no live retry is implied.

## Inspect assertion: proven defect and evidence limit

The exact deterministic defect is a representation mismatch: execution commit
`c7985bcd45b90e6f9e17fb0dd7704af65b7ad440` required
`SecurityOpt.includes('no-new-privileges')`, while pinned OpenSandbox
`c7dc78a4090e5de2b9119e9bd93952cae24f87bd`
`server/opensandbox_server/services/docker/container_ops.py:373` emits
`no-new-privileges=true`. The old predicate rejects that explicitly enabled value.
The correction accepts the bare enabled flag and explicit true form only;
missing, false, malformed and conflicting values continue to fail.

The live receipt contains only `AssertionError`, not the failing line or complete
HostConfig. Other identity/network/capability assertions precede this predicate;
privileged/mount/port/env checks follow it. Thus the **unique actual failed
assertion cannot be recovered from retained evidence**. No retrospective cause or
policy pass is fabricated. Fixed stage labels improve future receipts. All
command/status/pause/delete evidence requirements remain intact; none are bypassed.

## Offline validation

29 Python tests passed. New isolated process tests exercise real orphan adoption
and reaping, normal child exit, TERM-resistant child/KILL escalation, parent-pipe
EOF, preservation of unrelated child exit status, and leader exit-code retention.
Other tests cover setup/readback failure, refusal to spawn after setup failure,
not reaping a live leader, and refusing to report a persistent group as cleaned.
All process fixtures are inert Python children; no Docker/API or trial is used.
