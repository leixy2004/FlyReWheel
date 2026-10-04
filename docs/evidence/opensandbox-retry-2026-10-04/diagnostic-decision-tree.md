# Offline observability follow-up; no new live authorization

The historical trial remains failed and cleanup-unverified. Its retained inspect
projection lacks HostConfig; the exact live failed assertion is unrecoverable.
The new regression test reads that actual historical projection and rejects it as
insufficient policy evidence. Complete test objects are explicitly synthetic.

## Receipt contract

`inspectionChecks` is capped at 64 entries. Each entry has fixed phase (`ready` or
`paused`), check name, expected value, actual value and passed boolean. The driver
writes the receipt **before** throwing on a failed assertion. Owner and network
names become match booleans or fixed classifications. Capabilities, mounts and
security flags use bounded counts and enums. Receipt summary IDs must match the listed 64-hex ID and state names must belong
to a fixed Docker enum before use. Raw Docker objects, arbitrary flag
values, env entries and exception messages are never retained. Secret detection
records only a boolean. Acquisition/JSON errors have fixed named failure records.

The first failed check stops the trial and enters cleanup. Missing fields fail
closed instead of causing an anonymous TypeError. SecurityOpt accepts only the
bare enabled flag or explicit true representation, rejecting disabled, missing,
malformed or conflicting flags. Null/empty port bindings mean no published ports;
nonempty bindings still require explicit loopback host IP. Privileged must be
explicitly false. All previous restrictions and lifecycle requirements remain.

Cleanup outcomes are separate fields. A failed DELETE/close marks status failed,
preserves the inspection trace and continues remaining cleanup actions. Receipt
write failure also continues cleanup, then raises a fixed safe error. Successful
API cleanup alone never overrides an inspection failure or the outer supervisor's
independent process/container/network/secret checks.

## Decision tree for a separately authorized future run

1. **Preflight fails:** do not start service or driver. The subreaper gate now runs
   before source validation, Docker queries and credential/service creation. Setup
   and readback failures are recorded by the outer receipt. No new allocation is
   allowed by this document or by passing the offline tests.
2. **No SDK-ready event:** use bounded HTTP request categories/statuses and existing
   startup diagnostic categories; inspect policy is not yet verified. Do not infer
   execution or pause. Stop at the unchanged absolute deadline.
3. **SDK-ready, no inspect trace:** receipt persistence, abrupt termination or an
   acquisition boundary is unresolved. Do not infer a policy pass. Inspect the
   outer driver exit/cleanup receipt. A killed process or unwritable disk can still
   prevent evidence; these remain explicit inconclusive outcomes.
4. **Failed acquisition/count/shape:** list or inspect failed, owner count was not
   exactly one, or response was malformed. Do not diagnose SecurityOpt.
5. **First failed policy check:** use that named check's expected/actual summary.
   `container-id`, `state-status`, `owner-match`, `network-set`, `network-mode`, `cap-drop`, `no-new-privileges`,
   `privileged`, `mount-count`, `port-bindings`, `env-shape`, `api-key-absent`,
   `running` and `paused` are distinct. Unknown values are not silently accepted.
   SecurityOpt `explicit-enabled` is valid; disabled/invalid/conflicting forms are
   not. Do not copy arbitrary Docker content to diagnose a failure.
6. **Ready checks pass:** require command ID, complete success, UID 10001 and
   stopped command status/exit zero. Only then request pause; require a separate
   `paused` inspect pass before claiming pause succeeded.
7. **DELETE/cleanup:** require the existing independent container absence and
   outer process/network/secret checks. Any false/unknown result remains failed or
   cleanup-unverified regardless of prior successes. No retry or deadline reset.

## Process ownership and offline validation

Linux subreaper adoption is based on ancestry, not a PGID filter: this task's
supervisor can adopt only its orphaned descendants, not arbitrary unrelated
processes. It never scans or adopts another team's processes. Explicit waitpid
reaping remains restricted to the driver's exact PGID, after collecting its leader
status; other owned control groups retain their separate supervision. No global
waitpid or shared init/security change is made. The old PID-1-owned zombie remains
unreapable by this task; neither this change nor its tests upgrades old cleanup.

29 Python tests and 25 targeted TypeScript tests passed; standalone driver/test
TypeScript checking passed. Fixtures cover partial historical evidence, enabled
Docker forms, missing policy fields, restriction violations, redaction, acquisition
errors, paused-state evidence, cleanup failure and receipt-write failure. Python
failure tests additionally prove subreaper failure precedes validation, credential
directory creation and any live spawn. Tests use no Docker/API/control plane.
