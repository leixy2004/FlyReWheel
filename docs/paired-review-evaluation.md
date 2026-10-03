# Offline paired semantic-review evaluation

This is a **descriptive offline scorer**, separate from the v1 promotion evaluator and the selected-feedback revision comparator. It consumes frozen semantic-review outputs and a separately supplied annotation manifest. It does not call a model, a scanner, GitHub, a database or an annotation service, and does not activate rules. The demonstration's labels and predictions are deliberately co-authored synthetic inputs; separate files do not make them independent.

## Run the authored counting oracle

```sh
npm run build
node dist/cli.js evaluation demo --directory /tmp/flyrewheel-paired-demo
node dist/cli.js evaluation score \
  --dataset /tmp/flyrewheel-paired-demo/dataset.json \
  --annotations /tmp/flyrewheel-paired-demo/annotations.json \
  --runs /tmp/flyrewheel-paired-demo/runs.json \
  --out /tmp/flyrewheel-paired-replay.json
```

Both paths must be new. Output files use exclusive creation and mode `0600`; the demo directory uses `0700`. Existing artifacts are never overwritten. A new annotation revision, run, policy or dataset produces a new content-bound report identity. Filesystem exclusivity is not durable WORM storage, provider attestation, or protection against someone editing a file later: keep and verify the digest. The API revalidates each input on every invocation. Retain **all three frozen input files alongside the report**: detailed annotation reasoning/support digests and coverage reasons remain in the bound annotation manifest.

The known oracle has two authored PRs and one family. Five positive issue instances include a two-anchor duplicate, an unresolved positive and a positive in a deliberately failed/not-run unit. Both arms find two instances and miss three. Candidate false-alert instances fall from one to zero, but it also loses one formerly detected positive and gains another. These exact authored counts test accounting only; they are not measured review improvement. Unmatched, unknown-label, disputed-label and excluded-label alerts remain visible. The first target remains unknown despite supported local anchor decisions.

## Three versioned manifests

The strict TypeScript/Zod contracts are in [core/paired-evaluation.ts](../src/core/paired-evaluation.ts). The generated demo is a complete example. Unknown fields, unsupported schema versions, malformed digests, non-finite numbers and structural inconsistencies are rejected.

1. **Dataset** freezes the protocol digest, sampling population/frame/selection declarations, frame gaps, temporal visibility/history exposure and isolation manifest, PR repository/number/checkpoint/source bytes, split/lineage/inclusion probability and family definition/mapping. One checkpoint per repository + PR number is supported. The entire PR × family product is the evaluation roster, including units with no labeled instances. Different package metadata cannot create a second copy of the same PR. Families freeze eligible rule IDs before run inspection; semantic family correctness remains a declaration
2. **Annotations** bind the exact dataset digest and rubric. Every roster unit explicitly declares complete, partial, unassessed or excluded coverage. Each issue has a stable ID and lineage, exact source anchors, explicit positive/negative/unknown/disputed/excluded label, reason and supporting digests. Multiple anchors in one issue count once. Duplicate issues/lineages within a PR/family and shared exact anchors across issues are rejected. Supplied anchors must validate against captured bytes, side, path, digest and UTF-16 positions
3. **Runs** bind the dataset and baseline arm, exact method policy/version/digest, declared model/provider/version/configuration, information/tool/retrieval manifests, and a total construction + maintenance + review budget. Each supplied unit freezes a v2 rule version and either a complete semantic review or an explicit abstained/failed/not-run state. No v2 record is forced into the old v1 detector evaluator. Missing unit records remain visible and prevent a complete paired comparison

Annotation origin is one of `synthetic`, `local-human-declared` or `adjudicated` for the entire manifest. Different origins require separate reports; no silent mixed-origin pooling occurs. Adjudicated declarations need at least two named author IDs and supporting digests, but **neither identities, independence, blinding nor adjudication are authenticated**. Two named authors are a structural minimum, not proof of the Phase 0 double-label/arbitration process. The scorer never creates labels from a comment, merge, approval, resolved thread, model decision, code modification or silence.

Positive/negative labels concern the frozen family definition at the exact checkpoint. A negative must be independently justified as safe-applicable or a legitimate exception under that definition. A claimed contract change is not automatically a negative. If applicability, contract routing, issue identity or correctness is unsettled, use unknown/disputed/excluded with a reason; do not relabel after seeing which arm wins. This is a separate effect-evaluation manifest, **not an automatic conversion of the observational Phase 0 annotation schema**.

## Deterministic scoring

Algorithm version: `exact-anchor-issue-paired-v1`. The full parsed input manifests are hashed with the existing canonical JSON implementation. Report identity binds these digests, scorer version, all bindings, counts and limitations. Input order is part of manifest identity; reusing exactly the same files produces exactly the same report. The compiled smoke freezes the demo identity as a compatibility check; changing scorer behavior requires a new explicit version rather than retroactively changing old results.

A finding matches only when the PR, family and **entire** snapshot/side/path/source/span identity match an annotation anchor. There is no substring, overlap, nearby-line, fuzzy or model-based matching. A plausible but shifted anchor is unmatched until the independently maintained rubric/manifest supplies that admissible anchor. Before-side annotations can remain missed because current semantic findings are after-side only.

