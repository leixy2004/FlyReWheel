# Local semantic-v2 rule governance

This is an explicit, local-only eligibility registry for experimental semantic
review. Its namespace is `local-semantic-review`. It records which immutable v2
version, if any, is selected as `local-shadow` for each logical rule, with an
append-only decision history and compare-and-swap (CAS) writes.

`local-shadow` is **local experimental review eligibility**, not production
activation, validated correctness, an authenticated approval or permission to
publish. Selection does not run a detector, call a model, create a review or send
notifications. It never changes the v1 active-rule registry or promotion path.

The existing digest-pinned review APIs remain usable for explicit historical and
research replay, including versions that local selection excludes. Registry
eligibility gates only callers that opt into this selection workflow. A rule
import, generated candidate, revision request or local comparison decision does
not register, select, suspend, retire or replace a version by itself.

## Commands and inputs

Use the same local database that holds the immutable v2 versions and, for revised
versions, their stored comparisons and decisions:

```sh
npm run cli -- rules governance apply --file command.json \
  --db .flyrewheel/semantic-db
npm run cli -- rules governance show \
  --rule-id effective-wait-deadline-semantic --db .flyrewheel/semantic-db
npm run cli -- rules governance history \
  --rule-id effective-wait-deadline-semantic --db .flyrewheel/semantic-db
npm run cli -- rules governance select --repository exact-repository-identity \
  --path src/worker.ts --path src/wait.ts --db .flyrewheel/semantic-db
```

After `npm run build`, the same commands are available through
`node dist/cli.js`. `apply` accepts one strict JSON command, not an imported derived
state or event. `show` inspects the logical rule's derived state; `history` exposes
the stored transition history; `select` explains eligibility for the supplied
repository and paths. All commands require an explicit `--db` or `--postgres` selection and support `--out <file>`.
The [strict schemas](../src/core/semantic-governance.ts) define the command, event,
state and selection shapes.

- `apply` returns `{ digest, event }` for the immutable derived event
- `show` returns `headDigest`, `sequence`, registered `versions` with their states
  and selection evidence, `shadowRuleDigest`, namespace and trust markers
- `history` returns `{ digest, event }` records in sequence order
- `select` returns `selected`, `excluded`, the exact repository/path query,
  namespace and trust markers; excluded records have an explicit `reason`

An unregistered logical rule has an empty history, `headDigest: null`, no selected
version and no registered versions. Importing a version does not create an event.

Every command submitted to `apply` has these common fields:

| Field | Meaning |
| --- | --- |
| `id` | Immutable identity for this authored command; use a new ID for a new action |
| `namespace` | Exactly `local-semantic-review` |
| `ruleDigest` | Exact stored semantic-v2 version to register or transition |
| `scopeDigest` | `digestOf(rule.scope)` for that exact version |
| `expectedHeadDigest` | `null` only for an empty logical-rule history; otherwise its exact current head event digest |
| `action` | One of the actions below |
| `actor` | Explicit caller-declared identity |
| `source` | Exactly `fixture` or `local-human-declared` |
| `reason` | Explicit reason retained with this action |
| `createdAt` | Authored timestamp, not an independently authenticated clock |

The logical rule comes from the stored `ruleDigest`. The CAS head belongs to the
whole logical rule, not to one version: registering another version also advances
it. Read the current state/history immediately before preparing a new command.
A new write with a stale or fabricated head fails instead of overwriting another
decision. Keep
old events and author a new command after inspecting a conflicting update.

`scopeDigest` hashes the validated scope object using the project's canonical
JSON `digestOf` implementation. It is not the hash of a formatted JSON file and
must not be guessed from a repository/path query. Object key order does not
matter; array order and all values do. The store verifies both the full rule
identity and exact scope binding. Scope changes require another immutable rule
version and a new explicit governance action.

For a raw v2 rule JSON file, calculate the scope digest with the same code used by
the store (this only validates and prints a digest):

```sh
node --import tsx --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { digestOf } from "./src/core/identity.ts";
  import { SemanticRuleVersionSchema } from "./src/core/semantic-rule.ts";
  const rule = SemanticRuleVersionSchema.parse(JSON.parse(readFileSync(process.argv[1], "utf8")));
  console.log(digestOf(rule.scope));
' examples/semantic-rule-v2.json
```

## Register and bootstrap a root

[Import the rule](semantic-rules.md) first. Importing alone leaves it outside local
selection. A first registration command is:

```json
{
  "id": "deadline-register-root-1",
  "namespace": "local-semantic-review",
  "ruleDigest": "COPY_EXACT_ROOT_RULE_SHA256",
  "scopeDigest": "COPY_CANONICAL_ROOT_SCOPE_SHA256",
  "expectedHeadDigest": null,
  "action": "register",
  "actor": "your-declared-local-identity",
  "source": "local-human-declared",
  "reason": "Track this immutable rule as a local experimental candidate.",
  "createdAt": "2026-10-02T00:00:00Z"
}
```

