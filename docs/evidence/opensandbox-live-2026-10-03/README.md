# Authorized real control-plane and single-allocation trial

User approval was forwarded by the parent as `Sentinel_c3831d3b321881918d082b60d3eb958f`
(2026-10-03 23:21 UTC). This environment first received it after dependency
preparation; no earlier live lifecycle request had been admitted here. Scope:
temporary local API key/TLS/control plane <=15 minutes, one no-model lifecycle,
no public exposure or external sandbox egress. No model or account credential was
used. API keys/private certificates existed only in 0700 temporary task directories
with 0600 files and process memory. Their contents were not printed or committed.

## Actual result

**Control-plane TLS/authentication works; SDK sandbox readiness did not pass.**
The actual lifecycle trial lasted **53.005 seconds**:

- Verified HTTPS `/health` returned healthy; unauthenticated `/v1/sandboxes`
  returned **401**. TLS verification stayed enabled with a task-scoped CA.
- Exactly **one actual SDK allocation request** was dispatched. Docker events
  show one worker created and started.
- Patched helper was created, read through five archive calls, then destroyed.
  Its event stream has **no start event**. No root/default-network helper executed.
- SDK raised `SandboxReadyTimeoutException` after its 30-second readiness window.
  The fixed `/usr/bin/id -u` command, command status and pause were **not reached**.
- SDK failure cleanup produced worker kill/die/destroy events. Subsequent
  independent Docker listing found no owned worker/helper. This verifies observed
  deletion in this trial, not a durable late-allocation or production stop fence.
- Control-plane process group and listener stopped; task secret directory,
  internal network and newly loaded execd image were removed. Existing worker/Node
  images and prepared Python dependencies were retained.
- Minimum sampled free space: **12,941,807,616 bytes** (about 12.05 GiB). No disk
  threshold was crossed. No second sandbox allocation was attempted.

[Full sanitized receipt](lifecycle-trial.json). The exact outer orchestration
used for this trial is recorded as historical evidence, not a general deployment
entrypoint. It manages only the recorded task ownership and has a 180-second outer
operation deadline; the independent control-plane supervisor has a 900-second
ceiling. Cleanup has a separate finite budget. No receipt should be interpreted
as all future late allocations being fenced.

## Earlier session, before any SDK network dispatch

An initial control-plane session passed TLS health and unauthenticated 401 but the
diagnostic driver's use of undici fetch on Node's native `Request` failed before
network dispatch. Offline reproduction with a dispatcher that counts invocations
returned `TypeError: Failed to parse URL from [object Request]`, dispatch count 0.
This affected the driver, not the production transport source. The initial counter
looked only at `init.method`, so its zero count alone was insufficient evidence;
the deterministic offline reproduction and absence of Docker events establish the
more limited preallocation disposition.

The initial session was completely cleaned and independently checked before the
continuation. The driver now normalizes Request URL/method/headers/body and counts
Request.method correctly. Two offline regression tests pass. The continuation is
the sole actual sandbox allocation, not a second model/lifecycle experiment.
[Initial sanitized receipt](preallocation-transport-attempt.json).

## Internal network scope

Both temporary networks used Docker's supported `--internal --driver bridge`,
unique ownership label and default publish address 127.0.0.1. The executor now
requires an empty, owned, local, Internal=true bridge, IPv6 disabled, and exactly
that allowed option; ordinary bridge is not accepted for actual startup. Workload
port bindings are configured for loopback and the allocation pool 49000..49100.
No sidecar, NET_ADMIN, host networking, routed/nat-unprotected option or trust-store
change was used. Network creation is task-local; no daemon configuration or manual
host firewall/security change was made.

Docker internal networking removes default routing to other networks but retains
host/gateway reachability. This is not network-none, proof against an indirect host
proxy, or production deny-default isolation. No external sandbox request was made
or needed for the fixed no-model command. The readiness failure was **not** bypassed
by switching to ordinary bridge/host networking or disabling TLS.
[Docker internal mode](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal).

## Remaining uncertainty and ownership handoff

The timeout identifies the failed gate but not yet its root cause: server-to-execd
proxy reachability on the internal bridge and worker/bootstrap readiness remain
candidates. The SDK deleted the failed allocation; this run did not retain raw
service/worker logs because credential-bearing diagnostics were deliberately
suppressed. Do not assert that either candidate is proven. No additional allocation
will be made silently to gather missing diagnostics.

This lane owns new `deploy/opensandbox/*`, `scripts/*` and related tests/docs only.
It imports but does not edit `src/adapters/opensandbox-transport.ts`; it has not
changed stopOwned, authority resolvers, production lifecycle/runtime or worker
entrypoint files. Reviewlane can proceed with its assigned stopOwned fix.

Available evidence: immutable image and never-started archive helper; pinned
patched server and dependencies; real HTTPS health/auth; real sandbox create/start;
observed failure-path deletion and independent resource absence. **Not available:**
SDK command success, pause/frozen reads, durable admission/stop/delete fencing,
production request ingress, model call or research efficacy. This remains Draft PR
work and must not be represented as a complete runtime authority.

## Total live-window reconciliation and final independent check

The parent's additional instruction about a non-resetting 15-minute window arrived
after the continuation had finished. No further session or allocation followed.
A conservative bound uses the first outer admission file's mtime (before key/service
creation) through the final cleanup receipt mtime: **23:32:24.469857–23:36:50.288775
UTC, 265.819 seconds total**, including the gap between sessions. Thus the entire
window stayed below 900 seconds without relying on resetting a per-session clock.
[Timestamp calculation](live-window.json). These are retrospective filesystem
observations, not an independently enforced cross-session timer; a future runner
must carry one shared absolute expiry if it supports continuation.

Independent read-only verification at **23:38:01 UTC** found both recorded worker
and helper IDs absent, no Docker containers, the network absent, the execd image
absent, PID/PGID 9936 absent, port 47257 not listening, and the task secret directory
absent. Only the original worker and Node images remained. The earlier session's
resources were independently verified absent at 23:33:29 UTC as well. No secret
values were inspected by the reviewer.

The driver's subsequent instrumentation separates prepared allocation requests
from undici dispatch calls and tests native Request method/body/header/signal
forwarding. That instrumentation change was **not** used for another live run.
The final live receipt's `createRequests=1` is its then-current prepared-request
counter corroborated by the sole Docker worker create/start sequence; do not relabel
it as a newly measured dispatch counter. The preallocation receipt's earlier zero
counter had the documented method-detection limitation.

The initial source review did not establish a root cause. Subsequent
[offline diagnosis](offline-readiness-diagnosis.md) identified a definite mismatch
between internal Docker networking and the configured host-port proxy path, and
fixed the local control-plane configuration. No further allocation was performed;
execd startup and lifecycle behavior remain unverified.
