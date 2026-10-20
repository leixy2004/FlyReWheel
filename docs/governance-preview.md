# Preview a feedback-driven governance change

Before applying a local review governance command, inspect its validated effects:

```sh
node dist/cli.js rules governance preview --db ./state --file command.json --out preview.json
node dist/cli.js rules governance apply --db ./state --file command.json
```

Both commands accept the same strict `SemanticGovernanceCommandSchema` input.
Choose the intended command explicitly; preview does not choose a decision or
candidate, manufacture acceptance, or generate a rule. Use `revisions explain`
to trace selected feedback and exact comparison/decision evidence first. Existing
`rules governance show` supplies the current head; rule inspection supplies the
immutable scope. The caller supplies actor, source, reason, ID and timestamp.

The preview validates the same rule/scope bindings, immutable command ID, expected
head, governance limits, accepted comparison evidence and transitions as apply.
A shared registry lock gives a consistent governance observation during this
transaction. `currentState` is the current validated stream;
`resultingState` is the projected stream, and `event` gives its exact prospective
digest, evidence and transitions. `status: ready` means this command passed those
checks at the time of preview. No governance event or head is written.

For a command already applied with identical content, `status: already-applied`
returns the original stored event, but both state fields reflect the **current**
stream and `transitions` is empty. It never rewinds later suspension/retirement.
A conflicting reused ID, stale head, scope mismatch, unaccepted/regressed proof
or invalid transition fails as it would during apply.

A preview is not a reservation. Another command may change the head before apply,
and apply must then reject the old command. Do not blindly rewrite the expected
head or treat preview output as automatic approval. Submit the original command
file explicitly after inspection. Accepting a revision remains separate from
selecting it for scoped local review; selection remains separate from executing
a governed review plan.

`governanceWritesPerformed: false` refers to governance domain records. Opening a
new/stale database can initialize or migrate it; `--out` uses the existing shared
file writer and can replace its selected target. The command does not call a model,
write a review, activate production rules, or authenticate a human declaration.
Fixture evidence stays fixture evidence. PostgreSQL locking follows the existing
store contract; this feature's acceptance was run on PGlite, not live PostgreSQL.

## Reproduce the user flow

```sh
npm run build
node scripts/verify-governance-preview.mjs /tmp/new-preview-acceptance
```

The new directory must not already exist. Separate compiled CLI processes follow
existing authored demo feedback/comparison evidence, preview registration and
shadow selection, prove history/eligibility unchanged, explicitly apply the same
events, and execute a governed review with explicitly supplied offline fixtures.
They then verify rejected evidence, competing suspension/stale preview rejection,
and idempotent preview without undoing suspension. This exercises real CLI,
database and structural review operations; source, semantic judgments, candidate
edits and developer feedback are authored fixtures, not real model/human efficacy
measurements. No model, credentials, W1 data or production activation is involved.
