# Local research execution closeout

Base checkout: `17879c1`. Branch: `codex/offline-construction-freeze`.
All work below is local; no push/publication, authentication, model call, real W1
read, new upstream source acquisition or independent human label occurred.

## Feature commits

| Commit | Independently delivered change |
| --- | --- |
| `1e759b66f3180d3890559c535d83c7c80cab8d83` | Strict configuration, authored freeze, offline construction receipts and failure records |
| `51c66efd29129b2c37be677fddad5627a3a4f807` | Persisted report verification and study limits |
| `71d4add5f6cd09ed10f63de53b1382db1f989951` | Fixed construction register, cross-output-directory replacement refusal and recovery |
| `bd83322de331957f41b8de396e187b39d781b842` | Deterministic first-index selector and separately bound authored feedback |
| `96631f040cc45ebf9e6e5771d4188f603b5a6665` | System method, failure accounting and empirical boundaries |
| `cbdb5c5446c4f714d07943f563b31152bcc6e2e7` | Persistent index and final-feedback registration, immutable-request recovery |
| `4a7fff140b66dd76ed992d2d01cce2acab83f584` | Combined validation and boundary matrix |
| `988e319c8f88830fdf00d97e6e6bc3b082e9c2ba` | Authoritative construction-to-episode family provenance |

## Completed versus incomplete

| Capability | Status | Exact boundary |
| --- | --- | --- |
| Configuration schema and freeze binding | Completed for authored inputs | Real-source/model configurations are blocked; declared time is not authenticated |
| Once-per-PR construction receipt | Completed within fixed local registry | Exact replay allowed; aliases, other checkouts and owner tampering outside guarantee |
| Ordered roster, missing/failed attempts | Completed structurally | No automatic semantic support or actual source-span validation |
| Candidate cap and deterministic ordering | Completed structurally | Compound-rule assessment and raw duplicate-key parser still missing |
| Cross-call index and feedback freeze | Completed within fixed local registry | Changed plan/cells/time/feedback refused; finalized missing/Unknown cannot be replaced |
| Crash recovery | Completed after intact reservation | Derived artifacts can be reconstructed; corrupt bytes/leftover lock require integrity audit |
| Neutral opportunity/source annotation | Not completed empirically | No actual independently enumerated and labeled cohort |
| Construction-to-episode family provenance | Completed for authored retained candidates | Complete construction report/freeze and all retained family members checked against authoritative registry; independent semantic admission remains absent |
| Independent semantic output-support assessment | Contract described, not executed | Citation hashes alone cannot establish support |
| Persistent authenticated study identity/exposure | Not completed | Local hashes and namespaces detect mismatches, not falsified declarations |
| Real model/runtime and resource accounting | Not configured | No guessed model, credential changes or claimed token/time enforcement |
| Real efficacy or independent labels | None | Synthetic validations are software evidence, not empirical observations |
| Method manuscript and explicit threats | Completed development draft | [System method](construction-and-episode-method.md), no efficacy claim |

The registries remain separate stores but are now connected: every episode selection
and recovery replays the authoritative complete construction roster and verifies
exact family members plus report/freeze digests. No caller-supplied family bypasses
this check. Independent semantic admission cannot be inferred from this connection.

## Combined validation

Executed successfully on the combined local implementation:

```sh
npx vitest run tests/construction-freeze.test.ts tests/construction-registry.test.ts tests/episode-selection.test.ts tests/episode-registry.test.ts tests/family-provenance.test.ts --maxWorkers=1
npx tsc --noEmit
git diff --check
```

Result: **5 test files, 34 tests passed**, TypeScript exit 0, clean diff check.
The tests cover altered configuration, duplicate/reordered attempts, mismatched
source bindings, candidate exclusions, report alteration, copied outputs,
immutable reservations, omitted slots, locks, interrupted output recovery, first
finding selection, missing earlier cells, unknown/missing feedback, altered plans
and malformed persisted records. They do not establish empirical causality or
resilience to a malicious filesystem owner.

The CLI demo and registered recovery both completed, preserving synthetic index
PR 2 with blocked feedback; exact index digest:
`825182bb8fd89fa81328040a163c4238ef1089ee61eb526b3a0489e39a129af3`.
The synthetic report digest remained
`b7d73b7197e4c052f323f6d64ba781806b09a09261cac5a94926652dc9c69975`.

Independent reviewer `identity_audit` performed a final static review of schemas,
construction registry/runner, episode selector and episode registry. It found no
remaining blocker within the stated authored/local scope, confirmed real-source
blocking and no-replacement recovery, and initially identified missing construction-to-episode provenance. That specific
connection is now implemented and separately reviewed. The reviewer confirmed
complete-cohort replay, retained-only family derivation and member/hash matching,
while distinguishing provisional candidates from independent semantic admission. The reviewer did not rerun
tests, access the network, read W1 or edit files. This closeout adds documentation,
not another mechanism or an authorization to begin empirical execution.
