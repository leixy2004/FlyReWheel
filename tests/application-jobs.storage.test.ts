import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationJobSchema, applicationJobDigest, type ApplicationJobResult } from '../src/application-job-contract.js';
import { digestOf } from '../src/core/identity.js';
import { demoInputs } from '../src/demo.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase, type Database, type Queryable } from '../src/storage/database.js';
import { revisionDate, revisionGenerationFixture } from './helpers/revision-generation-fixture.js';
import { applicationJobsFixture } from './helpers/application-jobs-fixture.js';
import { createPrMiningWorkspaceModelAdapter, type TrustedPrMiningNoCandidate } from '../src/adapters/pr-mining-model.js';

import { useFreshPGlite } from './helpers/fresh-pglite.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture(wrap?: (db: Database) => Database) {
  const db = await openPGliteDatabase();
  cleanup.push(() => db.close());
  return { db, store: await QualEvoStore.initialize(wrap?.(db) ?? db) };
}
const job = (attempt = 'initial') => ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'semantic-review', workspaceId: 'selected-workspace',
  ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), attempt });
const blocked: ApplicationJobResult = { status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason: 'runtime_unavailable' };
const failed: ApplicationJobResult = { status: 'failed', modelExecution: 'not_run', cleanup: 'not_started', reason: 'runtime_failed' };
const completed: ApplicationJobResult = { status: 'completed', modelExecution: 'not_run', cleanup: 'verified',
  outcome: { kind: 'semantic-review', id: `review_${'c'.repeat(64)}`, digest: 'd'.repeat(64) } };

/** Tampering is scoped to a transaction which always rolls back, including DDL. */
async function withTamperedLedger(db: Database, fn: (tx: Queryable, store: QualEvoStore) => Promise<void>) {
  const rollback = new Error('Rollback test-only corruption');
  await expect(db.transaction(async tx => {
    await tx.query('ALTER TABLE qe_application_jobs DISABLE TRIGGER qe_application_jobs_transition');
    const scoped = await QualEvoStore.initialize({ query: tx.query.bind(tx), transaction: operation => operation(tx), migrationTransaction: operation => operation(tx),
      exec: async () => {}, close: async () => {} });
    await fn(tx, scoped);
    throw rollback;
  })).rejects.toBe(rollback);
}

