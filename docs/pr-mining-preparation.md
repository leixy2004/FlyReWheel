# Prepare a PR mining request

`mining choices` and `mining prepare` operate on **already stored, validated GitHub PR evidence**. They do not fetch GitHub data, call a model, freeze a request, create cases/candidates, schedule work or activate a rule. Direct-parent snapshots are not PR evidence and cannot be used as a substitute.

Run from the repository root after `npm run build`. Use an existing local database and an evidence digest returned by `github-pr import` or capture:

```sh
node dist/cli.js mining choices --db ./local-db --evidence-digest "$EVIDENCE_DIGEST" --out choices.json
node dist/cli.js mining prepare --db ./local-db --evidence-digest "$EVIDENCE_DIGEST" \
  --id inspect-pr-7 --rule-id privileged-read --rule-version draft-1 \
  --objective 'Investigate whether selected reads require policy context; preserve uncertainty.' \
  --actor local-operator --source supplied --created-at 2026-10-13T00:00:00Z \
  --before src/sample.ts --after src/sample.ts \
  --statement pull review:20 --out request.json
```

Choose actual paths and statement IDs from `choices.json`. The example path/ID above belongs to the repository's synthetic PR fixture; it is not a claim about a real PR. `--source` is explicitly `fixture` or `supplied`, describing the authored request, not authenticating its author or the evidence. Use `--source fixture` for synthetic validation.

The choices inventory includes every before/after side, its capture state, excluded reason and whether it is selectable. Absent sides are shown with change index/status; they cannot be selected. Blob bytes are omitted. All pull/issue-comment/review/review-comment records are listed with exact selectors. Their text remains untrusted evidence, never instructions, truth labels or developer feedback.

Select one or more paths with `--before <paths...>` / `--after <paths...>`, or explicitly use `--all-captured`. Combining those modes fails. `--all-captured` selects captured sides only; exclusions remain visible in the inventory. It never truncates to fit the existing 32-source limit. Statements are always explicit: `pull`, `issue-comment:10`, `review:20`, `review-comment:30`. Empty/duplicate/missing selections, an uncaptured source, or exceeding the existing 128-statement/JSON budget fail.

Rule ID, version, objective, actor, source and creation timestamp are required. An optional `--parent-digest` identifies a parent; omission requests a new root. Existing parent availability, heldout checks, immutable request identity and other storage policies remain enforced at freeze time.

## Inspect, then freeze through the existing interface

Preparation emits exactly `PrMiningRequestInputSchema`, with the evidence digest automatically bound. It reuses `derivePrMiningRequest` to verify all selections and derive exact before/after commit and discussion bindings, without persisting them. Inspect `request.json`, then explicitly freeze and reopen:

```sh
node dist/cli.js mining request --db ./local-db --file request.json --out frozen.json
node dist/cli.js mining show --db ./local-db --digest "$REQUEST_DIGEST"
```

`REQUEST_DIGEST` is the digest returned in `frozen.json`. The frozen request retains existing unknown-only case derivation and `synthesis: not_run`.

For history batches, replace `--evidence-digest` with `--batch "$BATCH_DIGEST" --number 7` on either new command. The exact PR must already be captured in that batch; pending/failed/missing PRs are rejected. Do not combine evidence and batch selectors. To freeze and link the inspected request to its batch, use the existing command:

```sh
node dist/cli.js github-pr history mining-request --db ./local-db \
  --batch "$BATCH_DIGEST" --number 7 --file request.json
```

## Verification scope

The compiled CLI driver is `node scripts/smoke-pr-mining-preparation.mjs`. It uses `examples/pr-mining-evidence.json`, a **synthetic PR package**, and explicitly synthetic history storage transitions. No valid real vLLM PR package was found among the existing task artifacts; the real direct-parent sample was not repackaged as PR evidence. The driver verifies choices → prepare → no persisted request → existing freeze → separate-process show, then history selection/linking, rejection cases and no candidate creation.

See [the recorded verification](evidence/pr-mining-preparation-2026-10-13.json). This demonstrates software compatibility, not real mining quality or a model-produced rule.
