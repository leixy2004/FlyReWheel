# Minimal local OpenSandbox experiment — pending, not executed

This narrows the [earlier feasibility review](opensandbox-lifecycle-feasibility-2026-10-03.md).
It is an approval-ready proposal, not a lifecycle receipt. No API key/certificate
was generated, service installed/started, image pulled or Docker allocation made
for this proposal. No model, gateway credential or production deployment is needed.

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

**Important upstream helper exception:** execd extraction starts a separate
`tail -f /dev/null` container from the official execd image. Its create call does
not set network, capability drops, no-new-privileges or CPU/memory/PID limits;
Docker defaults apply. Workload settings above do not cover this helper. It is
not explicitly privileged, host-networked, socket-mounted or port-published.
The unmodified official path therefore needs explicit acceptance of this narrow
helper behavior, with a 60-second external deadline and removal of its recorded
ID even if archive extraction fails. At most one helper plus one workload may
exist. If this exception is unacceptable, stop before execution and separately
review an upstream-compatible hardening change; do not silently broaden scope.
[Exact upstream create/start/remove implementation](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/runtime.py#L78).

## Actions needing one explicit confirmation

| Action | Scope, lifetime and cleanup |
| --- | --- |
| Create a temporary control-plane API key | 32 random bytes; task directory mode 0700, configuration file 0600. Only this server/client; never injected into the sandbox, command arguments, Git or logs. No external account or authorization is created. Static key has no intrinsic expiry: stop server after at most 15 minutes and delete configuration/key. Keep official authentication enabled. |
| Create temporary TLS key/certificate and scoped client trust | Certificate SAN 127.0.0.1, validity one day, actual use at most 15 minutes. Standard Uvicorn `--ssl-keyfile`/`--ssl-certfile` serving the official ASGI app at 127.0.0.1; SDK uses a task-scoped CA/dispatcher with verification enabled. No system CA installation, TLS bypass or product adapter relaxation. Delete private key/certificate and stop listener afterward. |
| Start local authenticated control plane and one SDK sandbox | Pin reviewed upstream source and dependency resolution; temporary Python environment/cache only. Configure via `SANDBOX_CONFIG_PATH`. Existing daemon access stays in host process. Workload uses explicit loopback-published bridge ports. Control-plane-to-execd remains local HTTP: this is not end-to-end TLS. Stop all task processes and verify owned listeners closed within 15 minutes. |
| Run the official execd extraction helper under its defaults | One official image/helper, recorded image/container IDs, external 60-second cleanup deadline; scope exception described above. No NET_ADMIN sidecar, isolation extension or user-supplied command in helper. Remove exact helper ID on success/failure; no prefix-wide cleanup. |

The [official startup guard](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/startup_guard.py#L55)
requires a configured key or an explicit insecure acknowledgment. The proposal
uses the former. The [official CLI](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/cli.py#L345)
does not itself pass TLS options; the installed Uvicorn help confirms its standard
TLS flags. This launch approach still requires actual compatibility verification.

## Admission budget and run sequence

Observed root free: 17,735,708,672 bytes; tmp free: 9,431,150,592 bytes. Existing
worker image is 1,720,090,143 logical bytes on VFS; reuse it, no rebuild/copy of
node_modules. Proposed **additional planning ceiling: 8 GiB**, not an enforceable
quota or measured admission: dependency environment/cache 1 GiB, execd images and
extraction copies 3 GiB provisionally, worker VFS copy approximately 1.72 GB plus
128 MiB scratch, remainder contingency. No sidecar image is needed. Resolve exact
execd image digest and layer metadata, account for decompression and VFS copies,
and re-check available bytes before each install/pull/allocation. Unknown expanded
sizes currently prevent admission. Keep at least 5 GiB free plus a 1 GiB reaction
margin; sample disk every 500 ms and cancel owned work below 6 GiB. Cancellation
is not a hard filesystem quota and may not instantly stop a daemon operation.

After confirmation and admission: start HTTPS server; verify authenticated SDK
access; reserve/create one sandbox; run only `/usr/bin/id -u`; record actual exit
code/output; invoke official pause and inspect paused state; delete and inspect
absence. In finally, remove only recorded owned IDs/processes/files and task-only
new image references, leaving the retained worker image untouched. Check for
late allocations by owned labels/IDs within the bounded cleanup interval; report
unresolved resources rather than claiming durable allocation fencing. Lifecycle
success is separate from production request ingress, model auth, protected request
files, frozen evidence and cancellation guarantees, all still unproven here.

## Completed verification without permission changes

`node scripts/check-opensandbox-local-plan.mjs` validates the proposed settings
offline and reports pending actions, workload-only hardening, helper exception and
unmeasured capacity. It never starts services or allocates. Optional `--health`
accepts only HTTPS `127.0.0.1` with exact `/health` path, verifies TLS,
limits response bytes and total deadline, and labels a positive response as health
only. It does not authenticate or claim lifecycle success.

Eight targeted tests cover configuration rejection and real loopback TCP failure
paths: refused connection, plaintext peer rejected by TLS, and stalled TLS handshake
bounded by deadline. All temporary test sockets are closed. No certificate/key was
created to run these tests. TypeScript checking also passed. These are operational
error-path tests, not a successful OpenSandbox server health receipt.
