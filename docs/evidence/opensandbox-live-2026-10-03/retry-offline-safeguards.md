# Offline prerequisites implemented (2026-10-04)

This follow-up modifies the existing local trial driver, request helper and
control-plane script. The historical live orchestrator and live receipts remain
unchanged. No service, credential, network, container or image was created here.
The additional real trial still requires the user's pending approval.

## Diagnostic retention before SDK cleanup

The real SDK fake-fetch test now observes diagnostic capture before failure-path
DELETE. The driver records at most 64 fixed route/method categories, HTTP statuses,
elapsed times and allowlisted TLS/connect/abort error categories. It never records
headers, response bodies, full request URLs, original exceptions or environment.

On the first failed readiness request, or before a DELETE if not yet captured,
the driver takes an ownership-checked snapshot. Docker inspect/top/log reads each
have a 1.5s timeout and 64KiB output limit. Saved fields include validated IDs,
network match, state, exit code, OOM, published-port presence and whether `execd`
was observed in process names. Logs become fixed startup-error/marker categories;
raw stdout/stderr is never written to a receipt. Unknown/error outcomes remain
explicit. A startup marker or process name does not prove the listener is healthy.
Diagnostic failures never prevent SDK deletion. This is bounded evidence to
separate startup and route failures, not a guarantee every unknown binary failure
can be uniquely diagnosed.

## Persistent admission and absolute lifetime

The operator supplies one absolute private state directory and one absolute UTC
expiry for the newly approved owner. Preserve that same directory and approval
identity across any cleanup retry; choosing a new directory is not permission for
another allocation. The admission records owner, network, approval reference,
fixed images, start and expiry. Approval references are audit context, not an
independent programmatic authorization check.

An exclusive outer claim prevents relaunching the driver. Its exclusive allocation
claim is created before the POST, with both file and directory fsync; a partial,
empty or existing claim fails closed. The driver binds admission to the task's
approval reference and checks expiry before each request and dispatch. In-flight
requests use the remaining lifetime. A restarted process cannot extend admission
or consume another allocation. Claims survive cleanup of ephemeral secrets.

The absolute lifetime is at most 900 seconds; choose a shorter trial window when
appropriate. Cleanup has separate bounded operations and remains permitted after
expiry. A repeat command on consumed state is cleanup-only, never a second trial.

## Cleanup result semantics

The outer trial reuses the independent supervisor pattern rather than adding an
infrastructure service. It owns driver/control-plane cleanup, then reconciles
owned containers after control-plane shutdown, and verifies the owned network.
Each cleanup stage runs independently; an exception cannot skip later stages or
the final receipt attempt. Process identity protects resumed cleanup from PID reuse.

Unknown task paths, missing supervisor completion evidence, ambiguous creation,
unknown unlabelled helpers, failed inspections and cleanup failures prevent a
success result. Unowned resources are retained and reported, never broadly pruned.
Dependency images already present at trial admission are retained; image acquisition
and its provenance/capacity checks stay a separate preparation step. The worker
image is reused without a build or node_modules copy.

## Review and verification

Two independent local reviewers examined request/TLS/claim logic and lifecycle
cleanup. Their findings led to approval binding, competing-process and symlink
claim tests, detached trial supervision, spawn-signal protection and repeated
post-control-plane scans. All verification uses fake Docker/HTTP operations,
temporary non-secret files, or inert local test child processes.

Final verification at 2026-10-04 00:14 UTC: **23 Python tests and 14 TypeScript
tests passed**, standalone driver type checking and `git diff --check` passed.

```sh
PYTHONDONTWRITEBYTECODE=1 python -B tests/test_opensandbox_control_plane.py
npx vitest run tests/opensandbox-trial-guards.test.ts tests/opensandbox-smoke-request.test.ts tests/opensandbox-readiness-offline.test.ts --maxWorkers=2
npx tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck scripts/run-opensandbox-local-smoke.ts
```

Failure cases include competing processes, partial claims, file/directory fsync
failure, expired or modified admission, symlink/nonprivate files, SDK deletion
ordering, redaction, stage exceptions, late containers, parent EOF before and
after driver spawn, a signal inside Popen, and a vanished leader with a surviving
process group. No full suite or image build was run.

## Execution checklist

- Ready: corrected internal-IP route, scoped TLS trust, cross-fetch compatibility,
  persistent allocation claim, absolute expiry, bounded redacted diagnostics and
  aggregate cleanup failure reporting.
- Required at execution: explicit new user approval; one fixed state/owner/expiry;
  dedicated idle Docker inventory; exact worker/execd image identity; existing
  prepared source/venv hashes; fresh disk budget; owned internal network admission.
- Ordinary dependency preparation: reacquire only the audited official execd digest
  if absent, preserving its existing provenance and measured size budget. No such
  reacquisition occurred here, so no new bytes/cost are reported.
- Still unverified: real execd readiness, command/status/pause and final live cleanup
  with these changes. No inference of fencing, frozen reads or model connectivity.
