# Pinned local OpenSandbox hardening

This is a **local modification**, not an upstream release or official deployment
receipt. Upstream commit and original/patched file SHA-256 are in
`upstream-pin.json`. Apply `execd-never-start.patch` only to that exact checkout;
verify original SHA, `git apply --check`, apply, and verify patched SHA before use.

The patch removes helper `start()`/`reload()` and gives the archive-only helper
network none, drop ALL, no-new-privileges and read-only root. Docker archive reads
work on unstarted containers. Platform selection, cache keys, lock, archive paths,
optional missing-asset handling and final removal remain upstream behavior.

The fixed official execd image was independently exercised using Docker's archive
API via `docker cp`, with no process started; all five assets were present.
See [actual receipt](../../docs/evidence/execd-metadata-2026-10-03/stopped-container-receipt.json).
This supports the fixed image only: custom images requiring startup-generated
files are not covered. No image executable or bwrap capability was exercised.

`python3 scripts/verify-stopped-execd.py` is dry-run. Its explicit `--execute`
mode pulls the fixed digest only if absent, creates one restricted labeled
container, inspects never-started state, streams bounded archives, then removes
the exact owned container and newly pulled image. This mode was authorized for
the recorded experiment; it is not authorization for a control plane or models.

The patch does not provide durable allocation reconciliation or fix every upstream
cleanup race. The surrounding executor must retain exact ownership and report
uncertain daemon operations/removal failures. Neither archive success nor a local
patch establishes production lifecycle or model/runtime readiness.

## Temporary control-plane executor (not yet launched)

`python3 -B scripts/opensandbox-control-plane.py` is default dry-run: it creates no
files, credentials, SDK clients or services. The executable scope is only the
control-plane process; it does not issue sandbox/model requests or claim cleanup
of future SDK allocations.

After actual user approval, explicit execution requires `--execute`, an
`--approval-ref` audit reference, `--source` pointing to the exact patched upstream
checkout, `--python` pointing to an already installed venv outside that checkout,
`--execd-image` with the exact tested digest, and `--dedicated-daemon`. The approval
reference is operator-supplied context, **not a fabricated permission receipt**.
The executor refuses dirty/untracked source beyond the pinned patch, an unexpected
image, any existing Docker container, insufficient space, or a non-pipe supervisor
parent channel. It does not install dependencies or pull images automatically.

The detached supervisor creates a 0700 task directory, exclusive 0600 API-key/config
files, a temporary 127.0.0.1 TLS certificate under restrictive umask, and task-local
HOME/SQLite state. The API key is 32 random bytes and is never placed in subprocess
arguments, logs or sandbox environment. Service stdout/stderr are suppressed to
avoid accidental credential-bearing diagnostics. API/TLS values never appear in
public records. The client must use the generated public certificate as scoped
trust with verification enabled; this executor does not implement an SDK client.

A pre-bound loopback socket is passed to Uvicorn, avoiding a port-allocation race.
Docker workload ports are constrained to 127.0.0.1:49000–49100; proxy resolution
uses local published ports. All caps are dropped for workloads, NNP enabled,
PID limit 64, and host binds limited to a deliberately unused path. No policy
sidecar, bwrap extension, credentials or external socket is configured for workloads.
The subsequent sandbox runner must separately enforce one workload, CPU/memory,
TTL, API request ownership, stop/delete and late-allocation reconciliation.

The supervisor has an independent 15-minute monotonic deadline and watches parent
pipe EOF; it samples free space every 500 ms, stopping below 6 GiB (startup requires
7 GiB). Cleanup sends TERM then KILL to the owned service process group with
bounded grace periods, checks process-group disappearance and loopback port
availability, then removes its task secrets/state. If stop/port closure cannot be
verified, it retains the files and reports `cleanup-unverified`; do not interpret
an attempted signal as success. Process startup is explicitly reported as readiness
unverified. The empty-daemon preflight is not a lock against another actor; use this
only in the task's independently owned idle environment.

Eight tests use nonsensitive file fixtures and inert Python child processes to
check zero-side-effect dry-run, explicit inputs, file mode, cleanup failure,
listener closure, low disk, deadline and parent EOF, plus generated TOML validation
with the unchanged DockerConfig class from the pinned upstream source. The
100-port minimum span is an allocation pool, not 101 published listeners. This
submodel validation is not a full server configuration/startup test. They create no API/TLS key and
start no OpenSandbox service. Five separate archive-verifier tests cover Docker
error/ownership classification. The real five-asset archive test remains separate
from these fake failure-path tests and from an actual patched-server startup.