Replace the placeholder digests and timestamp before applying. The resulting
state is `candidate`, which is not selected. An explicit second command may
bootstrap a root version:

```json
{
  "id": "deadline-bootstrap-root-1",
  "namespace": "local-semantic-review",
  "ruleDigest": "COPY_EXACT_ROOT_RULE_SHA256",
  "scopeDigest": "COPY_CANONICAL_ROOT_SCOPE_SHA256",
  "expectedHeadDigest": "COPY_HEAD_EVENT_SHA256_AFTER_REGISTRATION",
  "action": "bootstrap-shadow",
  "actor": "your-declared-local-identity",
  "source": "local-human-declared",
  "reason": "Use this explicitly unvalidated baseline for local experimental review.",
  "createdAt": "2026-10-02T00:01:00Z"
}
```

Bootstrap is limited to a v2 root with `provenance.parentDigest: null`, in
`candidate` or `suspended` state. It produces a `local-shadow` version with an
explicitly **unvalidated baseline**. It cannot be used to skip comparison for a
revised rule. No accepted comparison, quality threshold, human verification or
held-out certification is implied by bootstrap success.

## State transitions

| Action | Required prior state | Result and additional conditions |
| --- | --- | --- |
| `register` | Version not registered | `candidate`; exact v2 rule and scope must exist |
| `bootstrap-shadow` | Root `candidate` or `suspended` | `local-shadow`, explicitly unvalidated baseline |
| `select-shadow` | Revised `candidate` or `suspended` | `local-shadow`; requires the exact accepted comparison decision described below |
| `suspend` | `local-shadow` | `suspended`; stops opt-in selection while retaining evidence/history |
| `retire` | `candidate`, `local-shadow` or `suspended` | `retired`; terminal for this immutable version |
| `supersede` | Old version `local-shadow` or `suspended`; registered successor `candidate` or `suspended` | Old becomes `superseded` and successor becomes `local-shadow` atomically, with an exact old-to-successor decision |

At most one version per logical rule can be `local-shadow`, even if two versions
have different scopes. Plain `select-shadow` or bootstrap does not implicitly
suspend, retire or replace another selected version. `retired` and `superseded`
are terminal states; neither can be revived by registering it again or by using
a new command ID. The history retains all earlier provenance and transitions.

No proposal or authored contract can retire or replace rules automatically. Each
transition needs its own explicit command and expected logical-rule head.

## Select a revision with exact comparison evidence

A `select-shadow` command adds `decisionDigest` to the common fields. That digest
must identify a stored explicit `accept` of a `compatible` comparison using the
current `per-anchor-semantic-v3` scorer and the exact candidate version. The
comparison must contain nonempty scored observations; vacuous compatibility does
not permit selection. Its pinned evidence and direct-parent lineage are
validated, rather than trusting a caller's outcome or summary.

An older scorer, reject/defer decision, inconclusive or regressed comparison,
wrong candidate, missing evidence or empty scored selection cannot select a
revision. A previously recorded acceptance does not become current evidence by
changing the governance command's timestamp. Historical comparison decisions
remain readable under their original contracts.

Eligibility binds the explicitly selected immutable decision and comparison;
later feedback or independently recorded accept/reject/defer decisions do not
automatically select, revoke or renew governance state, so operators must
explicitly suspend, retire or select with a fresh expected head. This is bounded
pinned evidence, not a latest-feedback consensus policy.

An accepted decision is a necessary local gate, not an independent correctness
certificate. A `fixture` acceptance remains a fixture. `local-human-declared`
identifies a caller declaration, not an authenticated reviewer. The same limits
apply to the governance actor/source and any SDK or execution receipt carried by
the underlying reviews. See [local revision comparisons](local-revision-comparisons.md)
for exact-anchor scoring, missing-context handling and evidence trust limits.

### Atomic supersession

To replace an old version, use `action: "supersede"` with its exact `ruleDigest`
and `scopeDigest`, the current logical-rule `expectedHeadDigest`, the accepted
`decisionDigest`, and:

```json
{
  "successor": {
    "ruleDigest": "COPY_EXACT_REGISTERED_SUCCESSOR_SHA256",
    "scopeDigest": "COPY_CANONICAL_SUCCESSOR_SCOPE_SHA256"
  }
}
```

This fragment is added to the common command fields; it is not a complete command.
The successor must already be registered, share the exact logical rule ID, and
name the old version as its direct `provenance.parentDigest`. The accepted current
comparison must compare that exact old version to that exact successor. A sibling,
unrelated version or comparison against a different base cannot replace it.

The old transition and successor selection are one atomic write. Validation or
CAS failure leaves both states unchanged. This prevents a partially replaced
local selection, and preserves which decision and declared actor authorized the
replacement. It does not alter either immutable rule, comparison or decision.

## Scope selection and replay

