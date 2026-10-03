# Versioned database migrations

Domain storage uses **node-pg-migrate 9.0.0**, pinned in `package.json` and the
lockfile. PostgreSQL and PGlite run the same existing SQL files. No domain table,
evidence payload, identifier or content digest was redesigned. Files 001–014
remain byte-for-byte unchanged.

## Component choice and ownership

The upstream [programmatic runner](https://salsita.github.io/node-pg-migrate/api)
accepts a connected query client and tracks ordered migrations. Its public
[migration-loader API](https://salsita.github.io/node-pg-migrate/migration-loading-strategies)
lets the adapter execute the exact SQL bytes already read and hashed. The shipped
9.0.0 package, including its published types and runner, was checked directly;
the current upstream documentation may describe newer prereleases.

This reuses the established runner for migration discovery, order checking,
execution and history, instead of adding an ORM or a second migration framework.
The application adds only its shared-database adapter, SHA-256 checks and explicit
legacy-adoption boundary. Installation used the official npm registry with
`--save-exact --ignore-scripts`; no lifecycle scripts were run.

- `public.qe_schema_migrations` is the runner's ordered applied-version history
- `public.qe_schema_migration_checksums` records each name, SHA-256 of exact file
  bytes, whether it was migrated or adopted, and the reviewed adoption fingerprint
- An existing history must be a complete ordered prefix of the packaged files;
  missing, duplicated, reordered or unknown entries and checksum drift fail closed
- Reopening an up-to-date store performs validation reads but no migration DDL
- A fresh store runs all files once; an upgrade runs only the pending suffix

One adapter-owned transaction surrounds history checks, legacy adoption, every
pending SQL file and checksum insertion. The runner's inner transaction/locking
is deliberately disabled using its public options; the SQL loader calls
`pgm.noTransaction()` because the **outer transaction owns the entire operation**.
There is no unprotected runner call. On a normal SQL failure, new DDL and both
metadata tables/rows roll back together; retry starts from the last committed
prefix. A lost connection during COMMIT can leave its outcome uncertain; reopen
and validate history before retrying. Do not infer rollback from a lost response.

PostgreSQL acquires `pg_advisory_xact_lock(727413, 1)` on the same checked-out
client before inspecting or changing schema/history. Competing new-version
migrators wait; transaction end releases the lock, including on failure.
PGlite uses its transaction mutex for calls sharing one instance. **A persistent
PGlite directory still requires one process and one open PGlite instance.** Do
not run concurrent CLI processes against one local directory. This change does
not provide a filesystem lock, shared-file database or multiprocess PGlite support.

## Normal operation

```sh
npm run build
node dist/cli.js database inspect --db ./local-db
node dist/cli.js database migrate --db ./local-db
# With the already authorized DATABASE_URL configured out of band:
node dist/cli.js database inspect --postgres
node dist/cli.js database migrate --postgres
```

`inspect` reads history and schema inventory; it never creates history or runs
migrations. Opening a new PGlite directory can still initialize its underlying
engine files. Ordinary domain commands and worker startup also check/apply pending
migrations. Operators can run `database migrate` explicitly before starting those
processes; separate migration/runtime credentials and role provisioning are not
automatically configured. pg-boss owns its independent queue schema lifecycle.

Only the `public` application schema is supported. Any `qe_` relation/function
outside `public` fails closed, rather than silently creating a second application
schema. Existing non-public installations require an operator-reviewed relocation
or a future explicit schema configuration; this release does not move them.

## Upgrade a pre-ledger database without replaying historical SQL

Older releases reran every migration on open and have no trustworthy history.
Table names alone cannot establish the old schema's shape or which SQL bytes
historically ran. Normal startup therefore refuses an untracked legacy schema.
It does not replay the old `IF NOT EXISTS` statements or replace its functions.

1. Back up the database and verify your restore procedure. Stop old application
   processes and use a maintenance window. New advisory locks cannot coordinate
   old startup code or arbitrary operator DDL
2. Run `database inspect` and save/review its JSON output. It contains schema
   structure, trigger/function definitions, constraints and index state, not domain
   row contents. Treat it as internal operational information
3. Establish which **entire prefix** of the frozen 001–014 release actually exists.
   Compare the inventory against the SQL and, if useful, a clean reference database
   on the same PostgreSQL major version. Check columns/defaults, foreign keys and
   checks, indexes, enabled triggers, function bodies/security options, RLS and
   rules. Review data compatibility separately. PGlite currently embeds PostgreSQL
   18 whereas deployment targets PostgreSQL 17; their catalog text is not portable
4. Supply the exact last already-applied migration name and the reviewed
   `schemaFingerprint`. This command is an explicit operator attestation of schema
   compatibility; it does not certify historical execution or validate all data

```sh
node dist/cli.js database inspect --db ./legacy-db > reviewed-schema.json
# After backup, maintenance-mode review and verifying the full 014 baseline:
node dist/cli.js database adopt --db ./legacy-db \
  --through 014_governed_reviews \
  --schema-fingerprint <reviewed-64-character-sha256>
# Then reopen and inspect normal versioned history:
node dist/cli.js database inspect --db ./legacy-db
```

Use `--postgres` instead of `--db` for the explicitly configured PostgreSQL target.
Do not put connection strings or credentials in the command line or review files.
For a genuine 013 database, `--through 013_repository_contexts` adopts 001–013 and
executes only 014. The command checks the selected prefix against frozen file
checksums and its required table/function names; partial or incorrect prefixes
are rejected. These structural checks are only a sanity check, not a substitute
for the full review above. Prefixes newer than 014 cannot be adopted through this
legacy path.

The fingerprint is a same-database, versioned catalog snapshot used to detect
changes **since review**, rechecked under the migration lock. It is not a blessed
cross-database schema hash, and internal trigger identifiers may change after
restore. Inspect and review again when it changes. Adoption records the reviewed
fingerprint and current frozen checksums without executing any adopted SQL. Only
a later pending suffix executes. If that suffix fails, adoption also rolls back,
leaving the legacy database available for a corrected retry. Adoption never
replaces existing versioned history.

## Authoring and recovery

- Deploy the migration directory as part of an immutable, trusted application
  package. Concurrent file edits and untrusted writable migration directories are
  outside the supported execution model
- Append one consecutively numbered SQL file, for example `015_description.sql`;
  never edit, rename, remove or reorder an applied historical file
- Each SQL file is one complete up migration; this adapter executes the full
  file and does not split upstream `Up Migration` / `Down Migration` sections.
  Do not append down SQL or use a generated up/down template without removing
  its down section
- Keep migrations transactional. Do not add transaction control (`BEGIN`,
  `COMMIT`, `ROLLBACK` outside procedural bodies) or operations that require being
  outside a transaction, such as `CREATE INDEX CONCURRENTLY`
- Test against a fresh database and a populated previous-version database. Keep
  immutable evidence identities and historical interpretation unchanged
- Do not use a generic upstream CLI against these history tables: it would bypass
  the application's outer lock/checksum/adoption contract
- On checksum mismatch, restore the original migration bytes and append a new
  migration. Do not edit the stored checksum to silence the error
- On incomplete/corrupt history, stop and restore matching metadata from a
  verified backup. Do not delete the ledger to force replay or use legacy adoption
  to overwrite history
- SQL/driver errors are sanitized and upstream SQL logging is suppressed, so
  credentials and query contents do not escape through ordinary CLI/worker errors
- No destructive down-migration or automatic data rollback is provided. A failed
  committed application upgrade requires a reviewed forward repair or restore
- Checksums detect historical-file drift and ledger inconsistencies. They do not
  continuously compare an already-versioned database's full schema against a
  blessed catalog or detect every unmanaged DDL/data modification

## Local verification and limits

[Migration regressions](../tests/database-migrations.test.ts) run real PGlite:
fresh/repeated/reopened startup, concurrent same-instance migrations, append-only
upgrades, byte drift, corrupt history, populated legacy 014 adoption, 013→014
upgrade, stale review fingerprints, unsupported/partial schemas, and rollback of
fresh/pending/adopted batches with retry. The
[PostgreSQL adapter tests](../tests/database-migration-locking.test.ts) simulate
server advisory-lock ownership across separate clients and verify query ordering,
exclusion, rollback and error redaction. They are adapter-contract tests, not a
live PostgreSQL durability/locking result.

The [compiled smoke](../scripts/smoke-database-migrations.mjs) verifies exact copied
SQL bytes, compiled CLI adoption, zero replay on reopening and preserved domain
records. See the current [verification record](verification.md) for final
aggregate results. No live PostgreSQL, authentication, model/provider execution,
deployment, service provisioning, upload or publication was performed for these
checks. Real PostgreSQL 17 upgrade/restart behavior remains an external validation
gate before a shared production release.
