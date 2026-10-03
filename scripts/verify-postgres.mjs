import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openPostgresDatabase } from '../dist/storage/database.js';
import { migrateDatabase, inspectDatabaseMigrations } from '../dist/storage/migrations.js';
import { QualEvoStore } from '../dist/storage/store.js';
import { MatchedStudyStore, matchedStudyDigest } from '../dist/storage/matched-studies.js';
import { digestOf } from '../dist/core/identity.js';
import { ApplicationJobSchema, applicationJobDigest } from '../dist/application-job-contract.js';
import { openQueue, enqueueReplay, workReplay, enqueueApplication, applicationJobId, REPLAY_QUEUE, APPLICATION_QUEUE } from '../dist/jobs.js';
import { startWorkerService } from '../dist/worker-service.js';
import { demoInputs } from '../dist/demo.js';
import { replayDataset } from '../dist/pipeline.js';

// Explicit opt-in: only a dedicated disposable database on a local Unix socket.
// This script does not create containers, configure authentication, or call models.
const [phase, socket, evidencePath] = process.argv.slice(2);
assert(['prepare', 'verify-restart', 'upgrade', 'claim-child', 'service-child'].includes(phase));
assert(socket?.startsWith('/'), 'An explicit absolute Unix socket directory is required');
assert(evidencePath?.startsWith('/'), 'An explicit absolute evidence path is required');
const databaseName = phase === 'upgrade' ? 'flyrewheel_verify_upgrade' : 'flyrewheel_verify';
const connectionString = `postgresql://postgres@/${databaseName}?host=${encodeURIComponent(socket)}`;
const crashQueue = 'flyrewheel-verification-crash';
const options = { connectionString, schedule: false, supervise: false };
async function until(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('PostgreSQL verification timed out');
}
if (phase === 'service-child') {
  const store = await QualEvoStore.initialize(await openPostgresDatabase(connectionString));
  const boss = await openQueue(options);
  const service = await startWorkerService({ store, boss, host: '127.0.0.1', port: 0,
    environment: { QE_ENABLE_MODEL: 'false', QE_S3_ENABLED: 'false' }, onResult: () => {} });
  process.once('SIGTERM', () => { void service.stop().then(() => process.disconnect()); });
  process.send({ port: service.health.address().port });
} else if (phase === 'claim-child') {
  const boss = await openQueue(options);
  const [job] = await boss.fetch(crashQueue);
  assert(job);
  process.send({ claimed: job.id });
  // Parent SIGKILLs this actual process after the committed database claim.
  setInterval(() => {}, 1000);
} else {
  const db = await openPostgresDatabase(connectionString);
  let boss;
  const peers = [];
  try {
    const server = (await db.query('SELECT version() AS version')).rows[0].version;
    assert.match(server, /^PostgreSQL 17\./);
    if (phase === 'upgrade') {
      assert.equal((await inspectDatabaseMigrations(db)).state, 'empty');
      const directory = await mkdtemp(join(tmpdir(), 'flyrewheel-pg-migrations-'));
      try {
        const source = new URL('../dist/storage/migrations/', import.meta.url);
        for (const name of (await readdir(source)).filter(name => /^0(?:0[1-9]|1[0-4])_/.test(name)))
          await copyFile(new URL(name, source), join(directory, name));
        assert.equal((await migrateDatabase(db, { directory })).applied.length, 14);
        await db.query('INSERT INTO qe_rule_bundles(digest,rule_id,version,payload) VALUES ($1,$2,$3,$4)',
          ['c'.repeat(64), 'real-postgres-upgrade-sentinel', 'v1', JSON.stringify({ authored: true })]);
        const before = (await db.query('SELECT * FROM qe_rule_bundles')).rows;
        const next = '015_matched_studies.sql';
        await writeFile(join(directory, next), 'CREATE TABLE qe_verification_rollback(id integer); SELECT flyrewheel_deliberately_missing_function();');
        let failingSqlReachedDriver = false;
        const observed = { ...db, migrationTransaction: fn => db.migrationTransaction(tx => fn({ query: (sql, params) => {
          if (sql.includes('flyrewheel_deliberately_missing_function')) failingSqlReachedDriver = true;
          return tx.query(sql, params);
        } })) };
        await assert.rejects(migrateDatabase(observed, { directory }), { code: 'MIGRATION_FAILED' });
        assert.equal(failingSqlReachedDriver, true);
        assert.equal((await db.query("SELECT to_regclass('public.qe_verification_rollback') AS name")).rows[0].name, null);
        assert.equal((await db.query('SELECT count(*)::int AS count FROM qe_schema_migrations')).rows[0].count, 14);
        await copyFile(new URL(next, source), join(directory, next));
        assert.deepEqual((await migrateDatabase(db)).applied, ['015_matched_studies']);
        assert.deepEqual((await db.query('SELECT * FROM qe_rule_bundles')).rows, before);
        assert.deepEqual((await migrateDatabase(db)).applied, []);
        const result = { server, backend: 'real PostgreSQL server', fromMigrations: 14, toMigrations: 15,
          failedBatchRolledBack: true, failingSqlReachedDriver, failedTableAbsent: true, historyPreservedAfterFailure: 14,
          correctedRetryApplied: ['015_matched_studies'], sentinelRecordsPreserved: 1, repeatedApplied: 0, modelExecution: 'not_run' };
        await writeFile(evidencePath, JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify(result));
      } finally { await rm(directory, { recursive: true, force: true }); }
    } else if (phase === 'prepare') {
      assert.equal((await inspectDatabaseMigrations(db)).state, 'empty', 'Requires a fresh disposable database');
      for (let i = 0; i < 3; i++) peers.push(await openPostgresDatabase(connectionString));
      const migrations = await Promise.all([db, ...peers].map(database => migrateDatabase(database)));
      assert.equal(migrations.reduce((n, r) => n + r.applied.length, 0), 15);
      assert.equal((await inspectDatabaseMigrations(db)).applied.length, 15);
      assert.deepEqual((await migrateDatabase(db)).applied, []);
      const store = await QualEvoStore.initialize(db);
      const stores = await Promise.all(peers.map(database => QualEvoStore.initialize(database)));
      const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'semantic-review', workspaceId: 'real-postgres-verification',
        ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) });
      const owners = [db, ...peers].map(() => randomUUID());
      const claims = await Promise.all([store, ...stores].map((s, i) => s.claimApplicationJob(job, owners[i])));
      assert.deepEqual(claims.map(c => c.state).sort(), ['busy', 'busy', 'busy', 'claimed']);
      const winner = claims.findIndex(c => c.state === 'claimed'), loser = (winner + 1) % 4;
      const blocked = { status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason: 'runtime_unavailable' };
      await assert.rejects(store.completeApplicationJob(job, owners[loser], blocked), { code: 'APPLICATION_JOB_FENCED' });
      await store.completeApplicationJob(job, owners[winner], blocked);
      const terminal = await store.getApplicationJob(applicationJobDigest(job));
      const blockId = digestOf('real PostgreSQL checkpoint fixture');
      const scheduleBody = { blocks: [{ blockId, repetition: 1, episodeId: 'pg-verification', armOrder: ['F'], futureTargetOrder: ['target'] }] };
      const schedule = { ...scheduleBody, digest: digestOf(scheduleBody) }, configuration = { source: 'authored storage fixture; no model' };
      const manifest = { schemaVersion: 1, kind: 'authored-matched-study-recovery', scheduleDigest: schedule.digest,
        configurationDigest: digestOf(configuration), blockIds: [blockId], input: { schedule, configuration, blocks: [null] } };
      const studies = await Promise.all([db, ...peers].map(database => MatchedStudyStore.openExisting(database)));
      const studyClaims = await Promise.all(studies.map(s => s.claim(manifest, 3000)));
      assert.deepEqual(studyClaims.map(c => c.state).sort(), ['busy', 'busy', 'busy', 'claimed']);
      const first = studyClaims.find(c => c.state === 'claimed').claim;
      const event = { startedAt: new Date().toISOString() };
      await studies[0].append(first, blockId, 'block-start', event);
      boss = await openQueue(options);
      let callbacks = 0;
      await workReplay(boss, async (payload, signal) => {
        callbacks++;
        const result = await replayDataset({ store, bundle: payload.bundle, dataset: payload.dataset, mode: 'offline_fixture', attempt: payload.attempt, signal });
        return { observations: result.observations.length, errors: result.report.metrics.executionErrors };
      });
      const payload = { ...demoInputs(), mode: 'offline_fixture' }, replayId = await enqueueReplay(boss, payload);
      assert(replayId);
      assert.equal(await enqueueReplay(boss, payload), null);
      const replay = await until(async () => { const j = await boss.getJobById(REPLAY_QUEUE, replayId); return j?.state === 'completed' && j; });
      assert.deepEqual(replay.output, { observations: 6, errors: 0 });
      assert.equal(callbacks, 1);
      await boss.createQueue(crashQueue, { retryLimit: 2, retryDelay: 0, expireInSeconds: 2 });
      const crashId = await boss.send(crashQueue, { source: 'authored crash probe' });
      const child = fork(fileURLToPath(import.meta.url), ['claim-child', socket, evidencePath], { env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      try {
        const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Claim process exited before claiming'); }),
          delay(20000, null, { ref: false }).then(() => { throw new Error('Claim process timed out'); })]);
        assert.equal(message.claimed, crashId);
        const exited = once(child, 'exit'); child.kill('SIGKILL');
        const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
      assert.equal((await boss.getJobById(crashQueue, crashId)).state, 'active');
      await delay(2200);
      await boss.supervise(crashQueue);
      const [retried] = await boss.fetch(crashQueue, { includeMetadata: true });
      assert.equal(retried?.id, crashId); assert.equal(retried.retryCount, 1);
      await boss.complete(crashQueue, crashId, { recoveredAfterWorkerSigkill: true });
      await until(async () => (await studies[1].inspect(matchedStudyDigest(manifest)))?.leaseExpired);
      const recovered = await studies[1].claim(manifest, 30000);
      assert.equal(recovered.state, 'claimed'); assert.equal(recovered.claim.fence, 2);
      await assert.rejects(studies[0].append(first, blockId, 'block-start', event), { code: 'STUDY_FENCED' });
      await assert.rejects(studies[1].append(recovered.claim, blockId, 'block-start', { startedAt: new Date(Date.now() + 1).toISOString() }), { code: 'STUDY_CONFLICT' });
      await boss.stop({ graceful: true }); boss = await openQueue(options);
      const serviceChild = fork(fileURLToPath(import.meta.url), ['service-child', socket, evidencePath], { env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      let serviceEvidence;
      try {
        const [address] = await Promise.race([once(serviceChild, 'message'), once(serviceChild, 'exit').then(() => { throw new Error('Service exited before readiness'); }),
          delay(20000, null, { ref: false }).then(() => { throw new Error('Service readiness timed out'); })]);
        for (const path of ['/healthz', '/readyz']) {
          const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok', applicationRuntime: 'blocked' });
        }
        const serviceReplayId = await enqueueReplay(boss, { ...payload, workload: 'interactive' });
        assert(serviceReplayId);
        const serviceReplay = await until(async () => { const j = await boss.getJobById(REPLAY_QUEUE, serviceReplayId); return j?.state === 'completed' && j; });
        assert.equal(serviceReplay.output.observations, 6); assert.equal(serviceReplay.output.errors, 0);
        const application = { ...job, workspaceId: 'real-postgres-service-verification' };
        assert.equal(await enqueueApplication(boss, application), applicationJobId(application));
        const serviceApplication = await until(async () => { const j = await boss.getJobById(APPLICATION_QUEUE, applicationJobId(application)); return j?.state === 'completed' && j; });
        assert.equal(serviceApplication.output.status, 'blocked');
        assert.equal(serviceApplication.output.modelExecution, 'not_run');
        const exited = once(serviceChild, 'exit'); serviceChild.kill('SIGTERM');
        const [code, signal] = await Promise.race([exited, delay(20000, null, { ref: false }).then(() => { throw new Error('Service shutdown timed out'); })]);
        assert.equal(code, 0); assert.equal(signal, null);
        serviceEvidence = { healthz: 200, readyz: 200, binding: '127.0.0.1', replayObservations: 6, replayErrors: 0,
          applicationRuntime: 'blocked', applicationModelExecution: 'not_run', gracefulSigtermExit: 0 };
      } finally { if (serviceChild.exitCode === null && serviceChild.signalCode === null) serviceChild.kill('SIGKILL'); }
      const serverStartedAt = (await db.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started.toISOString();
      const evidence = { server, serverStartedAt, backend: 'real PostgreSQL server', modelExecution: 'not_run', deployment: 'temporary Docker database only',
        migrations: { count: 15, concurrentInitializers: 4, repeatedApplied: 0 }, applicationClaimants: 4, applicationWinners: 1,
        staleApplicationOwnerRejected: true, matchedStudyClaimants: 4, matchedStudyWinners: 1, recoveredFence: 2,
        staleStudyOwnerRejected: true, immutableCheckpointVerified: true, replay: { id: replayId, callbacks, ...replay.output },
        workerCrash: { signal: 'SIGKILL', jobId: crashId, retryCount: 1, completed: true }, workerService: serviceEvidence,
        restartExpected: { applicationDigest: applicationJobDigest(job), terminal, studyDigest: matchedStudyDigest(manifest), event } };
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
      console.log(JSON.stringify({ phase, ...evidence }));
    } else {
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
      const serverStartedAt = (await db.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started.toISOString();
      assert.notEqual(serverStartedAt, evidence.serverStartedAt, 'PostgreSQL must actually restart between verification phases');
      assert.equal((await inspectDatabaseMigrations(db)).applied.length, 15);
      assert.deepEqual((await migrateDatabase(db)).applied, []);
      const store = await QualEvoStore.initialize(db), study = await MatchedStudyStore.openExisting(db);
      assert.deepEqual(await store.getApplicationJob(evidence.restartExpected.applicationDigest), evidence.restartExpected.terminal);
      const checkpoint = await study.inspect(evidence.restartExpected.studyDigest);
      assert.equal(checkpoint.fence, 2); assert.equal(checkpoint.events.length, 1);
      assert.deepEqual(checkpoint.events[0].payload, evidence.restartExpected.event);
      boss = await openQueue(options);
      assert.equal((await boss.getJobById(REPLAY_QUEUE, evidence.replay.id)).state, 'completed');
      assert.equal((await boss.getJobById(crashQueue, evidence.workerCrash.jobId)).state, 'completed');
      assert.equal(await enqueueReplay(boss, { ...demoInputs(), mode: 'offline_fixture' }), null);
      evidence.databaseRestart = { postmasterStartChanged: true, before: evidence.serverStartedAt, after: serverStartedAt,
        recordsPreserved: true, migrationsReapplied: 0, completedJobsPreserved: 2, duplicateRejected: true };
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
      console.log(JSON.stringify({ phase, databaseRestart: evidence.databaseRestart }));
    }
  } finally { if (boss) await boss.stop({ graceful: true }); await Promise.allSettled(peers.map(p => p.close())); await db.close(); }
}
