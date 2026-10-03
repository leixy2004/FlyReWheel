# Real OpenSandbox lifecycle: bounded single-node feasibility

Checked in the independent FlyReWheel cloud environment on 2026-10-03. This is
source-backed deployment feasibility, **not a successful OpenSandbox run**. No
server was installed or started, image pulled, model called, authentication
created/disabled, socket exposed or host security/network setting changed.
Two independent read-only agents reviewed public host-broker availability and
the official Docker runtime path. No new blocked interface or fake authority was
added. The existing real Docker worker-image smoke remains separate evidence.

## A: host Codex broker capability

The public environment/tool capabilities provide no authorized host app-server
endpoint or broker operation. CLI help documents proxy/remote transports, but
that is not evidence of a platform-provided endpoint. No hidden sockets, tokens,
or unknown services were probed. The nested CLI identity-state failure is already
pinpointed in [the initialization evidence](evidence/codex-connectivity-attempt-2026-10-03.md).
This authentication subtask is stopped rather than retrying model calls.

The platform would need to explicitly supply a permitted, version-matched broker
entrypoint (preferably a managed stdio channel), hold authentication on its side,
provide writable identity/runtime state outside this task's read-only boundary,
and define allowed methods, workspace/caller binding and cancellation semantics.
No host credentials should be exported into the worker. Official protocol support
alone does not supply that platform capability.

## B: observed resources and official implementation

- Docker is available, driver VFS; approximately 17 GiB root and 8.8 GiB tmp free.
  No containers, build/test subprocesses or OpenSandbox server were running at
  the last successful shell check after the disconnect notification.
- The verified worker image is retained locally as
  `sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed`,
  1,720,090,143 logical bytes. It is not a registry manifest digest.
- Python/uv are available. `opensandbox_server` and Python `docker` are absent;
  official JS SDK `@alibaba-group/opensandbox` 1.1.0 is installed.
- Presence-only checks found none of `OPENSANDBOX_ENDPOINT`, `OPEN_SANDBOX_DOMAIN`,
  `OPEN_SANDBOX_API_KEY`, `OPENSANDBOX_CONFIG`. Values/credential files were not read.
- Official server source was pinned at
  `c7dc78a4090e5de2b9119e9bd93952cae24f87bd` for inspection, not silently installed
  from moving main. Server/SDK wire compatibility still needs actual validation.