- `usefulInstances`: positive issues with at least one exact `violation` finding. Two violating anchors on the same issue add one instance; `usefulAlertAnchors` and `redundantPositiveAlertAnchors` expose the extra alert burden
- `falseAlertInstances` / `falseAlertAnchors`: negative issues alerted and number of their distinct alert anchors. Repeated alerts on one known negative remain burden while the instance is counted once
- `missedPositiveInstances`: every positive without an exact violation, including safe, unknown, not-verified, unsupported, failed, missing and not-run outcomes. Denominators do not shrink to executed or adjudicated cases
- Unknown, disputed and excluded labels have their own counts and alert counts. Unmatched alerts are unjudged, never automatically false positives. Unmatched safe/unknown/not-verified findings also stay visible
- `knownNegativeWithoutAlertInstances` means no alert, not verified safety. `explicitSafeInstances` requires independently explicit safe judgments at **every** annotated anchor. Legacy whole-target safe propagation does not establish anchor safety
- Target coverage, excluded/deleted/out-of-scope/unsupported targets, incomplete scans, execution gaps and exact-anchor uncertainty are distinct counters. Known local anchors can coexist with unknown whole-target coverage

Each arm reports totals and per-PR, per-family and per-split counts, plus every annotation instance outcome and finding-to-instance match. There are no percentages, statistical tests, confidence intervals or automatic promotion decisions. Counts from partial annotation measure only supplied known instances, not exhaustive recall over all defects. Cross-PR repeated lineages are flagged when explicitly declared; semantic dependence is not inferred or statistically corrected.

## Pairing and internal consistency

Candidate-minus-baseline deltas and positive-gained/lost/preserved/missed and false-alert-added/removed/preserved transitions are emitted only when:

- Full fixed PR × family run rosters are present (explicit failed/not-run states are allowed and remain in denominators)
- The complete declared model, information and total-budget objects match exactly
- Neither arm's declared aggregate usage nor a frozen receipt usage lower bound exceeds the shared budget

Differing policies/rule versions are the intended intervention and remain explicitly bound. Missing runs or mismatched common conditions produce `incomparable` with reasons and no deltas/transitions; both arms' raw counts remain available. No overlap-only subset is silently substituted.

Existing semantic validators rederive the rule/snapshot/review graph without rerunning detection or a model. Imported workspace receipts do not become authenticated runtime evidence. Nevertheless, internally known contradictions are rejected: model execution/name must agree with the review; workspace information access/history must agree with the validated full-repository/all-local-refs contract; declared aggregate token/call usage cannot be below distinct receipt lower bounds. Those lower bounds do not measure all construction/maintenance costs or every internal model call. Receipt input/output token fields are not combined with cached/reasoning token fields by an invented accounting convention. Full raw usage and receipt bounds remain in the report.

Null `totalUsage` means unmeasured, not zero/free. Shared ceilings and information descriptors prove only declaration equality, not actual equal expenditure or identical hidden prompt contents. Warnings expose missing blinding/independence/checkpoints, frame gaps, future-history exposure and declared time-window contradictions. Nothing in this scorer proves historical availability, statistical independence, lineage separation or absence of pretraining contamination.

## Bounds and failure behavior

Per input: dataset 16 MB, annotations 4 MB, runs 32 MB. Report/output: 16 MB including formatted-file check. At most 25 PRs, 8 families, 4 arms, 200 roster units per arm, 2,000 annotations, 20 anchors per annotation and 20,000 aggregate findings. Existing per-snapshot/per-review limits still apply. Reads use nonblocking descriptor open, require a regular file, cap bytes before JSON parse, reject invalid UTF-8 and never silently truncate. Output is withheld on validation failure. No import mutates a store or establishes a global logical-ID registry; identical logical IDs with different content produce different manifest/report digests, and the operator must preserve their version history.

## What still has to happen for the paper

1. Freeze actual repository/PR sampling frames, development exclusions, budget, label rubric and family definitions before reading effect outcomes; the Phase 0 proposal is not yet such a sample
2. Reconstruct audited as-of snapshots/objects/discussion visibility, then obtain independently blinded labels and adjudication, retaining unknown, preexisting, excluded and missing cases
3. Produce frozen outputs for matched no-history/raw-history/length-matched-summary/conditional-rule arms, then matched frozen-rule/raw-feedback/generic-reflection/diagnosis-policy arms as the hypothesis requires
4. Inspect useful findings, alert burden, missed positives and coverage together. This tool can summarize those supplied outputs; it cannot make the sample representative or demonstrate an update caused an improvement
5. Choose any uncertainty model from the actual sampling/cluster design and preregister it before final outcomes. No significance test has been assumed or added here

The current evidence supports a reproducible evaluation **mechanism**, not H1/H2, diagnosis truth, semantic efficacy or a novel scientific result. See [Phase 0](../paper/phase0-protocol.md), [methods](../paper/method-draft.md), [claim checklist](../paper/claim-evidence-checklist.md) and the [verification record](evidence/paired-evaluation-verification-2026-10-02.txt).


### Context-aware evidence matching

Runs containing selected repository-context reviews use the descriptive scorer
`exact-anchor-context-issue-paired-v2`. Each scored unit retains its exact canonical
context digest set (an empty report set means no selection), including explicitly
pinned selections on failed/not-run units. Completed units must agree with their
frozen review's selected set. Unequal baseline/candidate context sets make the
comparison incomparable with null deltas/transitions. Legacy snapshot-only runs
keep their original scorer and byte-identical report derivation. Package integrity,
head matching and declared role names do not establish label truth, historical
availability, complete context or efficacy. See [context integration](repository-context.md).
