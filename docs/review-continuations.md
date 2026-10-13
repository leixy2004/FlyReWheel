# Explicit review continuations

A `request_context` or `retain_rule` outcome remains a diagnosis and next-step
proposal. It still performs no acquisition, repair, rule mutation or activation.
The separate continuation API lets an operator explicitly select already
registered context and request a new review of the same rule and snapshot, with
an immutable link to one exact original finding. `abstain` cannot be continued
through this action.

This is a product action outside frozen revision experiments. It does not amend
an old H experiment, recompute its labels, or count a new review as an old result.
No new developer feedback is inferred. Human verdicts and governance are unchanged.

## Local workflow

First capture/import context using the existing `contexts` commands. Packages
must be registered in the same database and match the finding's exact repository
and head. Selecting context does not establish that it is sufficient or relevant.
Then create an explicit continuation:

```sh
node dist/cli.js revisions continuations create --db ./state \
  --id followup-1 --outcome-digest <outcome-sha256> \
  --finding-id <review_finding_id> \
  --repository-context-digest <context-sha256> \
  --workspace-id authorized-review-workspace --attempt context-followup-1 \
  --out continuation.json
node dist/cli.js revisions continuations status --db ./state --digest <continuation-sha256>
node dist/cli.js revisions continuations list --db ./state --outcome-digest <outcome-sha256>
```

The output includes the exact application job. `show --digest` returns the same
job. Creation and inspection do not execute it. Trusted application code can call
`runReviewContinuation(dependencies, digest, signal)` or dispatch the exported job
through the existing application dispatcher. An existing PostgreSQL worker can
consume that job through the ordinary explicit application-jobs workflow. Keep
job and continuation in the same domain database. No runtime, executable, model,
credential or arbitrary workspace path is accepted in continuation JSON.

The dispatcher validates the exact continuation binding before claiming a job or
resolving a workspace. Existing workspace verification then checks repository/head
and the selected captured context. Without runtime dependencies, execution records
`blocked / runtime_unavailable / modelExecution: not_run`. A terminal blocked
attempt is immutable: after resolving prerequisites, deliberately choose a new
continuation ID and attempt. This feature does not configure authentication.

Same-input creation and finished dispatch are idempotent; changing context,
finding, workspace or attempt under an existing ID is rejected. As with other
application jobs, crashes before the atomic review/result commit can repeat
inference. It is not an exactly-once inference guarantee.

## Meaning of status

Execution status and anchor assessment are separate. The new review covers the
full frozen snapshot under the original rule's scope; the follow-up assessment
compares only the exact original anchor, including its byte span. Status verifies
the recorded review digest, rule, snapshot, selected context and application
attempt before reporting that assessment.

- `safe`, `violation`, `unknown`: the new review's explicit exact-anchor declaration.
- `not_adjudicated`: no exact finding or only an unverified structural occurrence.
  A target-safe judgment or absence of a finding does not mean repair succeeded.
- `not_run`: no completed new review, including blocked or failed execution.

Every result retains `certification: none`; execution completion is not repair
certification. `result.modelExecution` distinguishes authored fixture execution
from model execution. Missing evidence remains unknown under existing evidence
gates. The original outcome still correctly says `reviewRepair: not_performed`.

## Implementation and verification

The append-only `qe_review_continuations` table binds a content-addressed plan to
its original outcome. Reads rederive the plan from the frozen request/feedback
and registered context. The optional `continuationDigest` job field leaves old
job identities unchanged and is mutually exclusive with a governance-plan job.
The original mining, generation, comparison, governance and experiment contracts
are unchanged. Outcome inspection links to continuation discovery.

Targeted tests cover dispatcher execution, exact binding rejection, blocked
runtime, immutable retries, unknown and absent-anchor behavior, CLI discovery,
and reopening with the original fixture repository removed. The compiled smoke
adds continuation only when explicitly requested:

```sh
npm run typecheck
npm test -- tests/review-continuation.test.ts tests/application-job-context.test.ts tests/revision-inspection.storage.test.ts tests/database-migrations.test.ts
npm run build
node scripts/smoke-revision-generation.mjs --context --continuation
node dist/cli.js closed-loop demo --out-dir /tmp/flyrewheel-closed-loop
```

All smoke repository history, judgments, feedback and SDK responses are authored
fixtures. The installed SDK executes an authored CLI; it does not call a real
model or establish isolation, empirical effectiveness or developer acceptance.
The complete closed-loop demo separately covers mining → review → feedback →
generated candidate → comparison → decision; the continuation smoke covers the
new no-mutation branch and preserves the existing branch behavior.

The [2026-10-13 verification record](evidence/review-continuation-verification-2026-10-13.json)
contains the actual compiled smoke and closed-loop results, base commit and
fixture boundaries. No live model or PostgreSQL server was exercised in that run.