describe('durable application job storage', () => {
  describe('fresh database claim setup', () => {
    const fresh = useFreshPGlite();
    it('normalizes stable input and serializes competing claims without starting a second owner', async context => {
      const { store } = fresh(context), input = job(), owner = randomUUID(), contender = randomUUID();
      expect(await store.getApplicationJob(applicationJobDigest(input))).toBeNull();
      const results = await Promise.all([store.claimApplicationJob(input, owner), store.claimApplicationJob(input, contender)]);
      expect(results.map(result => result.state).sort()).toEqual(['busy', 'claimed']);
      expect(await store.claimApplicationJob(input, owner)).toEqual({ state: 'busy' });
      expect(await store.getApplicationJob(applicationJobDigest(input))).toEqual({ jobDigest: applicationJobDigest(input), job: input,
        state: 'running', result: null, attempts: 1 });
      await expect(store.claimApplicationJob(input, 'not-a-uuid')).rejects.toThrow();
    });
  });

  describe('fresh application database setup', () => {
    const fresh = useFreshPGlite();
    it('persists immutable blocked outcomes and returns terminal retries without invoking domain persistence', async context => {
      const { db, store } = fresh(context), input = job(), owner = randomUUID();
      await store.claimApplicationJob(input, owner);
      const terminal = await store.completeApplicationJob(input, owner, blocked), persist = vi.fn();
      expect(await store.completeApplicationJob(input, owner, blocked, persist)).toEqual(terminal);
      expect(persist).not.toHaveBeenCalled();
      expect(await store.claimApplicationJob(input, randomUUID())).toEqual({ state: 'finished', record: terminal });
      await expect(store.completeApplicationJob(input, owner, { ...blocked, reason: 'disabled' })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
      await expect(db.query('UPDATE qe_application_jobs SET attempts=attempts+1')).rejects.toThrow(/immutable/);
      await expect(db.query('DELETE FROM qe_application_jobs')).rejects.toThrow(/cannot be deleted/);
    });
  });

  describe('fresh application database setup', () => {
    const fresh = useFreshPGlite();
    it('makes only cleanup-safe failures retryable and fences the old owner after a retry', async context => {
      const { store } = fresh(context), input = job(), owner = randomUUID(), next = randomUUID();
      await store.claimApplicationJob(input, owner);
      await expect(store.failApplicationJob(input, owner, { ...failed, cleanup: 'retained-for-recovery' })).rejects.toMatchObject({ code: 'APPLICATION_JOB_RETRY_UNSAFE' });
      await expect(store.failApplicationJob(input, owner, blocked)).rejects.toMatchObject({ code: 'APPLICATION_JOB_RETRY_UNSAFE' });
      await expect(store.completeApplicationJob(input, next, blocked)).rejects.toMatchObject({ code: 'APPLICATION_JOB_FENCED' });
      await store.failApplicationJob(input, owner, failed);
      expect(await store.getApplicationJob(applicationJobDigest(input))).toMatchObject({ state: 'retryable', attempts: 1, result: failed });
      expect(await store.claimApplicationJob(input, next)).toEqual({ state: 'claimed', owner: next });
      expect(await store.getApplicationJob(applicationJobDigest(input))).toMatchObject({ state: 'running', attempts: 2, result: null });
      await expect(store.failApplicationJob(input, owner, failed)).rejects.toMatchObject({ code: 'APPLICATION_JOB_FENCED' });
      await expect(store.completeApplicationJob(input, owner, blocked)).rejects.toMatchObject({ code: 'APPLICATION_JOB_FENCED' });
      await store.failApplicationJob(input, next, { ...failed, modelExecution: 'completed', cleanup: 'verified' });
      expect(await store.getApplicationJob(applicationJobDigest(input))).toMatchObject({ state: 'retryable', attempts: 2 });
    });
  });

  describe('fresh application database setup', () => {
    const fresh = useFreshPGlite();
    it('atomically blocks expired running claims rather than stealing or rerunning them', async context => {
      const { db, store } = fresh(context), input = job(), owner = randomUUID(), digest = applicationJobDigest(input);
      await store.claimApplicationJob(input, owner);
      const lease = (await db.query<{ seconds: number }>('SELECT EXTRACT(EPOCH FROM lease_expires_at - clock_timestamp())::float8 AS seconds FROM qe_application_jobs')).rows[0];
      expect(lease.seconds).toBeGreaterThan(890);
      await withTamperedLedger(db, async (tx, scoped) => {
        await tx.query("UPDATE qe_application_jobs SET lease_expires_at=clock_timestamp() - interval '1 second'");
        const persist = vi.fn();
        await expect(scoped.completeApplicationJob(input, owner, completed, persist)).rejects.toMatchObject({ code: 'APPLICATION_JOB_FENCED' });
        await expect(scoped.failApplicationJob(input, owner, failed)).rejects.toMatchObject({ code: 'APPLICATION_JOB_FENCED' });
        expect(persist).not.toHaveBeenCalled();
        expect(await scoped.claimApplicationJob(input, randomUUID())).toMatchObject({ state: 'finished', record: { state: 'finished', attempts: 1,
          result: { status: 'blocked', modelExecution: 'unknown', cleanup: 'retained-for-recovery', reason: 'interrupted_execution_requires_recovery' } } });
        expect(await scoped.claimApplicationJob(input, randomUUID())).toMatchObject({ state: 'finished' });
      });
      expect(await store.getApplicationJob(digest)).toMatchObject({ state: 'running', attempts: 1 });
    });
  });

  describe('fresh application database setup', () => {
    const fresh = useFreshPGlite();
    it('reconciles abandoned execution on read or a bounded sweep without requiring another delivery', async context => {
      const { db, store } = fresh(context);
      const inputs = ['lazy-expired', 'selected-expired', 'sweep-a', 'sweep-b', 'still-active'].map(job);
      const digests = inputs.map(applicationJobDigest);
      for (const input of inputs) await store.claimApplicationJob(input, randomUUID());
      await withTamperedLedger(db, async (tx, scoped) => {
        await tx.query("UPDATE qe_application_jobs SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE job_digest <> $1", [digests[4]]);
        const claim = vi.spyOn(scoped, 'claimApplicationJob');
        const abandoned = { state: 'finished', attempts: 1, result: { status: 'blocked', modelExecution: 'unknown',
          cleanup: 'retained-for-recovery', reason: 'interrupted_execution_requires_recovery' } };
        expect(await scoped.getApplicationJob(digests[0])).toMatchObject(abandoned);
        expect(await scoped.getApplicationJob(digests[4])).toMatchObject({ state: 'running', attempts: 1, result: null });
        await scoped.reconcileExpiredApplicationJobs(1, digests[1]);
        const rows = () => tx.query<{ job_digest: string; state: string; attempts: number }>('SELECT job_digest,state,attempts FROM qe_application_jobs ORDER BY job_digest');
        expect((await rows()).rows.find(row => row.job_digest === digests[1])).toMatchObject({ state: 'finished', attempts: 1 });
        expect((await rows()).rows.filter(row => row.state === 'running')).toHaveLength(3);
        await scoped.reconcileExpiredApplicationJobs(1);
        expect((await rows()).rows.filter(row => row.state === 'running')).toHaveLength(2);
        await scoped.reconcileExpiredApplicationJobs();
        expect((await rows()).rows.filter(row => row.state === 'running')).toEqual([{ job_digest: digests[4], state: 'running', attempts: 1 }]);
        for (const digest of digests.slice(0, 4)) expect(await scoped.getApplicationJob(digest)).toMatchObject(abandoned);
        expect(claim).not.toHaveBeenCalled();
      });
      for (const digest of digests) expect(await store.getApplicationJob(digest)).toMatchObject({ state: 'running', attempts: 1, result: null });
    });
  });

  describe('cancellation rollback setup', () => {
    const fresh = useFreshPGlite();
    it.for(['before-persistence', 'during-persistence'] as const)('rolls back cancellation %s without a durable domain result', async (phase, context) => {
      const { store } = fresh(context), input = job(), owner = randomUUID(), controller = new AbortController();
      const problemCase = demoInputs().dataset.samples[0].problemCase, reason = new Error('Authored cancellation before commit');
      await store.claimApplicationJob(input, owner);
      if (phase === 'before-persistence') controller.abort(reason);
      const persist = vi.fn(async (scoped: QualEvoStore) => {
        await scoped.importProblemCase(problemCase);
        controller.abort(reason);
      });
      await expect(store.completeApplicationJob(input, owner, completed, persist, controller.signal)).rejects.toBe(reason);
      expect(persist).toHaveBeenCalledTimes(phase === 'before-persistence' ? 0 : 1);
      await expect(store.getProblemCase(problemCase.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await store.getApplicationJob(applicationJobDigest(input))).toMatchObject({ state: 'running', result: null, attempts: 1 });
    });
  });

  describe('fresh application database setup', () => {
    const fresh = useFreshPGlite();
    it('rolls back domain writes if persistence throws, and closes the scoped store', async context => {
      const { store } = fresh(context), input = job(), owner = randomUUID(), problemCase = demoInputs().dataset.samples[0].problemCase;
      await store.claimApplicationJob(input, owner);
      let leaked: QualEvoStore | undefined;
      await expect(store.completeApplicationJob(input, owner, completed, async scoped => {
        leaked = scoped;
        await scoped.importProblemCase(problemCase);
        expect(await scoped.getProblemCase(problemCase.id)).toEqual(problemCase);
        await expect(scoped.close()).rejects.toMatchObject({ code: 'APPLICATION_JOB_SCOPE_INVALID' });
        await expect(scoped.claimApplicationJob(job('nested'), randomUUID())).rejects.toMatchObject({ code: 'APPLICATION_JOB_SCOPE_INVALID' });
        throw new Error('Authored persistence failure');
      })).rejects.toThrow('Authored persistence failure');
      await expect(store.getProblemCase(problemCase.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(leaked!.importProblemCase(problemCase)).rejects.toMatchObject({ code: 'APPLICATION_JOB_SCOPE_CLOSED' });
      expect(await store.getApplicationJob(applicationJobDigest(input))).toMatchObject({ state: 'running', result: null });
    });
  });

  it('rolls back domain writes if the final owner fence no longer matches', async () => {
    let rejectCommit = false;
    const { store } = await fixture(db => ({ ...db, transaction: fn => db.transaction(tx => fn({ query: async (sql, params) => {
      if (rejectCommit && sql.startsWith("UPDATE qe_application_jobs SET state='finished'")) return { rows: [] };
      return tx.query(sql, params);
    } })) }));
    const input = job(), owner = randomUUID(), problemCase = demoInputs().dataset.samples[0].problemCase;
    await store.claimApplicationJob(input, owner); rejectCommit = true;
    await expect(store.completeApplicationJob(input, owner, completed, async scoped => { await scoped.importProblemCase(problemCase); }))
      .rejects.toMatchObject({ code: 'APPLICATION_JOB_FENCED' });
    await expect(store.getProblemCase(problemCase.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.getApplicationJob(applicationJobDigest(input))).toMatchObject({ state: 'running', result: null });
  });

  describe('fresh application database setup', () => {
    const fresh = useFreshPGlite();
    it('does not commit unbound, absent, or wrong-kind outcomes after domain writes', async context => {
      const { store } = fresh(context), input = job(), owner = randomUUID(), problemCase = demoInputs().dataset.samples[0].problemCase;
      await store.claimApplicationJob(input, owner);
      await expect(store.completeApplicationJob(input, owner, completed, async scoped => { await scoped.importProblemCase(problemCase); }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.getProblemCase(problemCase.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.completeApplicationJob(input, owner, { ...completed, outcome: { ...completed.outcome!, kind: 'revision-candidate' } }))
        .rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
      await expect(store.completeApplicationJob(input, owner, blocked, async scoped => { await scoped.importProblemCase(problemCase); }))
        .rejects.toMatchObject({ code: 'APPLICATION_JOB_OUTCOME_INVALID' });
      expect(await store.getApplicationJob(applicationJobDigest(input))).toMatchObject({ state: 'running', result: null });
    });
  });

  describe('fresh application database setup', () => {
    const fresh = useFreshPGlite();
    it('checks durable normalized job hashes, outcome hashes, and result schemas on every read', async context => {
      const { db, store } = fresh(context), input = job(), owner = randomUUID(), digest = applicationJobDigest(input);
      await store.claimApplicationJob(input, owner); await store.completeApplicationJob(input, owner, blocked);
      const corruptions = [
        ["UPDATE qe_application_jobs SET job_payload=jsonb_set(job_payload,'{workspaceId}','\"different\"')", []],
        ["UPDATE qe_application_jobs SET job_payload_digest=$1", ['f'.repeat(64)]],
        ["UPDATE qe_application_jobs SET result_digest=$1", ['f'.repeat(64)]],
        ["UPDATE qe_application_jobs SET result=$1::jsonb,result_digest=$2", [JSON.stringify({ ...blocked, reason: 'forged-reason' }), digestOf({ ...blocked, reason: 'forged-reason' })]],
      ] as const;
      for (const [sql, values] of corruptions) await withTamperedLedger(db, async (tx, scoped) => {
        await tx.query(sql, [...values]);
        await expect(scoped.getApplicationJob(digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
        await expect(scoped.claimApplicationJob(input, randomUUID())).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
      });
      expect(await store.getApplicationJob(digest)).toMatchObject({ state: 'finished', result: blocked });
    });
  });

  it('atomically saves a trusted authored candidate, validates exact job bindings and survives reopen', async () => {
    const f = await revisionGenerationFixture(); cleanup.push(f.cleanup);
    const input = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'revision-generation', workspaceId: 'revision-workspace',
      requestDigest: f.request.digest, snapshotDigest: f.snapshot.digest, candidateCreatedAt: revisionDate });
    const digest = applicationJobDigest(input), owner = randomUUID();
    await f.store.claimApplicationJob(input, owner);
    const generated = await f.adapter().generate({ ...f.input, candidateId: `application-${digest}` });
    if (generated.execution !== 'succeeded' || generated.status !== 'candidate_requires_review') throw new Error('Expected authored candidate');
    const result: ApplicationJobResult = { status: 'completed', modelExecution: 'not_run', cleanup: 'verified',
      outcome: { kind: 'revision-candidate', id: generated.candidate.id, digest: digestOf(generated.candidate) } };
    const saved = await f.store.completeApplicationJob(input, owner, result, async scoped => { await scoped.saveRevisionModelCandidate(generated.persistence); });
    expect(saved).toMatchObject({ state: 'finished', attempts: 1, result });
    expect(await f.store.getRevisionCandidate(result.outcome!.digest!)).toMatchObject({ candidate: generated.candidate });
    const persist = vi.fn();
    expect(await f.store.completeApplicationJob(input, owner, result, persist)).toEqual(saved);
    expect(persist).not.toHaveBeenCalled();
    expect(f.calls.filter(value => value === 'execute')).toHaveLength(1);
    await withTamperedLedger(f.db, async (tx, scoped) => {
      const changed = { ...result, modelExecution: 'completed' as const };
      await tx.query('UPDATE qe_application_jobs SET result=$1::jsonb,result_digest=$2', [JSON.stringify(changed), digestOf(changed)]);
      await expect(scoped.getApplicationJob(digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    });
    await f.closeStore();
    const reopened = await QualEvoStore.openPGlite(`${f.directory}/db`); cleanup.push(() => reopened.close());
    expect(await reopened.getApplicationJob(digest)).toEqual(saved);
    expect(await reopened.claimApplicationJob(input, randomUUID())).toEqual({ state: 'finished', record: saved });
  }, 30_000);

  it('rejects raw or copied no-candidate authority and persists only the exact adapter-minted capability', async () => {
    const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
    f.values['pr-mining-v1'] = { result: { status: 'insufficient_evidence', reasoning: 'Authored insufficient policy evidence',
      missingEvidence: ['Applicable policy'], evidenceRefs: [] } };
    const input = ApplicationJobSchema.parse(f.jobs.mining);
    if (input.kind !== 'pr-mining') throw new Error('Expected mining job');
    const digest = applicationJobDigest(input), owner = randomUUID(), id = `application-${digest}`;
    const evidence = await f.store.getGithubPrEvidence(f.miningRequest.request.input.evidenceDigest);
    const workspace = await f.resolveWorkspace({ workspaceId: input.workspaceId, jobDigest: digest, expectedSha: evidence.evidence.snapshot.mergeBase });
    await f.store.claimApplicationJob(input, owner);
    const generated = await createPrMiningWorkspaceModelAdapter(f.config, f.dependency).generate({ request: f.miningRequest,
      evidence, candidateId: id, candidateCreatedAt: input.candidateCreatedAt,
      context: { kind: 'full-repository', repository: evidence.evidence.snapshot.repository.id, checkout: 'before', workspace } });
    if (generated.execution !== 'succeeded' || generated.status !== 'insufficient_evidence') throw new Error('Expected authored no-candidate outcome');
    const result: ApplicationJobResult = { status: 'completed', modelExecution: 'not_run', cleanup: 'verified',
      outcome: { kind: 'mining-insufficient-evidence', id, digest: digestOf(generated.executionReceipt) }, receipt: generated.executionReceipt };
    const forgeries = [undefined, null, {}, { ...generated.outcomePersistence }, structuredClone(generated.outcomePersistence),
      JSON.parse(JSON.stringify(generated.outcomePersistence)), generated.executionReceipt, JSON.parse(JSON.stringify(generated))];
    for (const forged of forgeries) {
      await expect(f.store.completeApplicationJob(input, owner, result, undefined, undefined, forged as TrustedPrMiningNoCandidate | undefined))
        .rejects.toThrow(/trusted runtime capability/);
      expect(await f.store.getApplicationJob(digest)).toMatchObject({ state: 'running', attempts: 1, result: null });
    }
    const changedReceipt = { ...generated.executionReceipt, runtimeId: 'different-authored-runtime' };
    const changedResult = { ...result, outcome: { ...result.outcome!, digest: digestOf(changedReceipt) }, receipt: changedReceipt };
    await expect(f.store.completeApplicationJob(input, owner, changedResult, undefined, undefined, generated.outcomePersistence))
      .rejects.toMatchObject({ code: 'APPLICATION_JOB_CAPABILITY_REQUIRED' });
    for (const changedJob of [{ ...input, attempt: 'different-attempt' }, { ...input, candidateCreatedAt: '2026-10-03T00:00:00Z' }]) {
      const changedDigest = applicationJobDigest(changedJob), changedOwner = randomUUID(), persist = vi.fn();
      await f.store.claimApplicationJob(changedJob, changedOwner);
      const reusedResult = { ...result, outcome: { ...result.outcome!, id: `application-${changedDigest}` } };
      await expect(f.store.completeApplicationJob(changedJob, changedOwner, reusedResult, persist, undefined, generated.outcomePersistence))
        .rejects.toMatchObject({ code: 'APPLICATION_JOB_CAPABILITY_REQUIRED' });
      expect(persist).not.toHaveBeenCalled();
      expect(await f.store.getApplicationJob(changedDigest)).toMatchObject({ state: 'running', attempts: 1, result: null });
    }
    const saved = await f.store.completeApplicationJob(input, owner, result, undefined, undefined, generated.outcomePersistence);
    expect(saved).toMatchObject({ state: 'finished', result });
    expect(await f.store.listPrMiningCandidates()).toEqual([]);
    expect(f.executions).toEqual(['pr-mining-v1']);
    await f.closeStore();
    const reopened = await QualEvoStore.openPGlite(f.storePath); cleanup.push(() => reopened.close());
    expect(await reopened.getApplicationJob(digest)).toEqual(saved);
    expect(await reopened.completeApplicationJob(input, owner, result)).toEqual(saved);
  }, 30_000);
});
