# Offline cleanup-only recovery dependency fix

Review thread `01a103bc-8aab-7000-a8f6-223e5507308c` reported that an invalid Node
path prevents consumed-claim recovery before any cleanup receipt is written.
At 880695b, `run_trial` called `trial_node` before loading the immutable admission;
the CLI separately required a Node argument before dispatch. Both were launch-only
dependencies incorrectly applied to recovery.

The fix loads and validates the existing admission first. An existing exclusive
outer claim enters the same cleanup-only path as before, without reading or
validating Node. A new launch still requires an existing absolute executable Node
path, after its claim/deadline/allocation checks and before subreaper preparation,
credential creation or live children. Missing Node produces a recorded ValueError;
no executable fallback or second launch is introduced. Recovery receipts omit
nodeExecutable because no launch binary was selected.

Ownership, immutable approval/network/image identity, original deadline matching,
process identity, group-disappearance and independent cleanup checks are unchanged.
Expired admissions remain usable only for cleanup, never to reset the deadline.
Unknown control state or a residual group remains cleanup-unverified; an absent
leader alone does not prove its group disappeared. Historical live receipts and
consumed claims were not invoked or changed during this fix.

32 Python tests passed. Added fixtures cover missing/relative/nonexistent Node,
expired consumed admissions, both absent and residual groups, ambiguous control
cleanup, unchanged admission/claim bytes, fresh-launch refusal, and CLI routing
without Node. All external process/Docker actions in those new fixtures are blocked
or mocked. Existing inert process lifecycle tests remain offline. No service,
credentials, container or allocation was created for this follow-up.

Coordination and the exact tested fix are published on PR #35 through GitHub; no
cross-thread session messaging tool is available in this environment.
