# Outstanding work on main

Updated 2026-10-23. This is the active backlog migrated from GitHub issues
[#2](https://github.com/leixy2004/FlyReWheel/issues/2) and
[#3](https://github.com/leixy2004/FlyReWheel/issues/3).
Their closure is tracking consolidation, **not feature completion**. Checkboxes
below remain open until the stated evidence exists. No deployment, real-model
call, new source acquisition or frozen W1/W2 inspection is authorized by this file.

## Runtime loop — migrated issue #2

Implemented scaffolding includes explicit worker bootstrap, pinned module checks,
workspace identity validation, bounded output handling and recovery paths. Mock,
authored-process and historical no-model checks do not verify a live model route.

- [ ] Document and verify one supported isolated deployment/model route with exact
  remaining operator inputs: endpoint, model/version, effective settings, runtime
  identity, approved credentials and resource/cost limits. Do not guess values.
- [ ] With separately authorized access, verify repository commit/workspace identity,
  delivery, lifecycle, cleanup, output validation and failure handling in that route.
- [ ] Produce one real review → feedback → revision → comparison artifact chain,
  retaining evidence, effective settings, elapsed time and observed usage. Unknown
  monetary cost must remain unknown; mocks cannot satisfy this acceptance gate.
- [ ] Reconcile runtime receipts and cleanup evidence after interrupted execution.

Owner/dependency: runtime operator and explicit model/runtime authorization remain
unassigned/pending. See [runtime next steps](runtime-integration-next.md) and
[worker bootstrap](worker-application-bootstrap.md). Current task does not run them.

## Temporal pilot and paper — migrated issue #3

Offline construction parsing, authored screening and episode locks, development
annotation tooling, matched contracts and descriptive macro reports are implemented.
None supplies real independent labels, eligible empirical episodes or efficacy.

- [ ] Audit/freeze repository, chronological windows, complete sampling/provenance
  manifest, exposure history and budgets before outcome inspection. Preserve all
  exclusions, zero-yield, failed and not-run samples. Do not inspect restricted
  remaining sources or W1/W2 to fill gaps.
- [ ] Bind the permitted W0 source packets and retained attempts to authenticated
  construction/rule/family locks before W1 exposure. Independently assess compound
  invariants, applicability, scope and support; no replacement after rejection.
- [ ] Assign two independent human annotators and an arbitrator, release common
  neutral packets under the frozen protocol, and retain missing/unknown/disputed
  judgments. Authored submissions are not human ground truth.
- [ ] Obtain independently verified W1 feedback/diagnoses and independent W2
  opportunities; exclude development, repair, duplicate and backport lineages.
- [ ] Compare F/U/H/M under matched evidence, effective settings, resource accounting
  and a common gate; establish memory-baseline competence without claiming local
  adaptations reproduce external systems.
- [ ] Freeze false-positive, missed-positive, unknown/coverage and cost denominators,
  family/episode aggregation and uncertainty. Report feasibility yield before any
  larger study or efficacy claim; audit manuscript claims against actual results.
- [ ] Audit study identity, registry durability and independently authenticated
  exposure/lock chronology before enabling a real construction executor.

Owner/dependency: study lead, independent humans, permitted sources and separately
configured execution remain pending. See [construction status](../paper/construction-execution-status.md)
and [research protocol](../paper/experiment-protocol/README.md).

## Governance verification boundary

Only the selected saved cloud workspace and current GitHub refs were inspected.
The inaccessible old task environment was not accessed or bypassed; uncommitted or
unpushed changes there cannot be certified. Historical evidence files are retained
as history, not rerun or promoted to current operational evidence. See the
[branch audit](repository-governance-2026-10-23.md) for old SHAs and dispositions.