`select` takes one exact repository identity and one or more literal,
repository-relative POSIX paths via repeatable `--path`. It uses the existing
[semantic scope contract](semantic-rules.md#contract): repository aliases are not
inferred, include prefixes match path/subtree boundaries, exclusions win, and
there is no glob expansion or host filesystem inspection. For example, `src`
matches `src/worker.ts`, but not `src-other/worker.ts`.

Only registered `local-shadow` versions matching the exact repository and **at
least one** supplied path are eligible. Selection does not claim that every
supplied path is in scope; a caller reviewing individual files still applies the
returned scope to each path. Query paths must be unique and valid literal paths.

The selection result also reports exclusions for all other registered versions.
A nonselected lifecycle state is the reason (`candidate`, `suspended`, `retired`
or `superseded`); a `local-shadow` version matching none of the requested paths or
the wrong repository has reason `out_of_scope`. Unregistered imported versions
are absent from this registry result, rather than listed as registered candidates. An empty result is not proof that the files are safe.
A matching scope is only an applicability candidate, not a semantic finding.

This inspection operation returns local selection evidence only. The
[governed review coordinator](governed-semantic-reviews.md) now provides the
connected execution path: it persists an exact selection manifest and checks
registry freshness at each trusted application-job admission. A caller can also
explicitly choose historical/manual replay with an exact rule digest. It
creates no review, model invocation, notification, provider comment or production
promotion. Existing `reviews run --rule-digest ...` and digest-pinned application
APIs intentionally remain available without the registry for explicit replay;
their success does not mean that a version is currently selected.

## Persistence, integrity and trust

Governance uses a separate local event stream from immutable rule-version storage
and the legacy v1 active registry. Commands retain their actor, source, reason,
time, exact rule/scope bindings, predecessor head and any decision/successor
bindings. Reads validate hashes, immutable provenance and the legal transition
sequence before deriving current state or returning history/selection.

An identical command retry is idempotent and returns its original event after
validating history, even if later commands have advanced the head. Changed content
under an existing ID is rejected. No event rewrites prior events or relabels a
fixture as human evidence.
Stale-head rejection and atomic supersession protect local consistency; hashes
and stored declarations do not establish identity authenticity, honest timestamps,
real model execution, external database durability or empirical semantic quality.

### Bounds and recovery

This small local registry permits at most 250 events and 100 registered versions
per logical rule, and at most 100 governed logical rules in the local registry.
Creating the first head for a 101st logical rule is refused before any event is
committed. Selection also refuses an over-limit registry or orphaned event/head
mismatch rather than returning a truncated or silently incomplete result. A
selection query permits up to 1,000 unique paths.

The final event slot is reserved for a state with **no `local-shadow` selection**:
an event at sequence 250 is refused if its resulting state would retain a selected
version. A selected version can use that final slot to suspend or retire. At 250
events the logical-rule stream accepts no further new commands; reads and
identical retries remain available. This prevents the history limit from leaving
a selected version that cannot be suspended, but does not provide stream rollover
or allow terminal versions to be revived.

The governance reader counts loaded event/rule/decision/comparison payloads
against a 16,000,000-byte budget; referenced evidence also remains subject to its
existing reader's own bounds. CLI command JSON uses the existing 2 MB strict UTF-8
input limit. The implementation rejects exceeded bounds rather than silently
cutting history, observations or selection results.

A successful apply writes an event and head in one local database transaction.
If `--out` fails after the database write, inspect `history` or retry the identical
command to recover the stored event; do not author a new action just to retrieve
its result. Never edit the event tables to repair a stale head. This local bounded
store does not supply archive/pruning, production-scale discovery or distributed
service recovery.

All of this is bounded local experimental governance. There is no production
activation, certification, automatic online rollout, authenticated approval,
provider integration or broad correctness claim. See [verification](verification.md)
for the checks actually run and the historical checkpoint boundaries.

## Reproduce the compiled fixture smoke

```sh
npm run build
node scripts/smoke-local-semantic-governance.mjs
```

The [recorded smoke](evidence/compiled-local-semantic-governance-smoke-2026-10-02.json)
checks that an accepted fixture decision alone does not select a rule, then
explicitly registers and bootstraps a root, registers and supersedes it with its
exact comparison-backed successor, suspends, reopens the database, retries an old
command, resumes and retires. It preserves the fixture trust markers and exact
historical review access, leaves the v1 active registry unchanged and records zero
calls to a blocked `fetch` boundary. Its temporary local PGlite directory is
removed after the run.

This is compiled application contract verification with authored fixtures, not
live model execution or authenticated human approval. See the
[full verification record](evidence/local-semantic-governance-verification-2026-10-02.txt)
for aggregate checks and their limits: **745 tests across 52 files** passed with
two workers in 419.67 seconds, alongside type checking, build and static validation
of 30 deployment YAML documents. These are local checks, not a deployment.
