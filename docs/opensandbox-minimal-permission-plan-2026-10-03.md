# Minimal local OpenSandbox control plane — pending, not executed

**Later outcome:** approval was received and one actual SDK allocation was attempted.
TLS/auth passed, readiness timed out, and all live resources were independently
verified removed. See [the live evidence](evidence/opensandbox-live-2026-10-03/README.md).
The pending/next-step language below records the earlier preparation stage.

**Current disposition:** the separately authorized never-started Docker archive
experiment succeeded. The [pinned local patch](../deploy/opensandbox/README.md)
removes helper execution, so the former default-root/network helper exception
is no longer requested. No control plane, API key or TLS key has been created.

This narrows the [earlier feasibility review](opensandbox-lifecycle-feasibility-2026-10-03.md).
It is an approval-ready proposal, not a lifecycle receipt. No control-plane API
key/certificate or service was created. The separately authorized archive test
pulled one image, created a never-started helper and removed both. No model, gateway
credential or production deployment is needed.

## Network choice and exact scope

**NET_ADMIN is not required.** Omit `networkPolicy`, egress sidecar and credential
proxy; leave the optional bwrap isolation extension disabled. Use one host-process
control plane with the existing Docker daemon; no Docker socket mount or listener
is needed. Explicit workload settings: bridge network, `publish_host=127.0.0.1`,
`drop_capabilities=["ALL"]`, `no_new_privileges=true`, `pids_limit=64`, CPU 1,
memory 512 MiB, one sandbox, TTL at most 300 seconds. No host binds or added
capabilities. Set `server.host=127.0.0.1`, `proxy.resolve_internal=false`, and SDK
`useServerProxy=true`. Record exact owned container IDs and selected local ports.
No wildcard/public bind, host networking, global firewall or trust-store change.

