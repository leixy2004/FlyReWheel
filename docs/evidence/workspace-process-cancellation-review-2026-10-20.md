# Cancellation review and local recovery limits

Reviewed base: `80592e81d324147bce9fccbb1cde442fc0520343`.

Independent read-only review and targeted examination found no confirmed new
production lease-release defect. The process helper never releases a lease.
The runner retains its lease unless backend stop, collection and destruction
verification succeed; failure remains a recovery blocker. This is an API contract
with the backend, not proof that arbitrary backend assertions are true.

One confirmed evidence defect was fixed: the real descendant unit test previously
treated every `/proc/<pid>/stat` read error as process absence. Only `ENOENT` now
means absent; permission and I/O failures propagate. The compiled CLI verification
already used this fail-closed distinction. A zombie is terminated, but unreaped;
its existence must not be reported as a running process or as physical removal.
The fixed test still verifies only its known authored descendant, not all possible
descendants or production runtime destruction.

Supplementary real-process tests cover a runnable command cancelled before spawn
(no marker created), spawn failure and abort listener removal, cancellation after
successful close, direct-child cancellation with `detached=false`, and eight
exit/cancellation races. The race test accepts either already-completed output or
cancellation and checks listener removal; these runs do not exhaust all kernel
schedules or demonstrate PID-reuse safety. Existing running child/same-group
descendant and retained-lease tests remain in the targeted suite.

## Crash takeover: evidence versus missing authority

Current persisted evidence consists of an attempt manifest/history, ownership
record (token, expected commit, creation time), cancellation marker and any
previously collected diagnostics. Diagnostics never disclose the owner token.
A separate owner process exiting with its lease is covered by the existing
compiled diagnostic check: the lease remains, diagnosis is readable, and cleanup
is refused. No runtime is launched by that diagnostic fixture.

Static examination shows that a detached runtime can outlive a crashed runner.
The cancellation marker is polled by the live runner; it is not an independent
supervisor. This review did not experimentally crash a runner with a live runtime.
The lease lacks a persisted, independently verifiable runtime binding, process
birth/boot identity, durable fencing generation, and authorized recovery owner.
It also lacks authoritative stop/descendant containment, collected-evidence and
runtime destruction receipts usable after the original owner disappears.
A timestamp, absent PID, readable token or local process `close` cannot fill these
gaps. Automatically removing the lease would therefore be unsafe.

Within existing local permissions, a future narrow development-only supervisor
could be built and tested for newly created owned child processes: persist attempt
and process-birth identity, fence old owners, collect bounded evidence, and verify
termination before an explicit owner handoff. This would be a new lifecycle
protocol, not permission to adopt existing abandoned leases. Supporting arbitrary
crashed runtimes or production recovery cannot be safely completed from current
local evidence alone; it needs a trusted runtime authority and a validated
ownership/fencing protocol. No automatic takeover or release was added here.

## Final validation of this correction

Typecheck and build passed. Four targeted files passed all 69 tests: process
cancellation, Codex workspace runner, workspace lifecycle, and OpenSandbox stop
recovery (the latter uses authored mocks, not a live sandbox). Compiled real-process
cancellation and residual-lease diagnostic scripts both passed: 23 CLI calls,
18 successful and 5 expected refusals. The review did not run unrelated repository
tests or live production/model tests. Raw structured results are in the adjacent
`workspace-process-cancellation-review-2026-10-20.json` file.
