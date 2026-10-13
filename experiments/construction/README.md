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

The authoritative register is `.construction-attempts/` relative to this module's
checkout, independent of cwd/output directory, with no CLI path override. Repository
identity binds exactly one freeze; each PR binds an immutable original receipt.
Changing output directories or copying reports cannot register a different receipt.
Exact receipt replay is allowed without a new construction. Invalid bound receipts
consume their identified slot; later corrections are rejected. Every registered
slot must appear in a current report, including failures. `replay()` alone is a pure,
unregistered authored projection; only `writeReplay`/`verifyReplay` use the register.

A run reserves its slots before computing its report. A process interrupted after
reservation can recover only those exact stored receipts. Missing/partial or corrupt
registry files fail closed; they are not silently deleted or repaired. Output
folders use exclusive creation and preserve failure records. As the registered
prefix grows, verification rejects older shortened projections; recover the complete
current prefix instead of concealing later failures.

This is a local trusted-filesystem guarantee, not an authenticated distributed
registry. Changing repository aliases, copying the whole checkout/registry, deleting
records as their owner or modifying code is outside the guarantee. A cohort lock serializes registration/verification; busy or interrupted locks are
never automatically taken over. A crash while holding that lock needs an explicit
operator integrity audit before any lock removal, not a new output directory.
Completed registrations can be recovered automatically after report interruption.
Atomic exclusive file creation also prevents competing receipt replacement. There is no fsync power-loss durability claim.
`authored/` repository names are required for authored freezes, while real-source
and model configurations remain blocked. Names and declarations cannot authenticate
whether maliciously relabeled bytes are synthetic. No output grants empirical admission.

## Reproduce without network

Run from repository root with existing dependencies. Use new output paths:

```sh
node --import tsx experiments/construction/replay.ts authored /tmp/construction-example
node --import tsx experiments/construction/replay.ts verify /tmp/construction-example
node --import tsx experiments/construction/replay.ts recover authored/example /tmp/construction-recovered
node --import tsx experiments/construction/replay.ts draft /tmp/construction-draft.json
node --import tsx experiments/construction/replay.ts check /tmp/construction-draft.json
npx vitest run tests/construction-freeze.test.ts tests/construction-registry.test.ts --maxWorkers=1
npx tsc --noEmit
```

`check` exits **2** for the intentionally blocked draft. The generated draft uses
explicit authored placeholder roster/digests and `UNCONFIGURED` repository; it is
not the HTTPX cohort or an execution configuration. `authored` uses a fixed synthetic
clock and two invented PR IDs solely for reproducibility. `verify` recomputes the
report and checks reserved inputs, freeze binding and output digest without rewriting evidence (it briefly acquires the cohort lock).
It cannot authenticate who originally wrote the artifacts.

## Authored episode selection

`episode-selection.ts` adds a two-stage offline selector: `selectIndices` first
binds the complete authored plan and all review cells, then `selectEpisodes` accepts
separately bound synthetic feedback. Cells bind plan, rule and packet digests;
duplicate exact-rule families and replacement cells are rejected. Missing/malformed
earlier work blocks an index, and Unknown feedback cannot select a later finding.
All raw cells, later findings and missing matrix entries are retained. Digest locks
are reproducible pure objects, not permanent cross-call registration or proof of
actual exposure times. There is no empirical execution path.

```sh
node --import tsx experiments/construction/episode-replay.ts /tmp/authored-episode-example
npx vitest run tests/episode-selection.test.ts --maxWorkers=1
```

The demo saves `index-lock.json`, `feedback.authored.json` and `episode-report.json`
in a new exclusive directory. Synthetic PR 2 is selected; synthetic Unknown feedback
blocks the episode despite a later finding. Repeating this demo is a software test,
not an additional independent experiment. It never reads real W1 or source files.