`network-none` cannot exercise official SDK commands: execd requires a routable
HTTP endpoint and a container with only its own loopback has none. The reviewed
server documents host/bridge/custom modes; `skipHealthCheck` cannot create the
missing command transport. Docker exec would be a different, out-of-band test.
Bridge without a policy permits outbound networking; this experiment must not
claim deny-default egress or production network isolation.
[Official configuration](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/configuration.md),
[endpoint extraction](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/networking.py#L707).

**Archive helper no longer needs an execution exception.** The original upstream
helper starts an image with default root/network/capabilities. The selected local
patch pins upstream commit and original/patched file hashes, removes start/reload,
and creates an archive-only helper with network none, drop ALL, no-new-privileges
and read-only root. Actual Docker verification read all five assets while state
remained `created`, PID 0, StartedAt zero; the helper and new image were removed.
It is explicitly a local modification, not an unmodified upstream deployment.
Custom images requiring startup-generated assets are not covered.
[Patch and proof](../deploy/opensandbox/README.md).

## Actions needing one explicit confirmation

| Action | Scope, lifetime and cleanup |
| --- | --- |
| Create a temporary control-plane API key | 32 random bytes; task directory mode 0700, configuration file 0600. Only this server/client; never injected into the sandbox, command arguments, Git or logs. No external account or authorization is created. Static key has no intrinsic expiry: stop server after at most 15 minutes and delete configuration/key. Keep official authentication enabled. |
| Create temporary TLS key/certificate and scoped client trust | Certificate SAN 127.0.0.1, validity one day, actual use at most 15 minutes. Standard Uvicorn `--ssl-keyfile`/`--ssl-certfile` serving the official ASGI app at 127.0.0.1; SDK uses a task-scoped CA/dispatcher with verification enabled. No system CA installation, TLS bypass or product adapter relaxation. Delete private key/certificate and stop listener afterward. |
| Start local authenticated control plane and one SDK sandbox | Pin reviewed upstream source and dependency resolution; temporary Python environment/cache only. Configure via `SANDBOX_CONFIG_PATH`. Existing daemon access stays in host process. Workload uses explicit loopback-published bridge ports. Control-plane-to-execd remains local HTTP: this is not end-to-end TLS. Stop all task processes and verify owned listeners closed within 15 minutes. |

The [official startup guard](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/startup_guard.py#L55)
requires a configured key or an explicit insecure acknowledgment. The proposal
uses the former. The [official CLI](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/cli.py#L345)
does not itself pass TLS options; the installed Uvicorn help confirms its standard
TLS flags. This launch approach still requires actual compatibility verification.

## Admission budget and run sequence

The completed bounded layer measurement found 57.52 MiB compressed and
115.40625 MiB decoded tar. Conservative capacity planning estimates 5.619 GiB
additional, leaving about 10.898 GiB from the recorded available space. The
subsequent real pull/create/archive/remove test observed a minimum free space of
16,739,540,992 bytes (15.59 GiB). The test container and new image were removed.
This sampled value is not a guaranteed filesystem high-water mark.

Reuse the existing worker image; do not rebuild/copy node_modules. Pin execd to
`opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a`.
Keep the 8 GiB additional planning envelope, 1 GiB dependency allowance, fresh
pre-stage free-space checks and 500 ms sampling with a 6 GiB reaction threshold.
No sidecar image is needed. These are planning/stop controls, not hard quotas;
daemon cancellation may lag. Dependencies and real control-plane operation remain
unmeasured. [Capacity evidence](evidence/execd-capacity-2026-10-03.md).

After confirmation and admission: start HTTPS server; verify authenticated SDK
access; reserve/create one sandbox; run only `/usr/bin/id -u`; record actual exit
code/output; invoke official pause and inspect paused state; delete and inspect
absence. In finally, remove only recorded owned IDs/processes/files and task-only
new image references, leaving the retained worker image untouched. Check for
late allocations by owned labels/IDs within the bounded cleanup interval; report
unresolved resources rather than claiming durable allocation fencing. Lifecycle
success is separate from production request ingress, model auth, protected request
files, frozen evidence and cancellation guarantees, all still unproven here.

## Completed checks and their limits

`node scripts/check-opensandbox-local-plan.mjs` validates the proposed settings
offline and reports pending actions, workload hardening and the local never-started
helper patch. Its default capacity fields remain unset; the measured evidence is
recorded separately and must be refreshed for a launch. It never starts services or allocates. Optional `--health`
accepts only HTTPS `127.0.0.1` with exact `/health` path, verifies TLS,
limits response bytes and total deadline, and labels a positive response as health
only. It does not authenticate or claim lifecycle success.

Eight targeted tests cover configuration rejection and real loopback TCP failure
paths: refused connection, plaintext peer rejected by TLS, and stalled TLS handshake
bounded by deadline. All temporary test sockets are closed. No certificate/key was
created to run these tests. TypeScript checking also passed. These are operational
error-path tests, not a successful OpenSandbox server health receipt.

The [capacity follow-up](evidence/execd-capacity-2026-10-03.md) records both the
initial metadata-only investigation and the subsequently authorized measurement.
Neither is a control-plane lifecycle receipt.

## Final capacity update for the permission request

The subsequent authorized [bounded layer measurement](evidence/execd-capacity-2026-10-03.md#authorized-bounded-payload-measurement--completed-follow-up)
completed in 9.759 seconds: 57.52 MiB compressed, 115.40625 MiB decoded tar,
all 13 layer/diff-ID hashes verified, no extraction/import/execution, owned cache
removed. Pin `runtime.execd_image` to
`opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a`.
The revised conservative planning estimate is 5.619 GiB additional, leaving about
10.898 GiB from current free space. The image capacity gap is resolved for a bounded
attempt; dependency installation still has a monitored 1 GiB allowance. Preserve
the 8 GiB planning envelope, 6 GiB reaction threshold and fresh pre-stage checks;
neither value is a hard quota or a measured Docker peak.

The parent can request three concrete permissions in the table above in one step:
task-only API key, temporary verified/scoped TLS, and loopback control plane with
one bounded workload. The pinned never-started helper patch removes the previous
helper execution exception. No
NET_ADMIN, new model credential, API call, privileged mode or host networking is
required. None of those pending permissions has been exercised. Before a later
launch, verify the preparation/cleanup executor against the documented requirements;
the static checker is not an executor.

## Prepared executor and remaining confirmation

The default-dry-run [control-plane executor](../scripts/opensandbox-control-plane.py)
now implements temporary preparation, a detached deadline supervisor, parent-exit
handling and process/port-verified cleanup. [Usage and scope](../deploy/opensandbox/README.md#temporary-control-plane-executor-not-yet-launched).
Eight nonsensitive fixture/inert-process/configuration tests pass; no real key, certificate or
control-plane service was created by them. Five archive-verifier error-path tests
and eight static-plan/health tests also pass, each with its original evidence scope.

The minimum remaining user confirmation is:

1. Generate a task-only 32-byte API key and one-day loopback TLS certificate/private
   key, used for no more than 15 minutes, with scoped verified client trust and the
   documented stop-before-delete cleanup.
2. Start the patched authenticated control plane on loopback in this dedicated
   environment and later perform the single bounded no-model SDK lifecycle trial.
   Bridge egress remains unrestricted; no deny-default network claim is made.

No helper process execution/default-root-network exception, NET_ADMIN, model/API
credential, model call, external account, host trust-store change, privileged mode
or public listener is requested. Dependencies must first fit their installation
budget, and the separate SDK lifecycle driver must provide owned-allocation cleanup;
the current executor supervises only the control plane. Approval is still pending.
