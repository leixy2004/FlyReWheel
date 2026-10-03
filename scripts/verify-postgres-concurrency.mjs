import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openPostgresDatabase } from '../dist/storage/database.js';
import { QualEvoStore } from '../dist/storage/store.js';
import { ApplicationJobSchema, applicationJobDigest } from '../dist/application-job-contract.js';
import { openQueue, enqueueApplication, applicationJobId, APPLICATION_QUEUE } from '../dist/jobs.js';

// Explicit disposable DB only; no models, container changes, or credential configuration.
// Run with an outer bound: timeout 120s node scripts/verify-postgres-concurrency.mjs verify SOCKET EVIDENCE
const [phase, socket, evidencePath] = process.argv.slice(2);
assert(['verify', 'child'].includes(phase));
assert(socket?.startsWith('/'), 'An explicit absolute Unix socket path is required');
assert(evidencePath?.startsWith('/'), 'An absolute evidence path is required');
const database = 'flyrewheel_verify_concurrency';
const uri = name => `postgresql://postgres@/${name}?host=${encodeURIComponent(socket)}`;
const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'semantic-review',
  workspaceId: 'postgres-multiprocess-concurrency', ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) });
const terminalResult = { status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason: 'runtime_unavailable' };
const queueOptions = { connectionString: uri(database), schedule: false, supervise: false };
const script = fileURLToPath(import.meta.url);
const startedAt = new Date().toISOString();

