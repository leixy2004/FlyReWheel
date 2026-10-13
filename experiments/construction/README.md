# Offline construction configuration and authored replay

This module validates construction configuration and demonstrates consumed slots,
failed attempts and deterministic candidate retention without login or network.
It is **authored development mechanics only**, not an empirical freeze, a real
constructor, source eligibility judgment, model run or independent annotation.
The existing working checkout was 17879c1; earlier methodology branches were not
present locally and are not assumed integrated.

`contracts.ts` provides a strict Zod configuration schema. It binds repository,
protocol/instructions, constructor version, ordered unique roster, source packet
digests, exposure declaration and resource limits. Unknown model/provider/version/
seed/decoding values remain `constructor.kind=unconfigured` with explicit missing
fields. Only an authored-fixture constructor and origin can freeze here. A fully
filled model configuration still cannot execute; there is no network/model adapter.
The first remaining source exposure must follow the configuration freeze; W1
exposure blocks it. Declared timestamps/digests are not authenticated exposure proof.

`runner.ts` accepts authored receipt objects only. Each submitted PR must form an
ordered prefix of non-rejected roster slots, with no duplicate or replacement.
A completed empty proposal is `no_rule`; no supplied receipt is `not_run`; an
interruption or malformed candidate is `failed`. Every raw receipt survives in
`inputs.json`, including failed runs; cap-excluded candidates stay in the report.
Byte limits are enforced. Token and time limits are declared for a future executor,
not measured or claimed enforced by this object-only replay.

Candidates sort by UTF-8 path, before/after side, line span, then canonical digest.
Only the first is retained provisionally. Family keys bind repository and semantic
fields but establish neither independence nor semantic equivalence. This minimal
module does not audit compound rules, prove spans against actual file bytes, parse
raw JSON with duplicate-key rejection, independently screen candidates, deduplicate
families or select W1 episodes. These gates must be implemented before empirical use;
no candidate is marked admitted. Existing core canonical JSON is reused.

An exclusive run directory is a consumed attempt marker. It is never overwritten.
A failed run saves `failure.json`; abrupt termination may leave only a reservation
or inputs. Preserve such interrupted directories, do not delete and retry them as
if they never happened. This is local evidence integrity, not cross-directory
exactly-once execution, authenticated timestamps or a tamper-proof audit trail.

## Reproduce without network

Run from repository root with existing dependencies. Use new output paths:

```sh
node --import tsx experiments/construction/replay.ts authored /tmp/construction-example
node --import tsx experiments/construction/replay.ts verify /tmp/construction-example
node --import tsx experiments/construction/replay.ts draft /tmp/construction-draft.json
node --import tsx experiments/construction/replay.ts check /tmp/construction-draft.json
npx vitest run tests/construction-freeze.test.ts --maxWorkers=1
npx tsc --noEmit
```

`check` exits **2** for the intentionally blocked draft. The generated draft uses
explicit authored placeholder roster/digests and `UNCONFIGURED` repository; it is
not the HTTPX cohort or an execution configuration. `authored` uses a fixed synthetic
clock and two invented PR IDs solely for reproducibility. `verify` recomputes the
report and checks reserved inputs, freeze binding and output digest without writing.
It cannot authenticate who originally wrote the artifacts.
