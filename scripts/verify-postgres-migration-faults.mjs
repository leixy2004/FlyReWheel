import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { mkdtemp, readdir, copyFile, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { openPostgresDatabase } from '../dist/storage/database.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../dist/storage/migrations.js';

// Explicitly isolated real-server experiment. No container/network/auth changes.
// Usage: node scripts/verify-postgres-migration-faults.mjs /absolute/socket /absolute/evidence.json
const database = 'flyrewheel_verify_migration_faults';
const childMode = process.argv[2] === '--child';
const [socket, evidencePath, directory, label] = process.argv.slice(childMode ? 3 : 2);
assert(socket?.startsWith('/'), 'Explicit absolute local Unix socket required');
const connectionString = `postgresql://postgres@/${database}?host=${encodeURIComponent(socket)}`;
const root = fileURLToPath(new URL('../', import.meta.url));

async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

if (childMode) {
  const db = await openPostgresDatabase(`${connectionString}&application_name=${encodeURIComponent(label)}`);
  const originalTransaction = db.migrationTransaction.bind(db);
  let resume;
  const resumed = new Promise(done => { resume = done; });
  process.on('message', message => { if (message === 'resume') resume(); });
  db.migrationTransaction = callback => originalTransaction(async tx => {
    if (label !== 'migration-fault-victim') {
      process.send({ acquired: true });
      await resumed;
    }
    return callback({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (label === 'migration-fault-victim' && sql.includes('CREATE TABLE qe_migration_fault_probe')) {
        process.send({ probeExecuted: true });
        await new Promise(() => {}); // fault seam: real SQL finished, transaction remains open
      }
      return result;
    } });
  });
  try {
    const result = await migrateDatabase(db, { directory });
    process.send({ result });
  } finally {
    await db.close();
    process.disconnect();
  }
} else {
  assert(evidencePath?.startsWith('/'), 'Explicit absolute evidence path required');
  const admin = new pg.Client({ host: socket, user: 'postgres', database: 'postgres' });
  await admin.connect();
  try {
    // Never reset or drop an existing database, even this experiment's own DB.
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) {
      await admin.query(`CREATE DATABASE ${database}`);
    }
  } finally { await admin.end(); }

  const observer = new pg.Client({ host: socket, user: 'postgres', database });
  await observer.connect();
  const migrationDirectory = await mkdtemp(join(tmpdir(), 'flyrewheel-migration-faults-'));
  const children = [];
  function spawn(name) {
    const processHandle = fork(fileURLToPath(import.meta.url), ['--child', socket, evidencePath, migrationDirectory, name],
      { env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let result;
    const state = {};
    processHandle.on('message', message => { Object.assign(state, message); if (message.result) result = message.result; });
    const done = new Promise(resolveDone => {
      processHandle.once('exit', (code, signal) => resolveDone({ code, signal, result }));
      processHandle.once('error', error => resolveDone({ error: String(error) }));
    });
    const child = { processHandle, done, state };
    children.push(child);
    return child;
  }
  async function lockCounts() {
    return (await observer.query(`SELECT a.application_name AS name, l.objid::int AS key,
      l.granted FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.datname=$1 AND l.locktype='advisory' AND l.classid=727413
      AND a.application_name LIKE 'migration-fault-%' ORDER BY name,key`, [database])).rows;
  }
  try {
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n, 0, 'Dedicated database must be empty; never resets existing data');
    assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database])).rows[0].n, 0, 'Dedicated database must have no other sessions');
    const server = (await observer.query('SELECT version() AS version')).rows[0].version;
    assert.match(server, /^PostgreSQL /);
    const names = (await readdir(MIGRATIONS_DIRECTORY)).sort();
    const hashes = {};
    for (const name of names) {
      assert.match(name, /^\d+_[a-z0-9_]+\.sql$/);
      await copyFile(join(MIGRATIONS_DIRECTORY, name), join(migrationDirectory, name));
      hashes[name] = createHash('sha256').update(await readFile(join(migrationDirectory, name))).digest('hex');
      // Ensure compiled SQL tested here matches the source tree.
      assert.equal(hashes[name], createHash('sha256').update(await readFile(join(root, 'src/storage/migrations', name))).digest('hex'));
    }
    const probeName = `${String(names.length + 1).padStart(3, '0')}_migration_fault_probe`;
    const probeSql = `CREATE TABLE qe_migration_fault_probe (id integer PRIMARY KEY);\nINSERT INTO qe_migration_fault_probe VALUES (1);\n`;
    await writeFile(join(migrationDirectory, `${probeName}.sql`), probeSql);
    const victim = spawn('migration-fault-victim');
    await until(async () => victim.state.probeExecuted, 'victim completes real probe DDL inside open migration transaction');
    const waiters = [spawn('migration-fault-waiter-a'), spawn('migration-fault-waiter-b')];
    const beforeKill = await until(async () => {
      const rows = await lockCounts();
      return rows.filter(row => row.key === 1 && !row.granted).length === 2 && rows;
    }, 'both independent migration processes wait on production advisory lock');
    victim.processHandle.kill('SIGKILL');
    const victimExit = await victim.done;
    assert.equal(victimExit.signal, 'SIGKILL');
    await until(async () => {
      const rows = await lockCounts();
      return !rows.some(row => row.name === 'migration-fault-victim')
        && waiters.some(child => child.state.acquired);
    }, 'victim backend releases lock and waiting migration reaches probe');
    const rolledBack = (await observer.query(`SELECT to_regclass('public.qe_migration_fault_probe')::text AS probe,
      to_regclass('public.qe_schema_migrations')::text AS history,
      to_regclass('public.qe_schema_migration_checksums')::text AS checksums`)).rows[0];
    assert.deepEqual(rolledBack, { probe: null, history: null, checksums: null });
    for (const waiter of waiters) waiter.processHandle.send('resume');
    const completed = await Promise.race([
      Promise.all(waiters.map(child => child.done)),
      delay(20000, null, { ref: false }).then(() => { throw new Error('Waiter completion timed out'); }),
    ]);
    for (const result of completed) { assert.equal(result.code, 0); assert.equal(result.signal, null); }
    assert.deepEqual(completed.map(child => child.result.applied.length).sort((a, b) => a - b), [0, names.length + 1]);
    const ledger = (await observer.query(`SELECT count(*)::int AS count, count(DISTINCT name)::int AS unique_count FROM qe_schema_migrations`)).rows[0];
    assert.deepEqual(ledger, { count: names.length + 1, unique_count: names.length + 1 });
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM qe_schema_migration_checksums')).rows[0].count, names.length + 1);
    assert.deepEqual((await observer.query('SELECT * FROM qe_migration_fault_probe')).rows, [{ id: 1 }]);
    assert.deepEqual(await lockCounts(), []);
    const evidence = {
      recordedAt: new Date().toISOString(), baseline: {
        sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
      }, server, database, backend: 'real PostgreSQL via local Unix socket',
      modelExecution: 'not_run', deployment: 'existing temporary Docker PostgreSQL only',
      experiment: 'SIGKILL actual Node migration process while actual PostgreSQL transaction owns production advisory lock',
      packagedMigrationHashes: hashes, syntheticProbe: { name: probeName, sha256: createHash('sha256').update(probeSql).digest('hex') },
      beforeKill, victimExit, rolledBackVisibleState: rolledBack,
      waiters: completed, ledger, probeRows: 1, advisoryLocksRemaining: 0,
      limitations: ['Fault seam pauses JavaScript after actual appended migration SQL; all database operations use real adapters, no production data used',
        'Does not restart PostgreSQL or prove storage durability after host failure', 'No real model execution or application deployment'],
    };
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ evidencePath: resolve(evidencePath), baseline: evidence.baseline, server, victimExit,
      waiterApplied: completed.map(child => child.result.applied.length), ledger, status: 'passed' }));
  } finally {
    for (const child of children) if (child.processHandle.exitCode === null && child.processHandle.signalCode === null) child.processHandle.kill('SIGKILL');
    await Promise.all(children.map(child => child.done));
    await observer.end();
    await rm(migrationDirectory, { recursive: true, force: true });
  }
}
