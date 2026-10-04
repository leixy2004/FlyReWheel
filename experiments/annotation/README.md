# Local blinded annotation and adjudication

This source CLI makes the existing two-rater/third-adjudicator protocol executable
for **predefined source opportunities in development material**. It reuses the
paired evaluation dataset, annotation labels, coverage states, snapshot anchors
and pure annotation validator. It never runs a model, scans for issues, contacts
annotators, acquires source or writes application feedback.

No human is assigned by this change. Tests use authored responses and explicitly
synthetic identities. They are not human labels, agreement results or efficacy
measurements. The working pipeline is narrower than a full empirical protocol:
no holdout release, historical as-of admission, free-discovered issue alignment,
second-pass outcome exposure or automatic matched H2 label conversion is supplied.

## Run the blank authored example

```sh
node --import tsx experiments/annotation/replay.ts init-authored \
  --out /tmp/annotation-example
node --import tsx experiments/annotation/replay.ts status \
  --workspace /tmp/annotation-example
```

The output directory must be new, with existing real parents, outside Git
worktrees. The command writes **blank responses only**, with null timestamps,
exposure declarations, judgments and reasons. It does not complete those forms.
Its synthetic participants are explicitly test identities, not assigned people.
The same CLI operates on an authorized supplied plan and assignment:

```sh
node --import tsx experiments/annotation/replay.ts export \
  --plan /private/plan.json --assignment /private/assignment.json \
  --out /private/new-annotation-workspace
```

The exact strict input schemas are in `contracts.ts`; `fixture.ts` demonstrates
shape only. Do not rename synthetic material as human or empirical input.

The plan pins the existing dataset, source snapshots, source observation cutoff,
actual capture declarations and capture-record digests. Each rubric must match
its family definition digest. Every source opportunity includes exact after-side
snapshot anchors fixed independently of evaluated outputs. The allowlist includes
only the full captured files containing those anchors. This is a predefined
opportunity exercise, not a claim of exhaustive defect discovery or a restriction
to changed-surviving lines. A separate source-only audit declaration binds the
rubric/scope and absence of outcome material. Hashes and timestamps are traceable
local declarations; they do not establish historical visibility or authentic audits.

Real-input plans must use current-capture **development** material. Synthetic plans
stay synthetic. Before-only drafts, as-of/unknown visibility and holdout datasets
are rejected. The retained HTTPX W0 drafts remain blocked: they contain before-side
material and lack the substantive rule/rubric and release evidence for a formal
head-review task. Their present discussion or merge outcome cannot supply historical
feedback. No HTTPX source was newly acquired, converted or labelled here.

## Independent submission and immutable locks

The private workspace contains:

- `rater-1/` and `rater-2/`: identical anonymous source packets plus each person's
  own blank form. Give each assigned rater only their directory. Neither receives
  the other identity, responses, facilitator map or method outputs.
- `facilitator/`: the original plan, private source/identity/UUID mapping and
  release receipts. Do not distribute it or the workspace parent.
- `locks/`: exact original submission bytes, SHA-256, canonical record digests and
  local import timestamps. Never distribute it to raters.
- `adjudicator/`: created only after both independent submissions are locked.
  It contains the same source packet and anonymous A/B judgments/reasons.

Directories are created as 0700 and files as 0600. Gitfiles, symlink ancestors and
nonempty `.git` directories are rejected. Empty read-only `.git` guard directories
mounted by managed environments are not repositories; they are left untouched.
This is a local facilitator workflow, not a multi-user authentication or sandbox
service. Users sharing the facilitator's OS account can read private files.
Source paths/comments and free-text reasons can identify public cases or people;
content/outcome blinding remains an audited declaration, not identity-blinding proof.

After separately authorized real assignments, raters fill their own copied form:
exact assignment/packet/participant binding, actual self-reported submission time,
exposure declaration, full task/row roster, coverage, time spent, reasons and cited
packet evidence IDs. Distinct identity strings are required but cannot prove two
independent people. Refuse submission after accidental outcome or peer exposure;
record it in the study's exposure ledger and create a new common packet/assignment
if work resumes. Both raters restart on the new version; originals stay unchanged.

```sh
node --import tsx experiments/annotation/replay.ts import \
  --workspace /private/new-annotation-workspace --submission /private/rater-a.json
node --import tsx experiments/annotation/replay.ts import \
  --workspace /private/new-annotation-workspace --submission /private/rater-b.json
node --import tsx experiments/annotation/replay.ts adjudication-export \
  --workspace /private/new-annotation-workspace
```

Import preserves the exact raw bytes and checks the complete planned roster,
source citations, coverage, time bounds and participant identity. Reimport and
replacement are rejected. A process interruption after claiming a slot leaves an
`incomplete-lock-no-overwrite` state, not permission to overwrite or invent a
submission. Preserve that workspace and use a newly versioned assignment after
investigation. `status` distinguishes missing, locked and incomplete submissions.

## Adjudication and resulting annotations

The adjudicator must be a third distinct declared identity. The adjudication form
binds exactly the two locked record digests in their A/B order. It can accept A,
accept B, retain Unknown/disputed with reason, or leave work unassessed. If neither
rater assessed an opportunity, adjudication cannot manufacture a label. No answer
key, majority heuristic or automatic consensus supplies a reference judgment.

```sh
node --import tsx experiments/annotation/replay.ts adjudicate \
  --workspace /private/new-annotation-workspace \
  --submission /private/adjudicator.json
```

The command writes immutable raw adjudication, audit report and existing-format
`EvaluationAnnotationSchema` output in `locks/adjudication/`. It preserves both
originals, coverage, Unknown/disputed and absent judgments. Human provenance, when
supplied, is `adjudicated` with `locally-declared-unverified`; synthetic input stays
`synthetic`. `independentHumanAnnotationsVerified` always remains zero because this
software does not authenticate humans. Declaration flags in the core annotation
object are not proof of actual independence or blinding.

The audit reports **pre-adjudication** fixed-opportunity contingency counts,
raw agreement, unweighted Cohen's kappa, missing/excluded pairs and separate task
coverage contingency. Kappa is null for no paired ratings or expected agreement
one. Unknown is a rated category; null is missing work and never becomes Unknown
or negative. Current core negative labels do not distinguish legal-neighbor from
safe-applicable outcomes or define L_mech. No automatic H2 conversion is made.

## Checks and remaining gates

```sh
npx vitest run tests/blinded-annotation-workflow.test.ts \
  tests/paired-evaluation.test.ts tests/paired-evaluation.context.test.ts \
  tests/paired-evaluation.cli.test.ts --maxWorkers=1
npx tsc --noEmit
npm run build
```

Tests include blinded field allowlists, exact source reconstruction after coordinated
rehashing, original-byte preservation, missing/duplicate submissions, distinct
adjudication, zero-denominator agreement, Unknown/disputed, partial writes, packet
substitution, source cutoffs, unsafe directories and CLI use. Independent reviewers
also execute focused checks. No human response bytes or private mapping are checked
into Git; only implementation, authored fixtures and sanitized verification are.

Still needed for an empirical study: authorized independent humans and actual
assignments; valid substantive rule families and scope; source/exposure/lineage
admission; formal W1/W2 labels and any H2-specific adapter; matched model/runtime
admission and budgets; competent baselines and frozen scientific analysis. Current
capture is the primary design. Historical reconstruction is an additional gate only
for an optional historical replay, never inferred from present-day discussion.
