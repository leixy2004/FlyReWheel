# Discover feedback for a rule revision

Previously `feedback add` could append a record, and `reviews finding` could show
feedback if the finding ID was already known. There was no feedback catalog or
lookup by feedback ID. Preparing `revisions request`, which requires explicit
`feedbackIds`, meant traversing reviews/findings or retaining the original input
files. The new commands expose the existing immutable records and evidence links.
They reuse the existing storage validation, verdict derivation and revision request
binding; no migration or new feedback format is needed.

## Find and inspect

```sh
npm run build
node dist/cli.js feedback list --db ./state --rule-digest <rule-sha256> --limit 20
node dist/cli.js feedback list --db ./state --review-id <review-id> --source fixture
node dist/cli.js feedback list --db ./state --finding-id <finding-id>
node dist/cli.js feedback show --db ./state --id <feedback-id>
```

`list` accepts intersecting rule, review, finding and source filters. Source is
`fixture` or `local-human-declared`; omission returns both with explicit labels.
Records include ID, exact rule version, source, actor, reason, timestamp and links.
Use `nextAfter` as `--after` with the same filters until an empty page returns
`null`. Ordering is by immutable ID, not event time. Pages are not a snapshot
across invocations. The page size is 1–100, default 20. Both commands support
`--out <file>` and the usual explicit database selector.

`show` returns the exact feedback plus the finding and anchor, IDs of its current
feedback, and `currentFindingVerdict`. This verdict covers all current finding
feedback; it is not the verdict of a frozen revision selection. Fixture labels
never become human verdicts. `local-human-declared` is an unauthenticated local
declaration, not a verified developer identity. Links are CLI argument arrays;
append the same `--db` selection. The revision-request link lists all requests
for the base rule; inspect their frozen feedback IDs to find exact usage.

## Freeze a selected request

Use the inspected record's `ruleDigest` and explicitly chosen `id` values in the
existing request format. For an offline fixture walkthrough:

```json
{
  "id": "selected-fixture-request",
  "baseRuleDigest": "<feedback.ruleDigest>",
  "requestedRuleVersion": "draft-2-requested",
  "feedbackIds": ["<feedback.id>"],
  "requestedChange": "Clarify the evidence requirement described by the selected note.",
  "actor": "offline-fixture-author",
  "source": "fixture",
  "createdAt": "2026-10-13T00:00:00Z"
}
```

Replace placeholders with actual stored identities; the requested version must
differ from the base version. Real local declarations must retain their actual
source and actor rather than being relabeled as fixture or authenticated feedback.

```sh
node dist/cli.js revisions request --db ./state --file request.json
node dist/cli.js revisions show --db ./state --digest <returned-request-digest>
```

The request freezes the exact selected feedback IDs and content digests. Later
feedback does not change it. Listing or inspecting never selects feedback
implicitly, generates a rule, changes governance or executes a model. Existing
candidate inspection, comparison, decision and explicit governance commands remain
the next stages; this change closes feedback discovery only.

## Offline verification

Run the compiled acceptance script with a new nonexistent artifact directory:

```sh
node scripts/smoke-feedback-discovery.mjs /tmp/flyrewheel-feedback-new-run
```

It executes `reviews demo`, adds an authored note, pages through feedback, follows
rule/review links, selects a discovered ID into a request, then proves that later
feedback leaves the request unchanged across process restarts.
[Recorded result](evidence/feedback-discovery-verification-2026-10-13.json).

All input source snippets, judgments and feedback in this acceptance are synthetic
fixtures from the existing demo. The CLI and database operations are real; no
upstream source was evaluated, no real developer feedback was collected, and no
model (real or runtime substitute) was called. This is workflow verification, not
evidence of rule quality or revision generation. No W1 data or credentials were
read; the old experiment/freeze protocol is unchanged.
