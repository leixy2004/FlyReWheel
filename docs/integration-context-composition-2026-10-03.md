# Context and composition integration candidate

This candidate starts from main `e79954c888f5bffb2cf99283e76d3a90e46bd46c`
(the user-approved PR16 merge). PR20 stays frozen at
`0b476d9f6835fec63b3b924c0de3120d3c79922f`. PR24's first published checkpoint
was `37d31a2e2ab360fbb99ef3a81b5e51b30e152ffa`; tests against that checkpoint
must not be attributed to later heads. Main is not merged by this integration.

## Fixed inputs

| Input | Commit | Boundary |
| --- | --- | --- |
| PR20 W0 preparation | `0b476d9f6835fec63b3b924c0de3120d3c79922f` | Historical hosted 104 files / 1734 tests; same-tree synthetic merge `ed18074c33eb96721a69aaf6782ae56f8a0777a4`. No new-main-base rerun was observed at reconciliation. |
| PR21 full committed context | `dfee04c00674371551153c71c02473b2205a44de` | Six exact-SHA exports, 114 committed files each. Source availability is not model or historical-visibility evidence. |
| PR22 application operations | `1bc2afffdd28c5ebde64f81e39944d816fdca8f7` | Offline operations and injected composition; no default deployment authority. |
| PR23 behavior failures | `ce9b9fbfc3abf5d1d542652e0b19ca01fca8e4fc` | Original missing docs wheel and Ruff launch failures retained; zero effective paired behavior results at this head. |
| PR25 Ruff retry | `a7adb0ee4c86fd6e72f5a1327ff2ac0e0a8ec760` | One subsequent bounded before/after lint+format pair passes. No effectiveness or defect label. |
| Preparation cleanup | `a5784fc` | Local PGlite failure injection verifies primary-error preservation and single close of released handles. |
| Paper method/artifact map | `6afdf2b` | Hypotheses, comparators, cutoffs and denominators mapped to implementation and missing evidence. |

## Cleanup correction and verification

`QualEvoStore.initialize` already closes its database when migration fails. An
earlier concern that initialization before try/finally itself caused a leak was
not established. The actual defect was a failed reopen leaving the old closed
store in finally, with a second close potentially masking the primary error.
Cleanup could also mask an import error. The correction explicitly releases
ownership before close/reopen and preserves an already-thrown operation error.
A cleanup-only error still fails the operation and prevents a completion ledger.

Two regression tests failed before the fix (2 failed / 2 passed), then passed.
The final focused suite passed 5/5 locally in 12.16 seconds and independently in
13.21 seconds. These run a real local PGlite database with authored failure
injection. They do not test real PostgreSQL or prove that a close failing before
resource release cannot leak. The adapter's waitReady path was not changed.
Typecheck/build passed with the final cleanup-only test included; full candidate
validation must still be recorded against its exact head.

## W0 evidence boundary

PR25 saved-artifact review verified 11 manifest entries, identity fields, binary
hash consistency and six successful commands. Source mutation guards are reported
by the saved run, but the per-file 114-entry manifest was not retained and the retry
script does not revalidate export Git identity. Independent review cannot
reconstruct every source-file-to-tree binding from PR25 alone. This non-blocking
reproducibility limitation remains; no new acquisition or retry was performed here.

The mkautodoc 0.2.0 sdist received hash/static inspection only. Documentation and
external-action behavior remain unknown. Model results and independent human
labels remain zero. The fixed API acquisition ledger remains 48/50; separate Git,
image and package traffic must not be counted as those API requests. One passing
Ruff pair does not establish rule yield, semantic eligibility or scientific effect.

## Separately pinned runtime experiment

The external runtime lane's [fixed experiment record](https://github.com/leixy2004/FlyReWheel/blob/9d79a9f610af7e9c5a18986d3dd6dd280d85a810/docs/evidence/opensandbox-live-2026-10-03/README.md)
reports HTTPS health/401 checks and one actual worker create/start, followed by
SDK readiness timeout before command or pause. Cleanup was independently checked;
the retrospective total live window was 265.819 seconds. No model call occurred.
Complete lifecycle, frozen reads, fencing and production authority remain unproven.
This candidate references the record without importing the runtime branch's later
control-plane implementation or authorizing another allocation.

The default worker still needs explicitly configured trusted capabilities. The
separate deployment-bootstrap owner retains that implementation. No credentials,
model execution, security relaxation or main merge is part of this candidate.

## Pending PR26 correction

PR26 `9b6789fcf746e25bd0bc98476ba75cb58975dd40` is not integrated yet.
Independent authored-runtime tests passed 44/44, but an additional EOF-delay probe
showed execute accepting output after stop/collect/destroy had verified completion.
The [owner handoff](https://github.com/leixy2004/FlyReWheel/pull/26#issuecomment-5974726590)
contains the reproducer and requests a final active-state check. This is an adapter
boundary finding; no actual dispatcher persistence or real-model effect is proven.
An owner-corrected snapshot must be reviewed before inclusion and final full-suite
validation. Meanwhile, the pre-PR26 local checkpoint `ea094e4a64e792ece0738d2f568fe45143e112b9`
passed typecheck/build and 30 targeted tests across six files. These are authored
fixtures/local PGlite and local Git checks, not real PostgreSQL or model execution.
