import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPGliteDatabase } from '../dist/storage/database.js';
import { LEGACY_BASELINE } from '../dist/storage/legacy-baseline.js';
import { migrateDatabase, inspectDatabaseMigrations } from '../dist/storage/migrations.js';

// Local compiled artifact smoke only. No PostgreSQL server or provider calls.
const execute = promisify(execFile), temporary = await mkdtemp(join(tmpdir(), 'migration-smoke-'));
const directory = join(temporary, 'database');
let db;
try {
  const names = await readdir(new URL('../src/storage/migrations/', import.meta.url));
  assert.deepEqual((await readdir(new URL('../dist/storage/migrations/', import.meta.url))).sort(), names.sort());
  for (const name of names) assert.deepEqual(await readFile(new URL(`../dist/storage/migrations/${name}`, import.meta.url)),
    await readFile(new URL(`../src/storage/migrations/${name}`, import.meta.url)));
  db = await openPGliteDatabase(directory);
  for (const file of LEGACY_BASELINE) {
    const bytes = await readFile(new URL(`../dist/storage/migrations/${file.name}.sql`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.checksum);
    await db.exec(bytes.toString('utf8'));
  }
  const payload = { ruleId: 'migration-smoke', unchanged: true };
  await db.query('INSERT INTO qe_rule_bundles(digest,rule_id,version,payload) VALUES ($1,$2,$3,$4)',
    ['a'.repeat(64), 'migration-smoke', 'v1', JSON.stringify(payload)]);
  const before = (await db.query('SELECT * FROM qe_rule_bundles')).rows;
  const inspection = await inspectDatabaseMigrations(db);
  assert.equal(inspection.state, 'legacy-untracked');
  await assert.rejects(migrateDatabase(db), { code: 'LEGACY_SCHEMA_REQUIRES_ADOPTION' });
  await db.close(); db = undefined;
  const cli = new URL('../dist/cli.js', import.meta.url);
  const environment = { PATH: process.env.PATH, HOME: temporary, QE_ENABLE_MODEL: 'false' };
  const adopted = await execute(process.execPath, [cli.pathname, 'database', 'adopt', '--db', directory,
    '--through', '014_governed_reviews', '--schema-fingerprint', inspection.schemaFingerprint],
  { cwd: temporary, env: environment, timeout: 30_000 });
  const adoption = JSON.parse(adopted.stdout);
  assert.equal(adoption.adopted.length, 14); assert.deepEqual(adoption.applied, []);
  const repeated = await execute(process.execPath, [cli.pathname, 'database', 'migrate', '--db', directory],
    { cwd: temporary, env: environment, timeout: 30_000 });
  assert.deepEqual(JSON.parse(repeated.stdout).applied, []);
  db = await openPGliteDatabase(directory);
  assert.deepEqual((await db.query('SELECT * FROM qe_rule_bundles')).rows, before);
  assert.equal((await inspectDatabaseMigrations(db)).applied.length, 14);
  assert.equal((await db.query('SELECT * FROM qe_schema_migration_checksums')).rows.length, 14);
  console.log(JSON.stringify({ compiledMigrationBytesIdentical: true, adopted: 14, reapplied: 0,
    preservedDomainRecords: before.length, cliAdoptionAndReopen: 'passed', livePostgres: 'not_run' }, null, 2));
} finally { if (db) await db.close(); await rm(temporary, { recursive: true, force: true }); }
