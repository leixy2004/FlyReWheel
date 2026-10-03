import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from 'pg-boss';
import { expect, test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { QualEvoStore } from '../src/storage/store.js';
import { replayDataset } from '../src/pipeline.js';
import { demoInputs } from '../src/demo.js';
import { openQueue, enqueueReplay, REPLAY_QUEUE, replayJobId, workReplay } from '../src/jobs.js';

test('real pg-boss uses its official PGlite backend, deduplicates jobs and retains explicit retry policy', async () => {
  const db = new PGlite();
  const boss = await openQueue({ db: fromPglite(db), backend: 'pglite', schedule: false, supervise: false });
  try {
    const payload = { ...demoInputs(), mode: 'offline_fixture' as const, workload: 'background' as const };
    const id = await enqueueReplay(boss, payload);
    expect(id).toBe(replayJobId(payload));
    expect(await enqueueReplay(boss, payload)).toBeNull();
    const jobs = await boss.fetch(REPLAY_QUEUE, { includeMetadata: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.retryLimit).toBe(2);
    expect(jobs[0]!.heartbeatSeconds).toBe(60);
    await boss.complete(REPLAY_QUEUE, id!, { verified: true });
    expect((await boss.getJobById(REPLAY_QUEUE, id!))?.state).toBe('completed');
  } finally { await boss.stop({ graceful: true }); await db.close(); }
}, 30000);


test('legacy offline replay still completes through an actual asynchronous callback with domain migrations', async () => {
  const db = new PGlite();
  await db.waitReady;
  const store = await QualEvoStore.initialize({ query: (sql, params) => db.query(sql, params),
    transaction: fn => db.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })),
    migrationTransaction: fn => db.transaction(tx => fn({
      query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => params === undefined
        ? { rows: ((await tx.exec(sql)).at(-1)?.rows ?? []) as T[] } : tx.query<T>(sql, params),
    })),
    exec: async sql => { await db.exec(sql); }, close: () => db.close() });
  const boss = await openQueue({ db: fromPglite(db), backend: 'pglite', schedule: false, supervise: false });
  try {
    let callbacks = 0;
    await workReplay(boss, async (job, signal) => {
      callbacks++;
      const result = await replayDataset({ store, bundle: job.bundle, dataset: job.dataset, mode: 'offline_fixture', attempt: job.attempt, signal });
      return { observations: result.observations.length, errors: result.report.metrics.executionErrors };
    });
    const payload = { ...demoInputs(), mode: 'offline_fixture' as const }, id = await enqueueReplay(boss, payload);
    expect(await enqueueReplay(boss, payload)).toBeNull();
    const deadline = Date.now() + 15_000;
    let job = await boss.getJobById(REPLAY_QUEUE, id!);
    while (job?.state !== 'completed' && Date.now() < deadline) { await delay(50); job = await boss.getJobById(REPLAY_QUEUE, id!); }
    expect(job).toMatchObject({ state: 'completed', output: { observations: 6, errors: 0 } });
    expect(callbacks).toBe(1);
  } finally { await boss.stop({ graceful: true }); await store.close(); }
}, 30_000);
