# First three chronological W0 PRs

The selection is fixed before source acquisition: HTTPX PRs 3035, 3031, 3036,
ordered by the existing frame's mergedAt timestamp and then PR number. No title,
change, bug category or review outcome was used for selection.

The plan was locally committed at
`4f8921b94682c1c497d7340cabd8f8e1fe7d6a82`. Its initial GitHub push failed because
the saved cloud environment's Git authentication was unavailable. A read-only
check of our own repository with the existing gh connection returned HTTP 401
Bad credentials. No alternate credentials, connector or upstream access route
was attempted. No HTTPX content acquisition has started; all three remain
unattempted. Restore the existing cloud connection and publish the plan before
running the acquisition entry point.

The new entry point reuses `captureGithubPrEvidence`; no parallel source parser,
queue, database or mining implementation is introduced. The full batch shares at
most 50 GET attempts and a 300-second deadline. Any failure stops the batch without
replacing PRs. The existing collector's per-request and per-PR limits still apply.
Mock tests are synthetic control-flow checks, not captured source or labels.

Existing collector limitations are explicit: changed paths only; current PR and
non-atomic discussion observations; no historic feedback cutoff; no retained
base/head root-tree mapping; no automatic license retrieval. Raw successful
packages must remain quarantined until a license/provenance follow-up is complete.
They must not become rule inputs merely because acquisition succeeded. No W1/W2
source, diff, discussion, label or model-output endpoint is authorized.

The local remote-tracking check used by the CLI records the last push/fetch state,
not an independent preregistration timestamp or live remote attestation. A missing
remote plan reference must stop before any upstream GET. No model execution or
independent human annotation is part of this command.

## Implemented checks and remaining work

The selection plan's pinned LICENSE follow-up is not implemented by this adapter;
`licenseAcquisition` explicitly records that gap. Retaining base/head root-tree
identities also requires a minimal collector extension with its owner's agreement.
The whole current-observation package, including title/body/head, is quarantined,
not only discussion text. Restoring authentication does not remove these limits.

Validation completed offline: 9 targeted tests pass, covering HTTP 401/403/429/404
fail-stop, W1 and budget rejection, fixed selection order, zero-change retention,
shared 50-request exhaustion, identity drift and quarantine declarations. Running
the CLI with the local plan commit failed before acquisition with
`PLAN_PUSH_NOT_VERIFIED_NETWORK_CAPTURE_DISABLED`, as required. No evidence package
or capture-run directory was produced by that check.
