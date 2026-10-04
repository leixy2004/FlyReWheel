# Additional retry: offline preflight

Reviewed code baseline: `9fb34455e4169e66f63b40a98422e2f60904e489`.
Status: **not admitted**. Parent has asked for one additional bounded retry;
new approval has not arrived. No key generation, service start, image pull/run,
network creation, or sandbox allocation was performed for this review.
The approval-reference string accepted by the helper is audit context, not an
authorization mechanism. The previous single allocation is already consumed.

## Independent review scope

The existing image/lifecycle and security reviewers separately inspected the local
scripts and fixed official source. Existing targeted offline tests passed at the
baseline: 9 control-plane, 1 official endpoint, 5 SDK/request checks. These do not
establish live readiness. Do not rerun the full suite or rebuild the worker image.
Security review found no additional route/TLS defect and classified diagnostic
retention as an evidence gap. Lifecycle review identified the cleanup failure
paths below. For this retry's diagnostic goal, those evidence and cleanup gaps
remain pre-execution gates even though they require no network-policy expansion.
TLS protects client-to-control-plane traffic; control-plane-to-execd is internal
HTTP, not end-to-end TLS.

| Gate | Current evidence | Before execution |
| --- | --- | --- |
| Internal routing | Corrected config selects the official container-IP endpoint. Exact networking.py hash is checked by the regression test. The server runs beside the local daemon. | Recheck named internal bridge ownership/options and actual container network/IP after allocation. Do not change daemon firewall, enable external egress, or use host networking. |
| TLS trust | Driver uses a dedicated undici Agent with only the task certificate, `rejectUnauthorized=true`; loopback origin check and redirect rejection remain active. No global CA or TLS-disable setting. | Verify task certificate SAN matches 127.0.0.1, scoped client health succeeds, unauthenticated API returns 401/403. Stop before allocation on failure. |
| Request compatibility | Normalizer transfers native Request method, body, headers and signal into external undici; fake SDK readiness preserves the path/auth. | Use unchanged explicit local origin, fixed image, empty env/volumes, sleep entrypoint, no model request. |
| Allocation counting | Driver separately counts prepared POSTs and Agent dispatch attempts and rejects a second. Counters describe attempted preparation/dispatch, not proof of server-side create. | One durable exclusive admission record for the new approval/owner, shared across process restarts; no restart with reset counters. Correlate with worker create events. Historical orchestrator is not a reusable authorization wrapper. |
| Lifetime | Control supervisor has 900s monotonic limit and parent-pipe EOF cleanup; historical outer trial used 180s. | One absolute expiry covering preparation and any continuation. Never reset the window by restarting. Reserve cleanup time; stop on first failed gate. |
| Disk/images | Existing worker image is fixed at sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed. Last cleanup removed the execd image. | Fresh read-only budget check; >=7GiB startup and >=6GiB stop threshold. No worker rebuild/node_modules copy. Reacquiring the exact audited execd digest is a necessary scope item unless already cached; no pull until approval covers it. |
| Diagnostics | Current driver retains only exception class; server output is discarded. | Blocker: add bounded safe diagnostics before automatic SDK deletion, as specified below. |
| Cleanup | Driver attempts API delete when a Sandbox object exists; SDK normally deletes on create/readiness failure; outer runner removes verified owned containers and network. | Blocker: explicitly handle ambiguous/late create, independently attempt all cleanup stages, and verify absence after control-plane shutdown. |

## Minimum diagnostic preparation

Reuse the existing driver and outer wrapper; do not add a service or monitoring
framework. Record a bounded ring of method, allowlisted route category, numeric
HTTP status, elapsed time and allowlisted error class. Do not record headers,
request/response bodies, raw URLs with queries, raw exception messages or keys.
The bounded transport intentionally wraps errors; collect safe distinctions inside
the local fetch wrapper before they are erased (TLS/connect/abort/status categories).

The SDK deletes after failed readiness before `Sandbox.create` returns. Capture
one owned-container snapshot on the first failed readiness response/error, and
before forwarding failure-path DELETE if no snapshot exists. Preserve only ID,
image ID, owner-match boolean, network name/IP, published-port presence, running/
paused/status, exit code, OOM flag and timestamps. Do not serialize full inspect
output, Config.Env, labels, mounts or State.Error without screening.

For execd startup, bound Docker log acquisition by time and bytes, then emit only
fixed classifications matched against inspected bootstrap/execd markers, with an
explicit `unrecognized-or-no-log-evidence` result. Never persist raw log lines.
If the actual image bootstrap cannot be matched to the inspected source, record
that uncertainty. Do not silently expand to docker exec or arbitrary filesystem
reads. HTTP 502 plus Docker running is insufficient to establish execd listening;
missing classifications must remain unknown. Diagnostic failure must not prevent
DELETE or outer cleanup, and must fit the overall deadline.

## Cleanup order and failure checklist

1. Stop the driver and prevent further allocation dispatch. Preserve its safe
   receipt even when transport shutdown fails or times out.
2. While the API is available, attempt bounded deletion of the known sandbox.
   A lost response or create timeout leaves ownership ambiguous; use owner labels
   and observed Docker events rather than relying on a returned SDK object.
3. Stop the control-plane process group and independently verify group/port
   absence. Reconcile owned containers again after shutdown so a late server-side
   create cannot appear after the only cleanup scan. SDK abort cleanup is best
   effort, not proof of deletion.
4. Independently remove only ownership-verified worker/helper resources. The
   patched helper must remain never-started. Event loss or unknown resource
   ownership is a cleanup failure, not permission for broad Docker pruning.
5. Verify zero owned containers, remove the owned empty network, and verify its
   absence. Remove only an execd image introduced by this retry and only if unused;
   retain preexisting worker/Node images. Each stage must run even if another fails.
6. Verify control-plane task secrets absent only after service shutdown is proven;
   otherwise report cleanup failure and retain the restricted path for recovery.
   An unknown task path (`task is None`) means unverified, not absent; require an
   explicit supervisor cleanup receipt or independently verified known path.
   Verify PIDs/PGIDs, port, containers, network and introduced image independently.
7. Mark cleanup unknown/failure on Docker inspection errors. TTL and the helper's
   process supervisor are fallback bounds; neither proves Docker resource cleanup
   after outer-process death. Do not claim cleanup on every failure without this
   independent verification.

The final result must aggregate cleanup outcomes: a successful driver exit with
any failed/unknown cleanup stage is `cleanup-unverified`, not success. Guard
signal/wait races per resource so they cannot skip the remaining cleanup stages
or the final receipt write.

## Exact proposed execution scope after approval

One temporary loopback TLS control plane using the already prepared pinned source
and venv; one new owned internal bridge; reacquisition of the exact audited execd
image if absent; one SDK allocation using the retained worker image (CPU 1,
512MiB, TTL 300s, pids <=64), no real model. Only after readiness: `id -u`, command
status, pause with Docker inspection, then delete. No resume/fencing/frozen-read
claim follows from this sequence. No new auth backend, credential copying,
production runtime edits, broader networking or main merge.

The necessary pre-execution changes are bounded diagnostic retention and a
reviewable one-shot outer wrapper with absolute expiry and late-create cleanup.
The historical `recorded-orchestrator.py` remains evidence and must not be edited
into a misleading record of a past run. These are local script changes, not an
infrastructure expansion. Report this scope and the remaining gaps to the parent
before asking to execute; no execution request is made by this document.
