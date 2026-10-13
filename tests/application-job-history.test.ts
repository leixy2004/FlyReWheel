import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openPGliteDatabase } from '../src/storage/database.js';
import { migrateDatabase } from '../src/storage/migrations.js';
import { QualEvoStore } from '../src/storage/store.js';
import { ApplicationJobSchema, applicationJobDigest } from '../src/application-job-contract.js';
import { digestOf } from '../src/core/identity.js';

it('backfills only the surviving legacy result and archives expired execution without inventing lost attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attempt-history-upgrade-')), db = await openPGliteDatabase();
  try {
    const migrations = join(process.cwd(), 'src/storage/migrations');
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql') && name < '018'))
      await copyFile(join(migrations, name), join(directory, name));
    await migrateDatabase(db, { directory });
    const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'semantic-review', ruleDigest: 'a'.repeat(64),
      snapshotDigest: 'b'.repeat(64), workspaceId: 'history-fixture' }), digest = applicationJobDigest(job);
    const result = { status: 'failed', modelExecution: 'not_run', cleanup: 'verified', reason: 'runtime_failed' };
    await db.query("INSERT INTO qe_application_jobs(job_digest,job_payload,job_payload_digest,state,attempts,result,result_digest) VALUES($1,$2::jsonb,$1,'retryable',3,$3::jsonb,$4)",
      [digest, JSON.stringify(job), JSON.stringify(result), digestOf(result)]);
    const store = await QualEvoStore.initialize(db);
    expect(await store.getApplicationJobHistory(digest)).toMatchObject({ recordedAttempts: 1, missingHistoricalAttempts: 2,
      outcomes: [{ attempt: 3, origin: 'migration-current-result', result }] });
    await store.claimApplicationJob(job, randomUUID());
    expect(await store.getApplicationJobHistory(digest)).toMatchObject({ currentState: 'running', recordedAttempts: 1, missingHistoricalAttempts: 2 });
    // Deterministically model a worker process disappearing past its lease, without sleeping.
    await db.exec('ALTER TABLE qe_application_jobs DISABLE TRIGGER qe_application_jobs_transition');
    await db.query("UPDATE qe_application_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_digest=$1", [digest]);
    await db.exec('ALTER TABLE qe_application_jobs ENABLE TRIGGER qe_application_jobs_transition');
    const history = await store.getApplicationJobHistory(digest);
    expect(history).toMatchObject({ currentState: 'finished', recordedAttempts: 2, missingHistoricalAttempts: 2,
      outcomes: [{ attempt: 3 }, { attempt: 4, origin: 'recorded-transition', result: { status: 'blocked', modelExecution: 'unknown', reason: 'interrupted_execution_requires_recovery' } }] });
    expect((await store.getApplicationJobHistory(digest, { afterAttempt: 3, limit: 1 })).outcomes).toEqual(history.outcomes.slice(1));
    expect((await store.getApplicationJobHistory(digest, { afterAttempt: 4 })).nextAfterAttempt).toBeNull();
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
