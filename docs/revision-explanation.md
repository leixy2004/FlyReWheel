# Explain a feedback-driven rule update

`revisions explain` connects an existing immutable comparison to its selected
feedback, literal candidate changes, evaluation observations, declared decisions
and current scoped local review selection. It is an inspection of existing records,
not a second generation, evaluation or activation workflow.

## What already existed

| Stage | Existing implementation / user entry |
| --- | --- |
| Discover feedback | `feedback list`, `feedback show`; exact finding/review/rule links |
| Freeze revision inputs | `revisions request`, `show`, `list`; selected feedback IDs and content digests |
| Generate candidate | `generateRuleRevision` in `src/rule-revision.ts` through the trusted workspace runtime; absence of runtime means `not_run` |
| Inspect generated records | `revisions candidates`, `candidate`, `outcomes`, `outcome`; execution receipts and diagnoses |
| Manually author an offline candidate | `rules import`; immutable rule with parent digest, not a generated-candidate receipt |
| Evaluate selected evidence | `reviews run --offline-fixtures`, then `revisions compare`; exact paired reviews, case and feedback observations |
| Declare a decision | `revisions decide`, `decisions`; accept/reject/defer does not itself select a version |
| Select for local reviews | `rules governance apply`, `show`, `history`, `select`; revised shadow selection requires exact accepted compatible evidence |
| Bind subsequent reviews | `reviews governed plan`; pins the current selection and exact rule digests; configured execution rechecks governance |

Previously the user needed to fetch both complete rule objects and manually join
feedback, comparison, decision and governance outputs. Generated-candidate
inspection did not provide a field diff or current scoped eligibility, and manually
imported candidates have no generated-candidate record. This change adds one
comparison-based explanation entry that handles either origin without inventing
synthesis evidence.

## Follow feedback to a candidate

```sh
npm run build
node dist/cli.js feedback show --db ./state --id <feedback-id>
node dist/cli.js revisions list --db ./state --base-rule-digest <feedback-rule-digest>
node dist/cli.js revisions comparisons --db ./state --request-digest <request-digest> --limit 20
node dist/cli.js revisions explain --db ./state --digest <comparison-digest> \
  --feedback-id <feedback-id> --repository <repository-id> --path src/example.ts \
  --out explanation.json
```

Choose a request that actually contains the feedback ID and a comparison for the
candidate of interest. `--feedback-id` is optional; when supplied it must belong
to that comparison's frozen request. It highlights the feedback without hiding
other evaluation evidence. `--digest` always means the comparison digest, not the
candidate-rule or generated-record digest. Repeat `--path` for more literal paths.
Repository and paths are required so eligibility uses the existing scope selector.

The result contains:

- `changes`: deterministic JSON Pointer paths, operation, before and after values.
  Object fields are compared recursively; arrays are whole values. Metadata and
  provenance changes remain visible. These are literal edits, not inferred semantic
  improvements or claims that a feedback item caused a particular edit.
- `selectedFeedback`: exact frozen feedback, its pinned digest and comparison
  observations, preserving source labels and focus. Later feedback is not included.
- `evaluation`: the validated stored comparison, including paired review/snapshot
  bindings, case results, feedback outcomes, coverage, scorer and trust scope.
- `decisions`: all stored decisions for this exact comparison, in digest order.
  Conflicting declarations are not resolved by guessing a latest decision.
- `localReview`: current selection for the supplied repository/paths, status,
  reason, governance head and selected evidence. `selectedUsingThisComparison`
  distinguishes selection through this report from selection through another
  comparison. Unregistered, candidate, out-of-scope, suspended and retired versions
  are not reported as eligible.
- `links`: exact version/comparison/history commands and generated-record lookup.
  Append the same database selector. No generation claim is inferred from an
  imported rule or a compatible comparison.

Inspection changes no rule, request, comparison, decision or governance record.
Ordinary explicit storage opening may apply pending database migrations.
Current selection can change later; use `reviews governed plan` and its existing
admission checks when preparing execution. Eligibility is only for local
experimental review, never production certification.

## Verification and limits

[Recorded acceptance](evidence/revision-explanation-verification-2026-10-13.json)
uses the existing `revisions demo` to import authored base/candidate rules, execute
real structural scanning, store fixture judgments, compare selected evidence and
record explicit fixture accept/reject decisions. Separate compiled CLI processes
then follow a feedback to its comparison and exercise the new explanation before
registration, after registration, after explicit shadow selection, outside scope
and after suspension. A regressed/rejected candidate remains unselected.

The next governed plan pins the chosen candidate. An explicit offline fixture
review then replays that digest through the existing `reviews run` command. This
replay is explicitly marked `explicit-digest-replay-not-governance-governed`; the
script does **not** claim it executed a governed worker or a production model.
Suspension changes current eligibility without rewriting the frozen comparison.

```sh
node scripts/smoke-revision-explanation.mjs /tmp/flyrewheel-explanation-new-run
npm test -- tests/revision-explanation.test.ts
```

Use a new nonexistent artifact directory. The test retains its database and JSON
outputs for inspection. All evaluated source snippets, candidate edits, semantic
judgments, feedback and decisions are synthetic/authored. There is no real-source
quality evaluation, real developer assessment, model call or substitute runtime.
Real generation still needs the existing trusted runtime and authorization;
semantic correctness and representativeness still need real model/human evidence.
The explanation cannot establish causality or quality beyond its stored evidence.
No credentials, W1 data, publication or frozen research protocol changes are involved.
