import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { QualEvoStore } from '../src/storage/store.js';
import { inspectDatabaseMigrations, migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/storage/migrations.js';
import { LEGACY_BASELINE } from '../src/storage/legacy-baseline.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!().catch(() => {}); });
async function database(path?: string) {
  const db = await openPGliteDatabase(path); cleanup.push(() => db.close()); return db;
}
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), 'migration-tests-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function migrations() {
  const dir = join(await temporary(), 'migrations'); await cp(MIGRATIONS_DIRECTORY, dir, { recursive: true }); return dir;
}
async function legacy(db: Database, count = 14) {
  for (const file of LEGACY_BASELINE.slice(0, count)) await db.exec(await readFile(join(MIGRATIONS_DIRECTORY, `${file.name}.sql`), 'utf8'));
}
async function records(db: Database) {
  return (await db.query('SELECT digest,rule_id,version,payload FROM qe_rule_bundles ORDER BY digest')).rows;
}
async function seed(db: Database) {
  await db.query('INSERT INTO qe_rule_bundles(digest,rule_id,version,payload) VALUES ($1,$2,$3,$4)',
    ['a'.repeat(64), 'authored-rule', 'v1', JSON.stringify({ source: 'legacy', literal: 'preserve exact evidence', nested: [1, 2, 3] })]);
  await db.query('INSERT INTO qe_case_lineages(id,split) VALUES ($1,$2)', ['legacy-lineage', 'training']);
}
async function metadataAbsent(db: Database) {
  expect((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND starts_with(tablename,'qe_schema_migration')")).rows).toEqual([]);
}

it('freezes every historical migration byte and introduces no domain DDL rewrite', async () => {
  expect(LEGACY_BASELINE).toHaveLength(14);
  for (const file of LEGACY_BASELINE) expect(createHash('sha256').update(await readFile(join(MIGRATIONS_DIRECTORY, `${file.name}.sql`))).digest('hex')).toBe(file.checksum);
});

describe('node-pg-migrate on actual PGlite', () => {
  it('creates history/checksums once, reopens unchanged, and executes no migration DDL on repeated startup', async () => {
    const path = join(await temporary(), 'db'), first = await database(path);
    const result = await migrateDatabase(first);
    expect(result.applied).toEqual(LEGACY_BASELINE.map(file => file.name));
    await seed(first); const before = await records(first);
    const history = (await first.query('SELECT * FROM qe_schema_migrations ORDER BY id')).rows;
    expect((await first.query('SELECT name,checksum FROM qe_schema_migration_checksums ORDER BY name')).rows)
      .toEqual(LEGACY_BASELINE.map(({ name, checksum }) => ({ name, checksum })));
    await first.close();
    const reopened = await database(path), statements: string[] = [];
    const wrapped: Database = { ...reopened, migrationTransaction: fn => reopened.migrationTransaction(tx => fn({
      query: (sql, params) => { statements.push(sql); return tx.query(sql, params); },
    })) };
    expect(await migrateDatabase(wrapped)).toEqual({ applied: [], adopted: [], current: '014_governed_reviews' });
    expect(statements.some(sql => /CREATE |ALTER |INSERT |UPDATE |DELETE /i.test(sql))).toBe(false);
    expect((await reopened.query('SELECT * FROM qe_schema_migrations ORDER BY id')).rows).toEqual(history);
    expect(await records(reopened)).toEqual(before);
    await expect(reopened.query('UPDATE qe_rule_bundles SET version=$1', ['v2'])).rejects.toThrow(/append-only/);
  }, 30_000);

  it('serializes concurrent calls through one PGlite instance and records each migration once', async () => {
    const db = await database(), results = await Promise.all(Array.from({ length: 4 }, () => migrateDatabase(db)));
    expect(results.map(result => result.applied.length).sort((a, b) => a - b)).toEqual([0, 0, 0, 14]);
    expect((await db.query('SELECT name FROM qe_schema_migrations')).rows).toHaveLength(14);
    expect((await db.query('SELECT name FROM qe_schema_migration_checksums')).rows).toHaveLength(14);
  }, 30_000);

  it('applies only a new append-only migration exactly once without rewriting preserved records', async () => {
    const db = await database(), directory = await migrations();
    await migrateDatabase(db, { directory }); await seed(db); const before = await records(db);
    await writeFile(join(directory, '015_authored_append.sql'), "CREATE TABLE authored_once(id int PRIMARY KEY); INSERT INTO authored_once VALUES (1);");
    expect((await migrateDatabase(db, { directory })).applied).toEqual(['015_authored_append']);
    expect((await migrateDatabase(db, { directory })).applied).toEqual([]);
    expect((await db.query('SELECT * FROM authored_once')).rows).toEqual([{ id: 1 }]);
    expect(await records(db)).toEqual(before);
  }, 30_000);

  it.each(['015_unexpected.js', '015_unexpected\n.js', '015_unexpected.sql\n'])('never loads an executable file introduced after the SQL snapshot: %j', async filename => {
    const db = await database(), directory = await migrations();
    const marker = globalThis as typeof globalThis & { authoredUnexpectedMigrationLoaded?: boolean };
    delete marker.authoredUnexpectedMigrationLoaded;
    const wrapped: Database = { ...db, migrationTransaction: async fn => {
      // A harmless authored fixture proves upstream fallback code never executes.
      await writeFile(join(directory, filename), 'globalThis.authoredUnexpectedMigrationLoaded = true; export function up() {}');
      return db.migrationTransaction(fn);
    } };
    try {
      expect((await migrateDatabase(wrapped, { directory })).applied).toHaveLength(14);
      expect(marker.authoredUnexpectedMigrationLoaded).toBeUndefined();
      await expect(migrateDatabase(db, { directory })).rejects.toMatchObject({ code: 'MIGRATION_FILES_INVALID' });
    } finally { delete marker.authoredUnexpectedMigrationLoaded; }
  }, 30_000);

  it('rolls back an entire fresh batch including metadata and retries successfully after correction', async () => {
    const db = await database(), directory = await migrations();
    await writeFile(join(directory, '015_authored_failure.sql'), 'CREATE TABLE authored_partial(id int); SELECT * FROM missing_authored_table;');
    await expect(migrateDatabase(db, { directory })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    await metadataAbsent(db);
    expect((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
    await writeFile(join(directory, '015_authored_failure.sql'), 'CREATE TABLE authored_partial(id int);');
    expect((await migrateDatabase(db, { directory })).applied).toHaveLength(15);
  }, 30_000);

  it('rolls back every new pending migration and their ledger rows while retaining old data/history', async () => {
    const db = await database(), directory = await migrations(); await migrateDatabase(db, { directory }); await seed(db);
    const before = await records(db), history = (await db.query('SELECT * FROM qe_schema_migrations ORDER BY id')).rows;
    await writeFile(join(directory, '015_authored_first.sql'), 'CREATE TABLE authored_partial(id int);');
    await writeFile(join(directory, '016_authored_failure.sql'), 'SELECT * FROM missing_authored_table;');
    await expect(migrateDatabase(db, { directory })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    expect((await db.query("SELECT to_regclass('authored_partial') AS name")).rows).toEqual([{ name: null }]);
    expect((await db.query('SELECT * FROM qe_schema_migrations ORDER BY id')).rows).toEqual(history);
    expect((await db.query('SELECT * FROM qe_schema_migration_checksums')).rows).toHaveLength(14);
    expect(await records(db)).toEqual(before);
    await writeFile(join(directory, '016_authored_failure.sql'), 'INSERT INTO authored_partial VALUES (42);');
    expect((await migrateDatabase(db, { directory })).applied).toEqual(['015_authored_first', '016_authored_failure']);
  }, 30_000);

  it('rejects edited or missing applied files and missing checksum rows before new migrations run', async () => {
    const db = await database(), directory = await migrations(); await migrateDatabase(db, { directory });
    const path = join(directory, '001_initial.sql'), original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('\n-- authored edit\n')]));
    await writeFile(join(directory, '015_authored_never.sql'), 'CREATE TABLE authored_never(id int);');
    await expect(migrateDatabase(db, { directory })).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' });
    expect((await db.query("SELECT to_regclass('authored_never') AS name")).rows).toEqual([{ name: null }]);
    await writeFile(path, original); await rm(join(directory, '014_governed_reviews.sql'));
    await expect(migrateDatabase(db, { directory })).rejects.toMatchObject({ code: 'MIGRATION_FILES_INVALID' });
    await db.query("DELETE FROM qe_schema_migration_checksums WHERE name='001_initial'");
    await expect(migrateDatabase(db)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_INVALID' });
  }, 30_000);

  it('rejects matching empty metadata instead of replaying an already initialized domain schema', async () => {
    const db = await database(); await migrateDatabase(db); await seed(db);
    const before = await records(db);
    await db.exec('DELETE FROM qe_schema_migration_checksums; DELETE FROM qe_schema_migrations;');
    const statements: string[] = [];
    const wrapped: Database = { ...db, migrationTransaction: fn => db.migrationTransaction(tx => fn({
      query: (sql, params) => { statements.push(sql); return tx.query(sql, params); },
    })) };
    await expect(migrateDatabase(wrapped)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_INVALID' });
    expect(statements.some(sql => /CREATE |ALTER |INSERT |UPDATE |DELETE /i.test(sql))).toBe(false);
    expect(await records(db)).toEqual(before);
  }, 30_000);

  it('resolves real catalogs before public or temporary shadows while creating tables in public', async () => {
    const db = await database();
    await db.exec(`CREATE TABLE public.pg_trigger(tgname text); INSERT INTO public.pg_trigger VALUES ('qe_rule_bundles_immutable');
      CREATE TEMP TABLE pg_trigger(tgname text); INSERT INTO pg_temp.pg_trigger VALUES ('qe_rule_bundles_immutable');`);
    expect((await migrateDatabase(db)).applied).toHaveLength(14);
    await seed(db);
    await expect(db.query('UPDATE public.qe_rule_bundles SET version=$1', ['v2'])).rejects.toThrow(/append-only/);
    expect((await db.query("SELECT to_regclass('public.qe_rule_bundles') AS name")).rows).toEqual([{ name: 'qe_rule_bundles' }]);
  }, 30_000);

  it('rejects incomplete, duplicate, reordered and unknown history rather than repairing it by replay', async () => {
    const db = await database(); await migrateDatabase(db);
    await db.query("INSERT INTO qe_schema_migrations(name,run_on) VALUES ('001_initial',NOW())");
    await expect(migrateDatabase(db)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_INVALID' });
    await db.query('DELETE FROM qe_schema_migrations WHERE id=15');
    await db.query("UPDATE qe_schema_migrations SET name='unknown_authored_migration' WHERE id=1");
    await expect(migrateDatabase(db)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_INVALID' });
    await db.query("UPDATE qe_schema_migrations SET name='001_initial', run_on=NOW() WHERE id=1");
    await expect(migrateDatabase(db)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_INVALID' });
    await db.exec('DROP TABLE qe_schema_migration_checksums');
    await expect(migrateDatabase(db)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_INVALID' });
  }, 30_000);
});

describe('explicit legacy adoption', () => {
  it('inspects without DDL, refuses ordinary opening, and adopts a populated full legacy database without replay', async () => {
    const db = await database(); await legacy(db); await seed(db); const before = await records(db);
    const inspection = await inspectDatabaseMigrations(db);
    expect(inspection.state).toBe('legacy-untracked'); expect(inspection.inventory.relations.filter(row => row.kind === 'r')).toHaveLength(31);
    await metadataAbsent(db);
    await expect(migrateDatabase(db)).rejects.toMatchObject({ code: 'LEGACY_SCHEMA_REQUIRES_ADOPTION' });
    await metadataAbsent(db);
    const statements: string[] = [], wrapped: Database = { ...db, migrationTransaction: fn => db.migrationTransaction(tx => fn({
      query: (sql, params) => { statements.push(sql); return tx.query(sql, params); },
    })) };
    const adoption = { through: '014_governed_reviews', schemaFingerprint: inspection.schemaFingerprint };
    expect(await migrateDatabase(wrapped, { adoptLegacy: adoption })).toEqual({ applied: [], adopted: LEGACY_BASELINE.map(file => file.name), current: '014_governed_reviews' });
    expect(statements.some(sql => sql.includes('CREATE OR REPLACE FUNCTION'))).toBe(false);
    expect(statements.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS qe_rule_bundles'))).toBe(false);
    expect((await db.query('SELECT DISTINCT applied_via,baseline_fingerprint FROM qe_schema_migration_checksums')).rows)
      .toEqual([{ applied_via: 'legacy-adoption', baseline_fingerprint: inspection.schemaFingerprint }]);
    expect(await records(db)).toEqual(before);
    expect((await db.query('SELECT * FROM qe_case_lineages')).rows).toEqual([{ id: 'legacy-lineage', split: 'training' }]);
    await expect(db.query('DELETE FROM qe_rule_bundles')).rejects.toThrow(/append-only/);
    await expect(migrateDatabase(db, { adoptLegacy: adoption })).rejects.toMatchObject({ code: 'LEGACY_ADOPTION_INVALID' });
  }, 30_000);

  it('adopts an older 013 prefix and applies only 014 without rewriting existing evidence', async () => {
    const db = await database(); await legacy(db, 13); await seed(db); const before = await records(db);
    const { schemaFingerprint } = await inspectDatabaseMigrations(db);
    const result = await migrateDatabase(db, { adoptLegacy: { through: '013_repository_contexts', schemaFingerprint } });
    expect(result.adopted).toHaveLength(13); expect(result.applied).toEqual(['014_governed_reviews']);
    expect(await records(db)).toEqual(before);
    expect((await db.query("SELECT applied_via,baseline_fingerprint FROM qe_schema_migration_checksums WHERE name='014_governed_reviews'")).rows)
      .toEqual([{ applied_via: 'migration', baseline_fingerprint: null }]);
  }, 30_000);

  it('rejects stale review fingerprints, wrong prefix, unsupported versions and modified baseline bytes atomically', async () => {
    const db = await database(), directory = await migrations(); await legacy(db);
    const inspection = await inspectDatabaseMigrations(db);
    await db.exec('ALTER TABLE qe_rule_bundles ADD COLUMN authored_drift text');
    await expect(migrateDatabase(db, { adoptLegacy: { through: '014_governed_reviews', schemaFingerprint: inspection.schemaFingerprint } }))
      .rejects.toMatchObject({ code: 'LEGACY_ADOPTION_MISMATCH' });
    const { schemaFingerprint } = await inspectDatabaseMigrations(db);
    expect(schemaFingerprint).not.toBe(inspection.schemaFingerprint);
    for (const through of ['013_repository_contexts', '999_unknown']) await expect(migrateDatabase(db, { adoptLegacy: { through, schemaFingerprint } }))
      .rejects.toMatchObject({ code: 'LEGACY_ADOPTION_INVALID' });
    await writeFile(join(directory, '001_initial.sql'), (await readFile(join(directory, '001_initial.sql'), 'utf8')) + '\n-- edited baseline\n');
    await expect(migrateDatabase(db, { directory, adoptLegacy: { through: '014_governed_reviews', schemaFingerprint } }))
      .rejects.toMatchObject({ code: 'LEGACY_ADOPTION_INVALID' });
    await metadataAbsent(db);
  }, 30_000);

  it('fingerprints changed trigger enablement, functions and constraints rather than only table names', async () => {
    const db = await database(); await legacy(db);
    const original = (await inspectDatabaseMigrations(db)).schemaFingerprint;
    await db.exec('ALTER TABLE qe_rule_bundles DISABLE TRIGGER qe_rule_bundles_immutable');
    const trigger = (await inspectDatabaseMigrations(db)).schemaFingerprint;
    expect(trigger).not.toBe(original);
    await db.exec("CREATE OR REPLACE FUNCTION qe_reject_mutation() RETURNS trigger AS $$ BEGIN RETURN OLD; END; $$ LANGUAGE plpgsql");
    const routine = (await inspectDatabaseMigrations(db)).schemaFingerprint;
    expect(routine).not.toBe(trigger);
    await db.exec('ALTER TABLE qe_rule_bundles DROP CONSTRAINT qe_rule_bundles_rule_id_version_key');
    expect((await inspectDatabaseMigrations(db)).schemaFingerprint).not.toBe(routine);
  }, 30_000);

  it('refuses partial/orphan legacy and non-public schemas rather than silently constructing a second database', async () => {
    const db = await database();
    await db.exec('CREATE FUNCTION qe_orphan() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
    await expect(migrateDatabase(db)).rejects.toMatchObject({ code: 'LEGACY_SCHEMA_REQUIRES_ADOPTION' });
    const { schemaFingerprint } = await inspectDatabaseMigrations(db);
    await expect(migrateDatabase(db, { adoptLegacy: { through: '014_governed_reviews', schemaFingerprint } })).rejects.toMatchObject({ code: 'LEGACY_ADOPTION_INVALID' });
    await db.exec('DROP FUNCTION qe_orphan(); CREATE SCHEMA authored_legacy; CREATE TABLE authored_legacy.qe_rule_bundles(id text);');
    await expect(migrateDatabase(db)).rejects.toMatchObject({ code: 'MIGRATION_SCHEMA_UNSUPPORTED' });
    await metadataAbsent(db);
    expect((await db.query("SELECT to_regclass('public.qe_rule_bundles') AS name")).rows).toEqual([{ name: null }]);
  }, 30_000);

  it('rolls back adopted history and all pending DDL on failure, leaving a retryable untouched legacy database', async () => {
    const db = await database(), directory = await migrations(); await legacy(db, 13); await seed(db); const before = await records(db);
    const adoption = { through: '013_repository_contexts', schemaFingerprint: (await inspectDatabaseMigrations(db)).schemaFingerprint };
    await writeFile(join(directory, '015_authored_failure.sql'), 'SELECT * FROM missing_authored_table;');
    await expect(migrateDatabase(db, { directory, adoptLegacy: adoption })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    await metadataAbsent(db);
    expect((await db.query("SELECT to_regclass('qe_governed_review_plans') AS name")).rows).toEqual([{ name: null }]);
    expect(await records(db)).toEqual(before);
    expect((await inspectDatabaseMigrations(db)).schemaFingerprint).toBe(adoption.schemaFingerprint);
    await rm(join(directory, '015_authored_failure.sql'));
    expect((await migrateDatabase(db, { directory, adoptLegacy: adoption })).applied).toEqual(['014_governed_reviews']);
  }, 30_000);

  it('allows only one concurrent adoption and preserves exactly one complete history', async () => {
    const db = await database(); await legacy(db);
    const adoptLegacy = { through: '014_governed_reviews', schemaFingerprint: (await inspectDatabaseMigrations(db)).schemaFingerprint };
    const results = await Promise.allSettled([migrateDatabase(db, { adoptLegacy }), migrateDatabase(db, { adoptLegacy })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await db.query('SELECT * FROM qe_schema_migrations')).rows).toHaveLength(14);
    expect((await db.query('SELECT * FROM qe_schema_migration_checksums')).rows).toHaveLength(14);
  }, 30_000);

  it('preserves the initialization error when cleanup also fails', async () => {
    const db = await database(); await legacy(db);
    const close = vi.fn(async () => { throw new Error('authored cleanup failure'); });
    await expect(QualEvoStore.initialize({ ...db, close })).rejects.toMatchObject({ code: 'LEGACY_SCHEMA_REQUIRES_ADOPTION' });
    expect(close).toHaveBeenCalledOnce();
  }, 30_000);
});
