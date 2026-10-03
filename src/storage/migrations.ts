import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner, type RunnerOption } from 'node-pg-migrate';
import type { ClientBase } from 'pg';
import type { Database, Queryable } from './database.js';
import { LEGACY_BASELINE } from './legacy-baseline.js';

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url));
const HISTORY = 'qe_schema_migrations';
const CHECKSUMS = 'qe_schema_migration_checksums';
const metadataNames = [HISTORY, `${HISTORY}_id_seq`, `${HISTORY}_pkey`, CHECKSUMS, `${CHECKSUMS}_pkey`];
const quiet = { info() {}, warn() {}, error() {} };
// Strict end-of-name: JavaScript's $ also accepts a final newline.
const SQL_FILENAME = '[0-9]{3,}_[a-z0-9_]+\\.sql(?![\\s\\S])';
export class MigrationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'MigrationError'; }
}
function fail(code: string, message: string): never { throw new MigrationError(code, message); }
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
interface MigrationFile { name: string; path: string; sql: string; checksum: string }
export interface LegacyAdoption {
  /** Exact migration name, without .sql. An operator attests this entire prefix already exists. */
  through: string;
  /** Fingerprint from a reviewed inspectDatabaseMigrations result, not a schema compatibility proof. */
  schemaFingerprint: string;
}
export interface MigrationOptions { directory?: string; adoptLegacy?: LegacyAdoption }
export interface MigrationResult { applied: string[]; adopted: string[]; current: string | null }

async function filesFrom(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.length || entries.some(entry => !entry.isFile() || !new RegExp(`^${SQL_FILENAME}`).test(entry.name))) {
    fail('MIGRATION_FILES_INVALID', 'Migration directory must contain only numbered SQL files');
  }
  const names = entries.map(entry => entry.name).sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
  for (let index = 0; index < names.length; index++) {
    if (Number(names[index].split('_')[0]) !== index + 1) fail('MIGRATION_FILES_INVALID', 'Migration versions must be a consecutive append-only sequence beginning at 001');
  }
  return Promise.all(names.map(async filename => {
    const path = resolve(directory, filename), bytes = await readFile(path);
    return { name: basename(filename, '.sql'), path, sql: new TextDecoder('utf-8', { fatal: true }).decode(bytes), checksum: sha256(bytes) };
  }));
}

async function requirePublicSchema(tx: Queryable): Promise<void> {
  const { rows } = await tx.query(`SELECT n.nspname AS schema FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'public' AND starts_with(c.relname,'qe_')
    UNION SELECT n.nspname AS schema FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname <> 'public' AND starts_with(p.proname,'qe_')`);
  if (rows.length) fail('MIGRATION_SCHEMA_UNSUPPORTED', 'FlyReWheel objects exist outside public; review and explicitly relocate the legacy schema before migration. A second schema will not be created');
}
async function historyExists(tx: Queryable): Promise<boolean> {
  const { rows } = await tx.query<{ history: string | null; checksums: string | null }>(
    "SELECT to_regclass('public.qe_schema_migrations')::text AS history, to_regclass('public.qe_schema_migration_checksums')::text AS checksums");
  if (!rows[0] || Boolean(rows[0].history) !== Boolean(rows[0].checksums)) {
    fail('MIGRATION_HISTORY_INVALID', 'Migration history is incomplete; restore its matching history and checksum tables before retrying');
  }
  return Boolean(rows[0].history);
}
async function history(tx: Queryable, files: MigrationFile[]): Promise<string[]> {
  const { rows } = await tx.query<{ name: string; checksum: string | null }>(
    `SELECT h.name, c.checksum FROM public.${HISTORY} h LEFT JOIN public.${CHECKSUMS} c ON c.name=h.name ORDER BY h.run_on, h.id`);
  const checksums = (await tx.query(`SELECT name FROM public.${CHECKSUMS}`)).rows;
  if (!rows.length || checksums.length !== rows.length || rows.length > files.length) fail('MIGRATION_HISTORY_INVALID', 'Migration history does not match packaged migrations');
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].name !== files[index].name || !rows[index].checksum) fail('MIGRATION_HISTORY_INVALID', 'Migration history is not a complete ordered prefix of packaged migrations');
    if (rows[index].checksum !== files[index].checksum) fail('MIGRATION_CHECKSUM_MISMATCH', `Applied migration ${files[index].name} has changed; restore its original bytes and add a new migration instead`);
  }
  return rows.map(row => row.name);
}

/** Domain catalog only, never domain row contents. This is a review/TOCTOU guard,
 * not a claim that catalog text is portable between PostgreSQL major versions. */
