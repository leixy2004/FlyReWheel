# Prepare finding-bound feedback

`feedback prepare` turns a stored review finding and explicit authored feedback into the existing `LocalReviewFeedbackSchema` JSON. It reads the finding through the existing integrity-checked store and fills `reviewId`, `ruleDigest` and `ruleVersion` from that finding. Those fields cannot be supplied or overridden as CLI arguments.

```sh
node dist/cli.js reviews finding --db ./local-db --id "$FINDING_ID"
node dist/cli.js feedback prepare --db ./local-db \
  --finding-id "$FINDING_ID" --id feedback-001 \
  --kind label --label FP --reason 'Explain the evidence for this judgment.' \
  --actor local-reviewer --source local-human-declared \
  --created-at 2026-10-15T00:00:00Z --out feedback.json
```

Use an actual existing finding ID. The example is an invocation template, not a declaration that any human judgment occurred. `actor`, `source`, reason, event ID and timestamp must be supplied explicitly. `local-human-declared` remains a caller declaration, not authentication or independent adjudication. Use `--source fixture` for authored test feedback; the command never infers or promotes its source.

Supported kinds are `label`, `resolve`, `merge` and `note`. A `label` requires exactly one of `TP`, `FP`, `Unknown`, `Disputed`. Other kinds must omit `--label`, producing `label: null`. Existing schema validation rejects invalid combinations, invalid sources, dates and empty required fields. Nonexistent or integrity-invalid findings fail through the existing read path.

Preparation outputs JSON to stdout or `--out`. It does not append feedback, create a revision request, synthesize a candidate, change governance or send anything. Like other database CLI commands, opening the selected local database may initialize/migrate its storage; the preparation function only reads finding evidence. The output is a draft, not a reserved feedback ID or promise that a later write will succeed.

Inspect the output, then explicitly use the existing write and read commands:

```sh
node dist/cli.js feedback add --db ./local-db --file feedback.json
node dist/cli.js feedback show --db ./local-db --id feedback-001
```

`add` retains exact binding checks and immutable ID semantics: identical re-submission is idempotent; changing an existing event is rejected. Editing bound identities in the prepared file cannot bypass storage validation. Fixture labels remain separate from human-declared verdicts, so a fixture FP alone leaves the finding verdict `Unknown`.

For the next explicit step, select the feedback ID in an existing revision request:

```json
{
  "id": "revision-001",
  "baseRuleDigest": "<ruleDigest from feedback.json>",
  "requestedRuleVersion": "next-draft",
  "feedbackIds": ["feedback-001"],
  "requestedChange": "Describe the proposed change to investigate.",
  "actor": "local-reviewer",
  "source": "local-human-declared",
  "createdAt": "2026-10-15T00:00:00Z"
}
```

Run `revisions request --file revision.json --db ./local-db` only when that selection is intended. It freezes the exact feedback digest using the existing request protocol; prepare itself never performs this step. For synthetic exercises, explicitly use `fixture` in both authored inputs.

## Validation

`tests/feedback-preparation.test.ts` covers exact identity derivation, no domain state changes during preparation, explicit source preservation, nonexistent findings, attempted identity overrides, kind/label/source validation, idempotent add, conflicting duplicate/version rejection, fixture verdict isolation and frozen revision bindings. The synthetic `local-human-declared` unit case is prepared but never persisted as real feedback.

The compiled CLI driver `node scripts/smoke-feedback-preparation.mjs` uses the existing synthetic review demo and selects its structural finding. It checks prepare leaves feedback/revisions/governance unchanged, then explicitly adds fixture feedback, reopens it in a separate CLI process, freezes it in an existing revision request and reopens that request. It also checks invalid inputs and confirms governance remains unchanged. The demo's pre-existing synthetic note/request are recorded as baseline state, not attributed to prepare.

No real source review, model judgment or independent human feedback is claimed. The [verification record](evidence/feedback-preparation-2026-10-15.json) contains the precise commands, counts and fixture evidence identities. No research protocol or schema migration was changed.