if (phase === 'child') {
  assert(process.send, 'Child requires IPC');
  const db = await openPostgresDatabase(uri(database));
  const store = await QualEvoStore.initialize(db);
  const boss = await openQueue(queueOptions);
  const firstOwner = randomUUID();
  let owner = firstOwner;
  process.on('message', async ({ id, action }) => {
    try {
      let result;
      if (action === 'enqueue') result = await enqueueApplication(boss, job);
      else if (action === 'claim' || action === 'reclaim') {
        if (action === 'reclaim') owner = randomUUID();
        result = await store.claimApplicationJob(job, owner);
      } else if (action === 'nonowner' || action === 'stale') {
        await assert.rejects(store.completeApplicationJob(job, action === 'stale' ? firstOwner : owner, terminalResult),
          { code: 'APPLICATION_JOB_FENCED' });
        result = 'APPLICATION_JOB_FENCED';
      } else if (action === 'release') {
        await store.failApplicationJob(job, owner, { status: 'failed', modelExecution: 'not_run', cleanup: 'not_started', reason: 'runtime_failed' });
        result = 'retryable';
      } else if (action === 'complete') result = await store.completeApplicationJob(job, owner, terminalResult);
      else if (action === 'stop') {
        await boss.stop({ graceful: true }); await db.close();
        process.send({ id, result: 'stopped' }, () => process.disconnect());
        return;
      } else throw new Error('Unknown child action');
      process.send({ id, result });
    } catch (error) {
      // Only typed failure metadata, never raw DB/CLI messages.
      process.send({ id, error: { name: error.name, code: error.code ?? 'CHILD_FAILURE' } });
    }
  });
  process.send({ ready: true, pid: process.pid });
} else {
  const admin = await openPostgresDatabase(uri('postgres'));
  try {
    assert.equal((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [database])).rows.length, 0,
      'Dedicated database already exists; refuse to reuse or delete it');
    await admin.query('CREATE DATABASE flyrewheel_verify_concurrency');
  } finally { await admin.close(); }
  const db = await openPostgresDatabase(uri(database));
  const children = [];
  let boss;
  const request = (child, action) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
    const message = response => {
      if (response.id !== id) return;
      cleanup();
      if (response.error) reject(new Error(`Child ${action} failed: ${response.error.code}`));
      else resolve(response.result);
    };
    const exit = () => { cleanup(); reject(new Error(`Child exited during ${action}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Child ${action} timed out`)); }, 20000);
    child.on('message', message); child.once('exit', exit);
    child.send({ id, action });
  });
  try {
    const server = (await db.query('SELECT version() AS version')).rows[0].version;
    assert.match(server, /^PostgreSQL 17\./);
    const store = await QualEvoStore.initialize(db);
    boss = await openQueue(queueOptions);
    const readiness = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = fork(script, ['child', socket, evidencePath], { env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.push(child);
      const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
      const message = value => { if (value.ready) { cleanup(); resolve(value.pid); } };
      const exit = () => { cleanup(); reject(new Error('Child exited before readiness')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Child readiness timed out')); }, 20000);
      child.on('message', message); child.once('exit', exit);
    }));
    const pids = await Promise.all(readiness);
    assert.equal(new Set(pids).size, 4);
    const enqueued = await Promise.all(children.map(child => request(child, 'enqueue')));
    assert.equal(enqueued.filter(id => id === applicationJobId(job)).length, 1);
    assert.equal(enqueued.filter(id => id === null).length, 3);
    const queueCount = (await db.query('SELECT count(*)::int AS count FROM pgboss.job WHERE name=$1 AND id=$2',
      [APPLICATION_QUEUE, applicationJobId(job)])).rows[0].count;
    assert.equal(queueCount, 1);
    const claims = await Promise.all(children.map(child => request(child, 'claim')));
    assert.deepEqual(claims.map(c => c.state).sort(), ['busy', 'busy', 'busy', 'claimed']);
    const winner = claims.findIndex(c => c.state === 'claimed');
    const nonowners = await Promise.all(children.filter((_, i) => i !== winner).map(child => request(child, 'nonowner')));
    assert.equal((await store.getApplicationJob(applicationJobDigest(job))).state, 'running');
    assert.equal(await request(children[winner], 'release'), 'retryable');
    const reclaim = await Promise.all(children.map(child => request(child, 'reclaim')));
    assert.deepEqual(reclaim.map(c => c.state).sort(), ['busy', 'busy', 'busy', 'claimed']);
    // The former winning owner is now genuinely stale, even if its process wins again with a fresh owner ID.
    const stale = await request(children[winner], 'stale');
    const secondWinner = reclaim.findIndex(c => c.state === 'claimed');
    const finished = await request(children[secondWinner], 'complete');
    assert.equal(finished.state, 'finished'); assert.equal(finished.attempts, 2);
    assert.deepEqual(finished.result, terminalResult);
    assert.deepEqual(await store.getApplicationJob(applicationJobDigest(job)), finished);
    await Promise.all(children.map(child => request(child, 'stop')));
    const evidence = { schemaVersion: 1, status: 'passed', startedAt, completedAt: new Date().toISOString(),
      baseline: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
        scope: 'Current compiled dist APIs plus this local verification script; not an aggregate build verification' },
      reproduction: { script: 'scripts/verify-postgres-concurrency.mjs', scriptSha256: createHash('sha256').update(await readFile(script)).digest('hex'),
        command: 'timeout 120s node scripts/verify-postgres-concurrency.mjs verify SOCKET EVIDENCE' },
      server, database, socket, backend: 'real PostgreSQL server', processes: { count: pids.length, pids, barrier: 'IPC readiness and phased commands' },
      enqueue: { attempts: 4, accepted: 1, duplicatesRejected: 3, rows: queueCount, jobId: applicationJobId(job) },
      claim: { attempts: 4, winners: 1, busy: 3, nonownerCompletionRejected: nonowners.length },
      retry: { cause: 'explicit cleanup-safe synthetic failure; no crash or lease expiry', attempts: 4, winners: 1, busy: 3,
        staleFormerWinnerRejected: stale, persistedAttempts: finished.attempts },
      terminal: finished,
      limitations: { modelExecution: 'not_run', isolatedRuntime: 'not_run', queueHandlerExecution: 'not_run',
        databaseRestart: 'not_run', leaseExpiry: 'not_run', effect: 'Synthetic job terminal outcome is blocked; no efficacy claim',
        sideEffects: 'Only newly created flyrewheel_verify_concurrency database; retained for inspection' } };
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ status: evidence.status, database, processes: pids.length, enqueue: evidence.enqueue, claim: evidence.claim, retry: evidence.retry }));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (boss) await boss.stop({ graceful: true });
    await db.close();
  }
}
