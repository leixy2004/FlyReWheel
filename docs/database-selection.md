# One explicit database for domain commands and queued jobs

Persistent domain commands now accept exactly one selector:

- `--db <directory>` opens the existing local PGlite store. The flag and file
  format are unchanged. An ambient `DATABASE_URL` does not affect this choice.
- `--postgres` explicitly selects the PostgreSQL connection in `DATABASE_URL`.
  The URL must name a host and database and use `postgres:` or `postgresql:`.
  Supply credentials through the existing approved environment mechanism, never
  as CLI arguments, checked-in files, or pasted log output.

Missing selectors, both selectors, an empty local path or a memory/browser
PGlite backend URI passed as `--db`, and absent/invalid
PostgreSQL configuration fail before input acquisition, file reads, network
capture, migrations or domain writes. Setting `DATABASE_URL` alone never selects
PostgreSQL for a CLI command. Domain stores validate versioned migration history
and apply only pending files when opened, including by `show` or `list`. Thus
PostgreSQL selection can still be a write boundary on first open or upgrade.
An up-to-date store does not rerun DDL. `database inspect` reads the schema/history
without applying migrations. Pre-ledger stores require the explicit reviewed
[legacy adoption procedure](database-migrations.md) before normal startup.

This applies to rules/governance, snapshots, selected repository contexts, GitHub
PR evidence/history, mining requests/candidates, reviews, feedback and revisions.
They retain their existing trusted store APIs and validation. No second graph
format, recursive copier or direct SQL import path is introduced.

The top-level `demo` and `replay` retain their safe in-memory PGlite default;
`--db` persists locally and `--postgres` opts into PostgreSQL. `closed-loop demo`
is intentionally local and defaults to `<out-dir>/db`; it does not support
`--postgres`. Commands that do not use domain storage, such as `scan`,
`evaluation score`, history `preview`, and application-job `validate`, need no
selector.

## Prepare the inputs in the worker's database

These commands are a setup recipe, not a record of a live PostgreSQL run. First
have an operator supply the authorized PostgreSQL `DATABASE_URL` through the
existing environment configuration. Use that **same destination** for all domain
commands, the queue producer, status lookup and worker. Opening a store can apply
pending DDL; queue startup independently creates/updates pg-boss tables. The examples display only
environment names, never connection values or credentials.

```sh
# DATABASE_URL must already identify the explicitly authorized database.
# Import exact frozen domain inputs into the same PostgreSQL store as the jobs.
node dist/cli.js rules import --rule rule.json --cases cases.json --postgres --out stored-rule.json
node dist/cli.js snapshots import --file snapshot-package.json --postgres --out stored-snapshot.json
# Only when a review explicitly selects repository context:
node dist/cli.js contexts import --file context-package.json --postgres --out stored-context.json

# Create job.json using the returned rule/snapshot/context digests and an
# approved logical workspaceId, following docs/application-jobs.md.
node dist/cli.js application-jobs validate --file job.json
node dist/cli.js application-jobs enqueue --file job.json --postgres
node dist/cli.js application-jobs status --file job.json --postgres

# Inspect queued outcomes using the same store and their returned exact IDs.
node dist/cli.js reviews list --postgres
node dist/cli.js rules list --postgres
```

Mining uses the same route: import frozen evidence with `github-pr import`, then
create its validated request with `mining request`, both with `--postgres`.
Revision requests continue through existing review, feedback and revision
commands in that same database. Merely enqueueing a digest does not import its
dependencies, and enqueue does not preflight the entire graph. Inputs must already
exist in the selected store; the dispatcher still resolves and validates every
reference through trusted domain methods.

Existing local examples remain valid with `--db local-db`. Local records do not
magically appear in PostgreSQL. Use the existing frozen package imports and
request commands to populate the chosen store; never point a PostgreSQL job at a
digest that exists only in a local development database.

## Queue and worker selection

`application-jobs enqueue`, `application-jobs status`, and legacy `enqueue` now
require `--postgres` to use `DATABASE_URL`. Status may instead use `--db` to inspect
only the local domain ledger, without connecting to the queue. In PostgreSQL
status mode, one resolved selection supplies both the store and queue connection.

The existing PostgreSQL-only worker retains its environment-based startup:
`node dist/worker.js` explicitly starts that service and requires `DATABASE_URL`.
It uses the same connection resolver and store opener and never falls back to
PGlite. `node dist/worker.js --check` still opens no services. The default worker
continues to report application execution as `blocked / runtime_unavailable`
until a reviewed bootstrap injects the trusted runtime and workspace resolver.
Database alignment does not enable model execution or production isolation.

PostgreSQL driver errors and CLI queue-operation errors are reduced to fixed
safe diagnostics. Pool error events do not print raw connection data. Domain
validation errors retain their normal meaning, and transaction callback failures
roll back while releasing the client.

## Verification limits

Tests exercise real PGlite SQL workflows, injected store openers, the `pg.Pool`
query/transaction/lifecycle contract through a test double, and the same domain
imports/reads through that SQL-backed double. CLI tests and the compiled smoke
verify local persistence, selector/help plumbing, failure before acquisition,
no implicit PostgreSQL selection and no-service worker checks. Test processes
block socket/fetch access while using authored sentinel configuration.

These checks do **not** verify a live PostgreSQL server, authentication/TLS,
cross-process queue recovery, production throughput, deployed services, or live
models. Those require a separately authorized environment and remain untested.

### Focused verification (2026-10-02)

Typecheck, production build and `git diff --check` passed. Four focused
selector/driver/queue files passed 80 tests with `--maxWorkers=2`. The CLI file
passed its initial 74 cases, and the final grouped virtual-directory rejection
case passed in a targeted run; the complete file now contains 75 cases.

After the final build, `node scripts/smoke-database-selection.mjs` passed
**85 compiled-entrypoint checks**, with socket/fetch guards reporting zero
network attempts. The [captured smoke result](evidence/compiled-database-selection-smoke-2026-10-02.json)
covers the database-selector path rather than the repository-wide suite. No live PostgreSQL or model
execution is claimed by these checks.
