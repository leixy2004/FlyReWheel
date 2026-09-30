import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from 'pg-boss';
import { expect, test } from 'vitest';
import { demoInputs } from '../src/demo.js';
import { openQueue, enqueueReplay, REPLAY_QUEUE, replayJobId } from '../src/jobs.js';

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
