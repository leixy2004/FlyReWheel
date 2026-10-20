# Authorized single OpenSandbox retry — 2026-10-04

**Outcome: SDK readiness succeeded; full lifecycle trial failed before command
execution. Cleanup remains `cleanup-unverified` because a driver-group zombie
process persists. No second allocation was attempted.**

Authorization: user `Sentinel_6a7d932d8530819183b1701ec77f5b71`, 2026-10-04 08:06 UTC,
explicitly approved the additional bounded trial described by the parent: one
sandbox, at most 15 minutes, no external sandbox network, no model, temporary local
credentials and cleanup. This was a new approval, not reuse of the consumed first
trial. Actual execution used GitHub commit
`c7985bcd45b90e6f9e17fb0dd7704af65b7ad440`, a tested descendant of
`036e64ae1182348491d6587d028a156d17f0f8be`.

## Preparation and bounded execution

The initial inventory had no containers; root free space was 17,522,294,784 bytes.
The existing worker image was reused without rebuilding. The exact official execd
manifest was pulled, with image config ID
`sha256:e12d3de4b28e820bc966fe875484b35a5fad9322c4ef8a5b6751873da03bd214`
and logical size 120,697,170 bytes. Post-pull free space was 16,769,417,216 bytes.
No source change was made to the pinned upstream server or its never-start helper
patch; runtime.py SHA-256 remained
`6b2037ccb1be25b0c3fb8e7a1de56d4e84030326250b1d81c208e3675a8142db`.

A pre-allocation check found that the supervisor's sanitized PATH cannot find the
environment's Node binary. The small c7985bc fix requires its explicit absolute
path; 24 Python tests passed before use. The selected binary reported Node
v24.19.0. The fix preserves the sanitized environment and all existing gates.

The persistent admission began **08:11:21.970 UTC**, with fixed absolute expiry
**08:14:21.958 UTC** (approximately 180 seconds, tighter than the authorized 900).
No restart reset the clock or claims. The state directory and exclusive outer and
allocation claims remain in task scratch for auditing; they contain no API key.
The control event's `deadlineSeconds:900` is the helper's global ceiling, not an
extension of this admission; its supervisor used the saved absolute expiry.

The task-owned Docker bridge was internal, with loopback host binding, no IPv6,
no sidecar/extra network, and no external sandbox route. This is ordinary Docker
internal networking, not a claim of production isolation or prevention of indirect
access through host services. API traffic used a loopback HTTPS control plane with
a task-scoped CA and certificate verification. CPU 1, memory 512Mi, TTL 300s,
pids 64, empty supplied env/volumes and sleep entrypoint were the requested settings.
The container policy assertion did not finish, so this is not a complete independent
post-create verification of every setting.

## Actual observed stages

| Stage | Evidence |
| --- | --- |
| TLS/control health | First bounded attempt aborted, subsequent verified-TLS `/health` returned 200. |
| Unauthenticated API | GET returned 401. |
| Allocation | Prepared counter 1, dispatch counter 1, POST returned 202; Docker events contain one worker create. |
| Patched helper | One create, five archive operations, destroy; **no helper start** event. |
| Worker startup | Asset extraction and Docker start observed. |
| Execd readiness | Authenticated proxy `/ping` returned 200; `Sandbox.create` returned a sandbox ID. The prior ReadyTimeout was not reproduced. |
| Independent policy check | `AssertionError` before storing the completed inspect receipt. |
| Command/status/pause | **Not reached**; no id-u, command-status, pause or resume success is claimed. |
| API cleanup | DELETE returned 204; Docker kill/die/destroy observed. |

The bounded diagnostic snapshot before deletion found the expected owner, worker
image, sole named network, running/unpaused state, no OOM, no published host ports
and an `execd-start-marker`. Process-name inspection returned unknown. The HTTP
readiness response is stronger evidence of a responding execd than that log marker;
neither proves production authority, admission fencing or frozen reads.

## Assertion diagnosis and later offline-only correction

Fixed upstream `container_ops.py` constructs `security_opt` with
`no-new-privileges=true`. The live driver instead tested array membership of the
bare string `no-new-privileges`. That representation mismatch is a deterministic
harness defect and a plausible explanation of this assertion. The live receipt
retained only `AssertionError`, not its exact check or full HostConfig, so it does
**not** establish this as the unique failing line.

The later committed helper accepts exactly the bare enabled flag or `=true`,
rejecting false/unknown/conflicting forms; it also records fixed inspection-stage
names. Fifteen targeted TypeScript tests and the driver typecheck passed. These
changes were **not used for another live run** and do not retroactively upgrade
this result. The consumed allocation claim remains intact.

## Cleanup and remaining limitation

The control supervisor recorded service/port closure and secret removal at
08:12:00.192 UTC; the outer receipt was written at 08:12:01.460 UTC. Its repeated
post-control-plane scans and network deletion passed. The introduced execd image
was subsequently removed; the original worker and Node images were retained.

Independent read-only verification at **08:13:06.798 UTC**, 104.828 seconds after
admission, found no containers, no task network, no added execd image, no listener
on 41381, and no temporary secret directory. Service/supervisor/driver leader PIDs
were absent. Thus live service and resource cleanup occurred within the authorized
window, with the following explicit process-table exception:

- PID **15007**, `esbuild`, state **Z**, PPID **1**, remains in driver PGID **14999**.
- This is a non-executing orphan zombie left by the `tsx` compilation subprocess.
  The process group has not completely disappeared. `driverStopped=false` and
  `cleanup-unverified` remain accurate; the historical receipts are unchanged.
- No attempt was made to signal/restart PID 1 or the shared environment. Reaping
  this already-dead orphan requires its parent/platform; repeated kill signals do
  not reap it. A future driver can be compiled offline before launch to avoid this
  compiler child, but that change and another allocation were not attempted here.

See [independent verification](independent-cleanup.json), [driver receipt](lifecycle.json),
[outer receipt](receipt.json), [Docker events](docker-events.json), and immutable
[admission](admission.json). `recorded-preparation.py` is historical invocation
provenance, not authorization or an instruction to repeat the trial.