async function schemaInventory(tx: Queryable) {
  const relations = (await tx.query(`SELECT c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence,
    c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND starts_with(c.relname, 'qe_') AND NOT (c.relname=ANY($1::text[])) ORDER BY c.relname`, [metadataNames])).rows;
  const columns = (await tx.query(`SELECT c.relname AS relation, a.attname AS name, a.attnum AS position,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
    a.attidentity AS identity, a.attgenerated AS generated, a.attisdropped AS dropped,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression, co.collname AS collation
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname='public' AND starts_with(c.relname,'qe_') AND a.attnum>0
    AND NOT (c.relname=ANY($1::text[])) ORDER BY c.relname,a.attnum`, [metadataNames])).rows;
  const constraints = (await tx.query(`SELECT c.relname AS relation, k.conname AS name, k.contype AS type,
    k.convalidated AS validated, pg_catalog.pg_get_constraintdef(k.oid) AS definition
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND starts_with(c.relname,'qe_') AND NOT (c.relname=ANY($1::text[]))
    ORDER BY c.relname,k.conname`, [metadataNames])).rows;
  const indexes = (await tx.query(`SELECT c.relname AS relation, x.relname AS name,
    i.indisvalid AS valid, i.indisready AS ready, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
    JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND starts_with(c.relname,'qe_') AND NOT (c.relname=ANY($1::text[]))
    ORDER BY c.relname,x.relname`, [metadataNames])).rows;
  const triggers = (await tx.query(`SELECT c.relname AS relation, t.tgname AS name, t.tgenabled AS enabled,
    t.tgisinternal AS internal, pg_catalog.pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND starts_with(c.relname,'qe_') AND NOT (c.relname=ANY($1::text[]))
    ORDER BY c.relname,t.tgname`, [metadataNames])).rows;
  const routines = (await tx.query(`SELECT p.proname AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_catalog.pg_get_functiondef(p.oid) AS definition FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'qe_')
    ORDER BY p.proname,arguments`)).rows;
  const policies = (await tx.query(`SELECT * FROM pg_catalog.pg_policies WHERE schemaname='public' AND starts_with(tablename,'qe_') ORDER BY tablename,policyname`)).rows;
  const rules = (await tx.query(`SELECT * FROM pg_catalog.pg_rules WHERE schemaname='public' AND starts_with(tablename,'qe_') ORDER BY tablename,rulename`)).rows;
  return { formatVersion: 1, relations, columns, constraints, indexes, triggers, routines, policies, rules };
}

async function run(tx: Queryable, files: MigrationFile[], directory: string, count: number, fake = false) {
  // Use the public loader API to execute precisely the bytes we hashed. The outer
  // adapter transaction owns locking/rollback, including fake adoption and checksums.
  const loader: Exclude<NonNullable<RunnerOption['migrationLoaderStrategies']>[number]['loader'], string> = async paths => {
    if (paths.length !== files.length || paths.some((path, index) => path !== files[index].path)) {
      fail('MIGRATION_FILES_INVALID', 'Migration inventory changed while opening the database');
    }
    return files.map(file => ({ id: file.path, filePaths: [file.path], actions: {
      up: pgm => { pgm.noTransaction(); pgm.sql(file.sql); }, down: false,
    } }));
  };
  await runner({ dbClient: tx as unknown as ClientBase, dir: directory,
    migrationsTable: HISTORY, migrationsSchema: 'public', direction: 'up', count,
    // Prevent the upstream fallback JS loader if a non-SQL file appears after our snapshot.
    ignorePattern: `(?!${SQL_FILENAME})[\\s\\S]*`,
    checkOrder: true, noLock: true, singleTransaction: false, fake, logger: quiet,
    migrationLoaderStrategies: [{ extensions: ['.sql'], loader }] });
}
async function recordChecksums(tx: Queryable, files: MigrationFile[], adoption?: LegacyAdoption) {
  for (const file of files) await tx.query(`INSERT INTO public.${CHECKSUMS} (name,checksum,applied_via,baseline_fingerprint)
    VALUES ($1,$2,$3,$4)`, [file.name, file.checksum, adoption ? 'legacy-adoption' : 'migration', adoption?.schemaFingerprint ?? null]);
}

