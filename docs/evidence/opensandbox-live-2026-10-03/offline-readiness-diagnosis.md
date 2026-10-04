# Offline readiness diagnosis

Baseline live receipt: PR #9 commit `9d79a9f610af7e9c5a18986d3dd6dd280d85a810`.
This follow-up used saved receipts, fixed official sources and in-process fakes.
No control plane, credentials, sandbox, image pull/run or model request was created.

## Confirmed configuration defect

Docker Server is 28.4.0. In Moby tag v28.4.0, peeled commit
`249d679a6baf8a32bb6d72d6ac5cc7ab9c90b4ea`,
[endpoint.go lines 701–710](https://github.com/moby/moby/blob/249d679a6baf8a32bb6d72d6ac5cc7ab9c90b4ea/libnetwork/endpoint.go#L701-L710)
skips `ProgramExternalConnectivity` for internal networks. The bridge driver's
[implementation](https://github.com/moby/moby/blob/249d679a6baf8a32bb6d72d6ac5cc7ab9c90b4ea/libnetwork/drivers/bridge/bridge_linux.go#L1517-L1529)
is where port mappings are added. Thus the worker attached only to the task's
internal bridge cannot rely on a published host port.

Our old `[proxy] resolve_internal=false` selected the official server's
[host-mapped endpoint path](https://github.com/alibaba/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/server/opensandbox_server/services/docker/networking.py#L293-L337).
It builds `127.0.0.1:<label-port>/proxy/44772` from labels without verifying an
actual port publication. This is incompatible with the admitted internal network
and is sufficient to explain a readiness failure. The saved live receipt lacks
upstream error details, so it does not establish this as the only fault.

The local control-plane helper now sets `resolve_internal=true`. The host-side
server selects the configured network's container IP and execd port directly;
clients still use the authenticated HTTPS server proxy. Internal network admission,
loopback TLS/API binding, capability drops and ownership checks are unchanged.
This uses the existing network; no external connectivity is added. An internal
bridge still permits host/gateway reachability and is not a production guarantee
against indirect egress through host services.

## Evidence boundaries

| Candidate | Offline finding | Remaining uncertainty |
| --- | --- | --- |
| SDK transport / ingress | Actual SDK 1.1.0 and bounded connection with fake fetch preserve `/v1/sandboxes/fixture/proxy/44772/ping` and API header; fake 200 succeeds, fake 502 reproduces ReadyTimeout and one failure cleanup DELETE. | Live upstream status was not retained. |
| Host port / internal network | Fixed Docker and OpenSandbox sources demonstrate the incompatible route. Actual official endpoint method reproduces label-only host URL with empty Ports; corrected config selects container IP. | Corrected route has not been exercised live. |
| Runtime injection / UID | Docker events show injection and start; five injected assets were mode 0755. UID 10001 need not write `/opt` for daemon archive injection. | Bootstrap/execd process survival and actual runtime logs are absent. |
| Worker contract | Runtime overrides entrypoint; trial command was `sleep 300`, so compiled FlyReWheel worker never ran. | Production worker startup and request execution are not validated. |
| Bootstrap | Actual image script hash is `6646c097e22a6da67c94c6b471a41da54874ab927ef5b52e3de3c5d9adb89289`, different from the pinned current source. | Cannot infer actual `.env` failure behavior from another revision. |

The service's explicit minimal environment does not inherit HTTP proxy variables.
No evidence establishes request execution, command status, pause/resume, fencing,
frozen reads or successful model access. Parent review lane retains ownership of
`stopOwned` and production transport/authority code; this fix touches none of them.

## Reproduction without services

Use the already prepared dependencies and official server checkout at
`c7dc78a4090e5de2b9119e9bd93952cae24f87bd`. Endpoint test verifies the exact
networking.py SHA-256 before exercising its methods with a fake container.

```sh
PYTHONDONTWRITEBYTECODE=1 python -B tests/test_opensandbox_control_plane.py
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/path/to/pinned/OpenSandbox/server /path/to/prepared/venv/bin/python -B tests/test_opensandbox_endpoint_offline.py
npx vitest run tests/opensandbox-readiness-offline.test.ts tests/opensandbox-smoke-request.test.ts --maxWorkers=2
```

The approved single real allocation was consumed and cleaned. Any future live
verification requires a separately authorized allocation and temporary loopback
control plane, with one absolute deadline, the same internal network and fixed
images, bounded safe readiness status/worker-state capture, command/status then
pause/kill only if ready, and independent cleanup verification. No such retry is
requested or executed by this diagnosis.
