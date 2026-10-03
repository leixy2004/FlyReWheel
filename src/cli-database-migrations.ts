import { Command } from 'commander';
import { databaseCommand } from './cli-database.js';
import { resolveDatabaseSelection, type DatabaseOptions } from './storage/connection.js';
import { openPGliteDatabase, openPostgresDatabase, type Database } from './storage/database.js';
import { inspectDatabaseMigrations, migrateDatabase } from './storage/migrations.js';

async function withDatabase(options: DatabaseOptions, action: (db: Database) => Promise<unknown>) {
  const selection = resolveDatabaseSelection(options, process.env);
  const db = selection.kind === 'pglite' ? await openPGliteDatabase(selection.path) : await openPostgresDatabase(selection.connectionString);
  try { process.stdout.write(JSON.stringify(await action(db), null, 2) + '\n'); }
  finally { await db.close(); }
}
/** Narrow operator path: never opens a domain store before inspecting/adopting its schema. */
export function registerDatabaseMigrationCommands(cli: Command): void {
  const database = cli.command('database').description('Inspect migration history or explicitly adopt a reviewed legacy schema');
  databaseCommand(database, 'inspect').description('Read schema inventory/history without applying migrations')
    .action(options => withDatabase(options, db => inspectDatabaseMigrations(db)));
  databaseCommand(database, 'migrate').description('Apply pending migrations atomically; refuse untracked legacy schemas')
    .action(options => withDatabase(options, db => migrateDatabase(db)));
  databaseCommand(database, 'adopt').description('Attest a reviewed legacy prefix, record it without replay, then apply only newer migrations')
    .requiredOption('--through <migration>', 'Exact already-applied name, for example 014_governed_reviews; operator attests compatibility')
    .requiredOption('--schema-fingerprint <sha256>', 'Exact fingerprint from reviewed database inspect output; stop old clients and back up first')
    .action(options => withDatabase(options, db => migrateDatabase(db, { adoptLegacy: {
      through: options.through, schemaFingerprint: options.schemaFingerprint,
    } })));
}