export async function migrateDatabase(db: Database, options: MigrationOptions = {}): Promise<MigrationResult> {
  const directory = resolve(options.directory ?? MIGRATIONS_DIRECTORY);
  try {
    const files = await filesFrom(directory);
    if (options.adoptLegacy && (!/^[a-f0-9]{64}$/.test(options.adoptLegacy.schemaFingerprint)
      || !files.some(file => file.name === options.adoptLegacy!.through))) {
      fail('LEGACY_ADOPTION_INVALID', 'Legacy adoption requires a packaged through-version and reviewed SHA-256 schema fingerprint');
    }
    return await db.migrationTransaction(async tx => {
      // Implicit pg_catalog comes first; public remains the creation target and
      // explicitly placing pg_temp last prevents temporary catalog-name shadows.
      await tx.query('SET LOCAL search_path TO public, pg_temp');
      await requirePublicSchema(tx);
      const exists = await historyExists(tx);
      let applied: string[] = [], adopted: string[] = [];
      if (exists) {
        if (options.adoptLegacy) fail('LEGACY_ADOPTION_INVALID', 'Versioned history already exists; legacy adoption cannot replace it');
        applied = await history(tx, files);
      } else {
        const inventory = await schemaInventory(tx);
        const legacy = inventory.relations.length > 0 || inventory.routines.length > 0;
        if (legacy && !options.adoptLegacy) fail('LEGACY_SCHEMA_REQUIRES_ADOPTION',
          'Untracked legacy schema found; back up and review database inspect, then explicitly run database adopt before opening this store');
        if (options.adoptLegacy && (!legacy || sha256(JSON.stringify(inventory)) !== options.adoptLegacy.schemaFingerprint)) {
          fail('LEGACY_ADOPTION_MISMATCH', 'Legacy schema is absent or changed since inspection; inspect and review it again');
        }
        if (options.adoptLegacy) {
          const last = LEGACY_BASELINE.findIndex(file => file.name === options.adoptLegacy!.through);
          if (last < 0) fail('LEGACY_ADOPTION_INVALID', 'Only the frozen pre-ledger migration prefixes 001 through 014 can be adopted');
          const prefix = LEGACY_BASELINE.slice(0, last + 1);
          const expectedTables = prefix.flatMap(file => [...file.tables]).sort();
          const actualTables = inventory.relations.filter(row => row.kind === 'r' || row.kind === 'p').map(row => row.name).sort();
          const expectedRoutines = prefix.flatMap(file => [...file.routines]).sort();
          if (prefix.some((file, index) => file.name !== files[index]?.name || file.checksum !== files[index]?.checksum)
            || JSON.stringify(expectedTables) !== JSON.stringify(actualTables)
            || JSON.stringify(expectedRoutines) !== JSON.stringify(inventory.routines.map(row => row.name).sort())
            || inventory.relations.some(row => !['r','i'].includes(String(row.kind)))) {
            fail('LEGACY_ADOPTION_INVALID', 'Legacy objects or historical SQL bytes do not match the selected frozen prefix; review and repair explicitly before adoption');
          }
        }
        await run(tx, files, directory, 0);
        await tx.query(`CREATE TABLE public.${CHECKSUMS} (name varchar(255) PRIMARY KEY,
          checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
          applied_via text NOT NULL CHECK(applied_via IN ('migration','legacy-adoption')),
          baseline_fingerprint text CHECK(baseline_fingerprint ~ '^[a-f0-9]{64}$'),
          CHECK((applied_via='legacy-adoption')=(baseline_fingerprint IS NOT NULL)))`);
        if (options.adoptLegacy) {
          const prefix = files.slice(0, files.findIndex(file => file.name === options.adoptLegacy!.through) + 1);
          await run(tx, files, directory, prefix.length, true);
          await recordChecksums(tx, prefix, options.adoptLegacy);
          adopted = prefix.map(file => file.name); applied = adopted;
        }
      }
      const pending = files.slice(applied.length);
      if (pending.length) {
        await run(tx, files, directory, pending.length);
        await recordChecksums(tx, pending);
      }
      await history(tx, files);
      return { applied: pending.map(file => file.name), adopted, current: files.at(-1)?.name ?? null };
    });
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    // node-pg-migrate can embed query/error text in errors. Never expose driver
    // credentials or domain SQL through a CLI, worker log or error cause.
    throw new MigrationError('MIGRATION_FAILED', 'Database migration did not return a confirmed result; inspect migration history, secured database logs and packaged files before retrying');
  }
}

/** Inspection does not create history or run any migration. */
export async function inspectDatabaseMigrations(db: Database, directory = MIGRATIONS_DIRECTORY) {
  const files = await filesFrom(directory);
  return db.migrationTransaction(async tx => {
    await tx.query('SET LOCAL search_path TO public, pg_temp');
    await requirePublicSchema(tx);
    const exists = await historyExists(tx), inventory = await schemaInventory(tx);
    const applied = exists ? await history(tx, files) : [];
    return { state: exists ? 'versioned' : inventory.relations.length || inventory.routines.length ? 'legacy-untracked' : 'empty',
      applied, pending: files.slice(applied.length).map(file => file.name),
      schemaFingerprint: sha256(JSON.stringify(inventory)), inventory,
      adoptionMeaning: 'Fingerprint detects changes since review; an operator must attest the selected migration prefix and compatibility. It does not prove historical execution.' };
  });
}
