# Minimal matched evaluation contract

This profile reuses `createMatchedFixture` and `runMatchedRevision`. There is no
new inference backend, scheduler or dataset. Implementation base is
`90432743d2a8ff316aecf862e42c0613d35ff9a6`; research-design source is the
[primary-source paper revision](https://github.com/leixy2004/FlyReWheel/blob/7eb922bf91e4c5ee0fd1f51088ff6d2348597bec/paper/related-work-evaluation-gap.md).

## Run the authored smoke

```sh
node --import tsx experiments/matched-revision/contract-replay.ts \
  --authored-smoke /tmp/flyrewheel-contract-smoke-new
npx vitest run tests/matched-revision.evaluation-contract.test.ts \
  tests/matched-revision.experiment.test.ts --maxWorkers=1
npx tsc --noEmit
```

Use a new output directory. The command writes contract, packet, future and report
JSON through the existing exclusive-write helper. Every source, label, diagnosis,
proposal and prediction comes from the existing authored fixture; no model or SDK
process is invoked, no repository/dataset downloaded and no labels inferred.
`scientificConclusion` is always `not_estimated-authored-mechanics-only`.

## Smallest supported fair comparison

Keep the existing four arms. H−U isolates the declared hard edit policy under the
same supplied diagnosis and common gate; M is the required practical memory
comparator; F is the no-maintenance reference. Removing M would evade the strongest
memory alternative, while removing F hides whether updating helped at all. These
are controlled local adapters, not reproductions of ACE or Self-Refine. The separate
stateless reviewer and suppression-only families in the paper are deferred auxiliary
checks; unavailable external services never fall back to this authored transport.
`mode: production` returns `not_run: production_adapter_unconfigured` before dispatch.

A single frozen settings object binds revision/reviewer model names, sampler,
response schemas, context/state and output ceilings, call/time/token/cost limits.
All arms review identical targets; only persistent state differs. U/H/M receive one
proposal slot, F none. The smoke consequently invokes 2 transport calls for F and
3 for each updating arm, **zero model calls throughout**. Equal ceilings are not
equal consumed resources. The report includes actual rendered persistent bytes;
M carries audit-only initial text and delta overhead, so this is not a claim of
representation-neutral effective capacity or validated M competence.

The existing ledger retains declared usage, conservative UTF-8 fixture token counts,
upstream standalone diagnosis accounting, failures and unknown costs. It rejects
unknown/exceeded usage after a return and blocks later dispatch. It is **not** a
provider billing meter or a pre-dispatch hard monetary quota. Fixture zero cost is
an authored value, not evidence that real review is free. Construction/retrieval
are not run; full real-experiment accounting remains a prerequisite.

## Input and temporal boundary

The strict contract binds the packet, future roster, settings, entire common
revision block, every full gate/future-review input (including evidence text), and
a separate scoring-label digest. Lists must match exactly, including order and
cardinality. Future labels are sent only to the existing scorer; review requests
contain target inputs and state. Tests compare actual transport requests, schemas,
models, samplers and caps across arms and check no future source/label digest reaches
proposal prompts. Contract and input clones prevent caller mutation during awaits.

The smoke assigns synthetic availability declarations to the revision cutoff or
future-start boundary. It verifies development declarations ≤ cutoff, cutoff <
future start, future declarations ≥ start and episode freeze ≤ cutoff. Future start
is a lower bound, not a complete historical window. These are machine-checkable
**authored declarations**, not independently observed timestamps. The existing
packet validator also checks source/lineage overlap and frozen obligations.

The trusted assembler must preserve the externally locked contract digest. Rehashing
only an altered packet or outer envelope cannot bypass the exact allowlists. An
actor who deliberately rewrites all inputs and all contract bindings can create a
new self-consistent contract; this code cannot authenticate chronology, remove a
hidden answer from arbitrary prose or certify pretraining decontamination. No claim
of historical replay, data sandboxing or semantic annotation validity follows.

## Outcomes and anti-silence check

The existing scorer now reports `repeatedFeedbackStrictResolution` and
`repeatedFeedbackCoverage` on L_mech alone, alongside its false-alarm rate. H−U and
H−M report all three paired differences plus positive recall. A targeted test keeps
positive recall perfect while abstaining only on L_mech: its false-alarm rate is
zero but strict resolution/coverage are zero, even if other legal cases resolve.
Empty denominators remain `not_estimable`; Unknown references and all failed/not-run
targets stay visible. No threshold, p-value, statistical noninferiority or success
classifier is manufactured. This single fixture episode does not implement the
future study's family macro-aggregation or uncertainty analysis.

## Exact real-experiment prerequisites

1. Authorized real model adapters with pinned models/tokenizers, provider admission,
   usage settlement, and construction/retrieval/diagnosis/gate/review cost accounting.
2. A genuine W0 rule/family, locked W1 inputs/findings/feedback and supplied or inferred
   diagnosis; two independent qualified human reference judgments plus adjudication.
3. Independent W2 positive and mechanism-relevant legal opportunities, with frozen
   membership, target scope, source/lineage audit and Unknown/zero-yield accounting.
4. Verified experimental lock/exposure controls. Historical-public-visibility proof
   is additional only for optional as-of claims; current-capture must be labeled so.
5. Frozen effect/recall/strict-resolution safeguards, aggregation and uncertainty
   design, plus development-only evidence that M is a competent adaptation.
6. Explicit task adapters and licensing/data/model pins for external implementations;
   reading an official README or running this smoke does not supply them.

The six retained actual W0 exports remain separate and unchanged. Their successful
blocked bridge checks do not convert them into eligible authored episodes. This
branch changes no production enablement, shared CLI registration or paper metadata.