A host-process control plane is viable in principle: the official backend uses
[`docker.from_env()`](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/docker_service.py#L153).
It does **not** require mounting the Docker socket into a control-plane or worker
container. The official example can bind its server to loopback and set Docker
`publish_host=127.0.0.1`; never inherit the general `network_mode=host` default.
[Example configuration](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/examples/example.config.toml).

The [narrowed permission plan](opensandbox-minimal-permission-plan-2026-10-03.md)
separates the optional NET_ADMIN policy from the minimal SDK experiment and
documents the upstream extraction-helper defaults.

## Exact actions missing from the current authorization boundary

| Requirement / official action | Finding and disposition |
| --- | --- |
| Start an authenticated control plane | Official startup requires a configured API key, or explicit `OPENSANDBOX_INSECURE_SERVER=YES` / interactive YES acknowledging authentication is disabled. No existing credential/endpoint was provided. Neither a new key nor that security relaxation was performed. |
| Establish transport TLS | Official CLI launches Uvicorn with HTTP settings, and the quickstart does not establish HTTPS. A supported TLS front end/configuration and scoped trust would be needed for the product adapter. We did not replace HTTPS with HTTP or disable TLS verification. |
| Enforce deny-default egress | A `networkPolicy` creates an egress sidecar with `NET_ADMIN`. This is a concrete added capability, not an ordinary no-permission-change test. It was not enabled. Omitting policy yields a different, unenforced egress claim. |
| Enable official bwrap isolation extension | `bootstrap.execd.isolation=enable` adds `SYS_ADMIN`, unconfined seccomp/AppArmor and unprotected system paths. This optional mode is outside scope and was not enabled. It is not required merely to describe a basic Docker lifecycle. |
| Bootstrap execd | Requires another official execd image and temporary extraction container, with expanded-size and temporary-container settings to audit first. No image was pulled. UID 10001 by itself is **not** an established incompatibility: daemon `put_archive` injects runtime assets independently of that UID. |

Sources: [API-key startup guard](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/startup_guard.py#L55),
[Uvicorn invocation](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/cli.py#L345),
[egress capability](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/networking.py#L510),
[bwrap configuration](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/docker_service.py#L902),
[runtime injection](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/runtime.py#L200).

The no-new-credential and no-security/network-relaxation constraints therefore
block the documented full server/SDK path **before any allocation** in this task.
This is not a claim that OpenSandbox fundamentally requires privileged containers,
host networking or Docker-socket mounts. Those broad claims would be incorrect.

## Product gates versus the smaller no-model experiment

| Existing FlyReWheel condition | Correct interpretation |
| --- | --- |
| Authenticated model gateway required during preflight | Necessary for a production model turn, not intrinsically necessary for an official lifecycle/constant-command smoke. A separately classified SDK experiment can omit inference without pretending the production preflight passed. |
| Registry-style `name@sha256` input | The retained local image ID is immutable but is a different identifier. Official Docker/SDK accepts broader image inputs; a local test can bind and independently inspect the exact image ID. This does not authorize weakening production image provenance or publishing an image. |
| HTTPS endpoint | Stricter than the SDK's HTTP-capable local quickstart, but it is an explicit product boundary and the task forbids weakening TLS. Do not silently change the adapter to make localhost HTTP pass. |
| Stop/frozen collection/destroy authority | Real deployment guarantees, not schema ornament. Official pause/kill/delete responses alone do not establish durable admission fencing, late allocation reconciliation, protected snapshots or absence of all orphan resources. |
| Protected request-file ownership | Irrelevant to an `id -u` constant-command smoke, but still required for untrusted repository/model execution. Keep the existing check unchanged. |

The official SDK can be used directly for a separately named diagnostic after
its deployment prerequisites are authorized; no fabricated callback returning
verified=true is needed. Such a smoke must never be reported as the full
FlyReWheel model runtime or production authority.

## Minimal next executable experiment, after prerequisites are supplied

Use one task-owned host-process server, one task-labeled sandbox and the existing
worker image. Configure loopback-only control/data endpoints, explicit bridge
mode rather than host mode, no host binds/credentials/sockets in workloads, and
bounded CPU/memory/PIDs/TTL. Preserve TLS/authentication through an authorized
control-plane setup. Use official SDK allocation, execute a fixed command such as
`/usr/bin/id -u`, then official pause and delete. Independently inspect the exact
Docker IDs/labels and paused/stopped/removed states, enumerate only those owned
resources, and clean them in finally. Record API failures separately from Docker
observations; do not infer full frozen-evidence or unknown-allocation fencing.

Budget before installation/pull: retain at least 5 GiB and a reaction margin,
measure the additional execd image expanded layers and dependency environment,
then account for VFS writable container copies plus any sidecar/extraction
containers. The existing image alone can require another ~1.72 GB container copy.
With unknown execd/sidecar expanded sizes, 17 GiB free is not yet an admitted peak
budget. No parallel image builds, global prune or cleanup of others' containers.

An in-process shortcut was also reviewed. The exported `DockerSandboxService`
class has official integration tests, but it is a server-internal API, not the
SDK transport. Its constructor restores existing sandboxes and expiry timers;
bootstrapping can create extra temporary containers. Directly adapting it would
bypass the deployment path under test and introduce resource-ownership questions.
No bespoke bridge was added merely to avoid the startup security decision.
[Constructor](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/docker_service.py#L197),
[official internal test](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/tests/test_docker_delete_integration.py#L63).

The deliverable is the precise deployment/capability gap and bounded experiment
plan. There is **no new successful OpenSandbox lifecycle receipt**. Prior Docker
container evidence and prior authored SDK tests retain their original labels.
