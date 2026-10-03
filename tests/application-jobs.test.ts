import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { fromPglite, type PgBoss } from 'pg-boss';
import { afterEach, describe, expect, it } from 'vitest';
import { ApplicationJobSchema, applicationJobDigest, applicationJobId, type ApplicationJobInput } from '../src/application-job-contract.js';
import { createApplicationJobDispatcher } from '../src/application-dispatcher.js';
import { APPLICATION_QUEUE, enqueueApplication, openQueue, workApplication } from '../src/jobs.js';
import { QualEvoStore } from '../src/storage/store.js';
import { applicationJobsFixture } from './helpers/application-jobs-fixture.js';
import { revisionLimits } from './helpers/revision-generation-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture() {
  const value = await applicationJobsFixture(); cleanups.push(value.cleanup); return value;
}
async function queue(fastRetry = false) {
  const db = new PGlite();
  const boss = await openQueue({ db: fromPglite(db), backend: 'pglite', schedule: false, supervise: false });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await boss.stop({ graceful: true }); await db.close(); };
  cleanups.push(close);
  // Exercise pg-boss retry transitions without a minute-long production delay.
  if (fastRetry) await boss.updateQueue(APPLICATION_QUEUE, { retryDelay: 0, retryBackoff: false });
  return { boss, db, close };
}
async function completed(boss: PgBoss, id: string, expectedState: 'completed' | 'failed' = 'completed') {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const job = await boss.getJobById(APPLICATION_QUEUE, id);
    if (job?.state === expectedState) return job;
    if (job?.state === 'failed' || job?.state === 'completed') throw new Error(`Unexpected application callback outcome: ${JSON.stringify(job.output)}`);
    await delay(50);
  }
  const job = await boss.getJobById(APPLICATION_QUEUE, id);
  throw new Error(`Application callback did not complete: ${JSON.stringify(job)}`);
}
const parsedJobs = (f: Awaited<ReturnType<typeof fixture>>) => Object.values(f.jobs).map(job => ApplicationJobSchema.parse(job));
const baseJob = { schemaVersion: 1 as const, kind: 'semantic-review' as const,
  ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), workspaceId: 'review-workspace' };

describe('bounded application queue contract', () => {
  it('normalizes stable logical identities and accepts only frozen selections', () => {
    const parsed = ApplicationJobSchema.parse(baseJob);
    expect(parsed.attempt).toBe('initial');
    expect(applicationJobDigest(baseJob)).toBe(applicationJobDigest(parsed));
    expect(applicationJobId(baseJob)).toBe(applicationJobId(parsed));
    expect(applicationJobId(baseJob)).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(applicationJobId({ ...baseJob, attempt: 'review-again' })).not.toBe(applicationJobId(baseJob));
    for (const field of ['repoPath', 'runtime', 'backend', 'model', 'modelConfig', 'credential', 'codexPathOverride', 'result']) {
      expect(ApplicationJobSchema.safeParse({ ...baseJob, [field]: 'queue-input-is-not-authority' }).success).toBe(false);
    }
    for (const workspaceId of ['../repo', '/tmp/repo', 'file://repo', 'owner/repository', '', 'x'.repeat(81)]) {
      expect(ApplicationJobSchema.safeParse({ ...baseJob, workspaceId }).success).toBe(false);
    }
    expect(ApplicationJobSchema.safeParse({ ...baseJob, attempt: '../attempt' }).success).toBe(false);
    expect(ApplicationJobSchema.safeParse({ ...baseJob, ruleDigest: 'HEAD' }).success).toBe(false);
    expect(ApplicationJobSchema.safeParse({ ...baseJob, kind: 'unsupported' }).success).toBe(false);
    expect(ApplicationJobSchema.safeParse({ schemaVersion: 1, kind: 'pr-mining', requestDigest: 'a'.repeat(64),
      workspaceId: 'mining', candidateCreatedAt: 'tomorrow' }).success).toBe(false);
  });

  it('deduplicates normalized application jobs and retains explicit production retry policy', async () => {
    const { boss } = await queue();
    const id = await enqueueApplication(boss, baseJob);
    expect(id).toBe(applicationJobId(baseJob));
    expect(await enqueueApplication(boss, { ...baseJob, attempt: 'initial' })).toBeNull();
    const job = await boss.getJobById(APPLICATION_QUEUE, id!);
    expect(job).toMatchObject({ data: ApplicationJobSchema.parse(baseJob), retryLimit: 2, retryDelay: 60,
      retryBackoff: true, heartbeatSeconds: 60 });
    expect(JSON.stringify(job!.data)).not.toMatch(/repoPath|modelConfig|codexPathOverride|credential|backend/);
    await expect(enqueueApplication(boss, { ...baseJob, repoPath: '/untrusted' } as ApplicationJobInput)).rejects.toThrow();
  }, 30_000);

  it('revalidates direct broker payloads before calling the dispatcher', async () => {
    const { boss } = await queue();
    await boss.updateQueue(APPLICATION_QUEUE, { retryLimit: 0 });
    let dispatched = 0;
    await workApplication(boss, async () => { dispatched++; return { unexpected: true }; });
    // Bypass enqueueApplication on purpose, as an untrusted queue producer could.
    const id = await boss.send(APPLICATION_QUEUE, { ...baseJob, backend: { kind: 'self-declared-runtime' } });
    const job = await completed(boss, id!, 'failed');
    expect(job.retryCount).toBe(0); expect(dispatched).toBe(0);
    expect(job.output).not.toHaveProperty('unexpected');
  }, 30_000);
});

describe('actual asynchronous pg-boss application callbacks (authored SDK, no live services)', () => {
  it('persists mining, exact semantic review and revision; lost acknowledgement and reopened delivery never rerun completed work', async () => {
    const f = await fixture(), { boss, close } = await queue(true);
    const dispatch = createApplicationJobDispatcher({ store: f.store, config: f.config,
      runtime: f.dependency, resolveWorkspace: f.resolveWorkspace });
    const deliveries = new Map<string, number>();
    await workApplication(boss, async (job, signal) => {
      const digest = applicationJobDigest(job), count = (deliveries.get(digest) ?? 0) + 1;
      deliveries.set(digest, count);
      const result = await dispatch(job, signal);
      // Domain+ledger committed, but the queue did not receive its acknowledgement.
      if (job.kind === 'pr-mining' && count === 1) throw new Error('Authored lost acknowledgement');
      return result;
    });
    const jobs = parsedJobs(f);
    const ids = await Promise.all(jobs.map(job => enqueueApplication(boss, job)));
    const completedJobs = await Promise.all(ids.map(id => completed(boss, id!)));
    expect(completedJobs.map(job => job.output)).toEqual([
      expect.objectContaining({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified', outcome: expect.objectContaining({ kind: 'pr-mining-candidate' }) }),
      expect.objectContaining({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified', outcome: expect.objectContaining({ kind: 'semantic-review' }) }),
      expect.objectContaining({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified', outcome: expect.objectContaining({ kind: 'revision-candidate' }) }),
    ]);
    expect(completedJobs[0].retryCount).toBe(1);
    expect(deliveries.get(applicationJobDigest(f.jobs.mining))).toBe(2);
    expect(f.executions.sort()).toEqual(['pr-mining-v1', 'rule-revision-v2', 'semantic-review-v2']);
    expect(f.resolved).toHaveLength(3);
    expect(f.calls.filter(value => value === 'destroy')).toHaveLength(3);
    const mining = await f.store.listPrMiningCandidates();
    const revisions = await f.store.listRevisionCandidates();
    const reviews = (await f.store.listSemanticReviews()).filter(review => review.ruleDigest === f.reviewRule.digest);
    expect(mining).toHaveLength(1); expect(revisions).toHaveLength(1); expect(reviews).toHaveLength(1);
    expect(mining[0].candidate).toMatchObject({ source: 'fixture', synthesis: 'not_run', activation: 'not_performed', certification: 'none',
      executionReceipt: { cleanup: 'verified', modelExecution: 'not_run', workerResult: { sessionId: 'authored-queue-sdk-session', boundary: 'authored-test-no-isolation' } } });
    expect(reviews[0]).toMatchObject({ notification: 'not_performed', executionReceipt: {
      snapshotCheck: 'exact-local-git-recapture-matched', cleanup: 'verified', modelExecution: 'not_run',
      workerResult: { outputContract: 'semantic-review-v2', boundary: 'authored-test-no-isolation' } } });
    expect(reviews[0].findings.map(finding => finding.status).sort()).toEqual(['not_verified', 'violation']);
    expect(revisions[0].candidate).toMatchObject({ source: 'fixture', synthesis: 'not_run', activation: 'not_performed',
      executionReceipt: { cleanup: 'verified', modelExecution: 'not_run', workerResult: { outputContract: 'rule-revision-v2', boundary: 'authored-test-no-isolation' } } });
    expect(await f.store.getActive(f.reviewRule.rule.ruleId)).toBeNull();
    expect(await f.store.getActive(f.baseRule.rule.ruleId)).toBeNull();
    expect(await f.store.getActive(f.miningRequest.request.input.requestedRule.ruleId)).toBeNull();
    for (const job of jobs) expect(await f.store.getApplicationJob(applicationJobDigest(job))).toMatchObject({ state: 'finished', attempts: 1 });
    expect(JSON.stringify(completedJobs.map(job => job.output))).not.toMatch(/repoPath|worktreePath|gateway|prompt|sessionId|workerResult/);
    await close(); await f.closeStore();
    const reopened = await QualEvoStore.openPGlite(f.storePath); cleanups.push(() => reopened.close());
    expect(await reopened.listPrMiningCandidates()).toEqual(mining);
    expect(await reopened.listRevisionCandidates()).toEqual(revisions);
    expect(await reopened.getSemanticReview(reviews[0].id)).toEqual(reviews[0]);
    // A fresh broker deliberately has no prior queue IDs. The durable application
    // ledger must still prevent another resolution, execution, or domain write.
    const replayQueue = await queue();
    const reopenedDispatch = createApplicationJobDispatcher({ store: reopened });
    await workApplication(replayQueue.boss, reopenedDispatch);
    const replayIds = await Promise.all(jobs.map(job => enqueueApplication(replayQueue.boss, job)));
    const replayed = await Promise.all(replayIds.map(id => completed(replayQueue.boss, id!)));
    expect(replayed.map(job => job.output)).toEqual(completedJobs.map(job => job.output));
    expect(f.executions).toHaveLength(3); expect(f.resolved).toHaveLength(3);
    expect(await reopened.listPrMiningCandidates()).toEqual(mining);
    expect(await reopened.listRevisionCandidates()).toEqual(revisions);
  }, 90_000);

  it('retries a recoverable execution failure through pg-boss and commits one review only after verified cleanup', async () => {
    const f = await fixture(), { boss } = await queue(true);
    f.faults.executeFailures = 1;
    await workApplication(boss, createApplicationJobDispatcher({ store: f.store, config: f.config,
      runtime: f.dependency, resolveWorkspace: f.resolveWorkspace }));
    const id = await enqueueApplication(boss, f.jobs.review), job = await completed(boss, id!);
    expect(job.retryCount).toBe(1);
    expect(job.output).toMatchObject({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified' });
    expect(f.executions).toEqual(['semantic-review-v2', 'semantic-review-v2']);
    expect(f.calls.filter(value => value === 'destroy')).toHaveLength(2);
    expect(await f.store.getApplicationJob(applicationJobDigest(f.jobs.review))).toMatchObject({ state: 'finished', attempts: 2 });
    expect((await f.store.listSemanticReviews()).filter(review => review.ruleDigest === f.reviewRule.digest)).toHaveLength(1);
  }, 60_000);

  it.each(['write-failure', 'cancelled-during-commit'] as const)('rolls back a generated candidate on %s and retries the actual callback safely', async failure => {
    const f = await fixture(), { boss } = await queue(true), originalTransaction = f.db.transaction;
    const rulesBefore = await f.store.listRuleVersions();
    const controller = new AbortController();
    let injected = false, candidateSeenInsideFailedTransaction = false, observedRollback = false;
    f.db.transaction = fn => originalTransaction(tx => fn({
      query: async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (!injected && sql.startsWith("UPDATE qe_application_jobs SET state='finished'")) {
          injected = true;
          const inside = await tx.query<{ count: number }>('SELECT count(*)::integer AS count FROM qe_pr_mining_candidates');
          candidateSeenInsideFailedTransaction = inside.rows[0].count === 1;
          if (failure === 'write-failure') throw new Error('Authored lost application-outcome write');
          // The dispatcher's pre-commit signal check has already passed. Pause
          // its final UPDATE, deliver cancellation after the domain save, and
          // resume SQL; a post-await signal check must roll back both writes.
          await delay(0); controller.abort();
        }
        return tx.query<T>(sql, params);
      },
    }));
    const dispatch = createApplicationJobDispatcher({ store: f.store, config: f.config,
      runtime: f.dependency, resolveWorkspace: f.resolveWorkspace });
    await workApplication(boss, async (job, signal) => {
      try { return await dispatch(job, failure === 'cancelled-during-commit' && !injected ? controller.signal : signal); }
      catch (error) {
        expect(await f.store.listPrMiningCandidates()).toEqual([]);
        expect(await f.store.listRuleVersions()).toEqual(rulesBefore);
        expect(await f.store.getApplicationJob(applicationJobDigest(job))).toMatchObject({ state: 'retryable', attempts: 1,
          result: { status: 'failed', modelExecution: 'not_run', cleanup: 'verified',
            reason: failure === 'write-failure' ? 'persistence_failed' : 'cancelled' } });
        observedRollback = true;
        throw error;
      }
    });
    const id = await enqueueApplication(boss, f.jobs.mining), job = await completed(boss, id!);
    expect(injected && candidateSeenInsideFailedTransaction && observedRollback).toBe(true);
    expect(job.retryCount).toBe(1);
    expect(f.executions).toEqual(['pr-mining-v1', 'pr-mining-v1']);
    expect(await f.store.listPrMiningCandidates()).toHaveLength(1);
    expect(await f.store.listRuleVersions()).toHaveLength(rulesBefore.length + 1);
    expect(await f.store.getApplicationJob(applicationJobDigest(f.jobs.mining))).toMatchObject({ state: 'finished', attempts: 2 });
  }, 60_000);

  it.each(['cancelled', 'timed-out'] as const)('waits for %s cleanup before a queue retry may save one candidate', async failure => {
    const f = await fixture(), { boss } = await queue(true);
    let deliveries = 0;
    const failures: unknown[] = [];
    // The interrupted attempt is an authored non-returning runtime. Only its
    // subsequent successful retry invokes the real official SDK fixture.
    f.faults.executeHangs = 1;
    await workApplication(boss, async (job, signal) => {
      const first = ++deliveries === 1, controller = new AbortController();
      if (first && failure === 'cancelled') f.faults.onExecute = () => { f.faults.onExecute = undefined; controller.abort(); };
      const runtime = first && failure === 'timed-out'
        ? { ...f.dependency, limits: { ...f.dependency.limits, timeoutMs: 50 } } : f.dependency;
      const dispatch = createApplicationJobDispatcher({ store: f.store, config: f.config, runtime, resolveWorkspace: f.resolveWorkspace });
      try { return await dispatch(job, first && failure === 'cancelled' ? controller.signal : signal); }
      catch (error) {
        failures.push(await f.store.getApplicationJob(applicationJobDigest(job)));
        expect(await f.store.listPrMiningCandidates()).toEqual([]);
        expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
        throw error;
      }
    });
    const id = await enqueueApplication(boss, f.jobs.mining), job = await completed(boss, id!);
    expect(job.retryCount).toBe(1); expect(deliveries).toBe(2);
    expect(failures).toEqual([expect.objectContaining({ state: 'retryable', attempts: 1,
      result: expect.objectContaining({ status: 'failed', modelExecution: 'not_run', cleanup: 'verified',
        reason: failure === 'cancelled' ? 'cancelled' : 'timed_out' }) })]);
    expect(job.output).toMatchObject({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified' });
    expect(await f.store.listPrMiningCandidates()).toHaveLength(1);
    expect(await f.store.getApplicationJob(applicationJobDigest(f.jobs.mining))).toMatchObject({ state: 'finished', attempts: 2 });
  }, 60_000);

  it('persists mining insufficient-evidence and revision no-mutation outcomes without creating candidates or activating rules', async () => {
    const f = await fixture(), { boss, close } = await queue();
    f.values['pr-mining-v1'] = { result: { status: 'insufficient_evidence', reasoning: 'Authored insufficient policy evidence', missingEvidence: ['Policy'], evidenceRefs: [] } };
    f.values['rule-revision-v2'] = { ...f.value, result: { status: 'no_rule_change', operator: 'request_context',
      reasoning: 'Authored missing applicable guard context', nextStep: 'Request the applicable guard policy',
      missingEvidence: ['Applicable guard policy'], evidenceRefs: [],
      diagnoses: [{ ...f.value.result.diagnoses[0], category: 'context', missingEvidence: ['Applicable guard policy'] }] } };
    const rulesBefore = await f.store.listRuleVersions(), findingBefore = await f.store.getReviewFinding(f.finding.id);
    await workApplication(boss, createApplicationJobDispatcher({ store: f.store, config: f.config,
      runtime: f.dependency, resolveWorkspace: f.resolveWorkspace }));
    const jobs = [f.jobs.mining, f.jobs.revision];
    const ids = await Promise.all(jobs.map(job => enqueueApplication(boss, job)));
    const done = await Promise.all(ids.map(id => completed(boss, id!)));
    expect(done[0].output).toMatchObject({ status: 'completed', outcome: { kind: 'mining-insufficient-evidence' }, modelExecution: 'not_run', cleanup: 'verified' });
    expect(done[0].output).not.toHaveProperty('receipt');
    expect(done[1].output).toMatchObject({ status: 'completed', outcome: { kind: 'revision-no-mutation' }, modelExecution: 'not_run', cleanup: 'verified' });
    expect(await f.store.getApplicationJob(applicationJobDigest(f.jobs.mining))).toMatchObject({ state: 'finished', result: {
      receipt: { cleanup: 'verified', modelExecution: 'not_run', workerResult: { value: f.values['pr-mining-v1'] } } } });
    const outcomes = await f.store.listRevisionOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toMatchObject({ ruleMutation: 'not_performed', reviewRepair: 'not_performed', activation: 'not_performed', source: 'fixture' });
    expect(await f.store.listPrMiningCandidates()).toEqual([]);
    expect(await f.store.listRevisionCandidates()).toEqual([]);
    expect(await f.store.listRuleVersions()).toEqual(rulesBefore);
    expect(await f.store.getReviewFinding(f.finding.id)).toEqual(findingBefore);
    expect(await f.store.getRevisionRequest(f.request.digest)).toEqual(f.request);
    expect(await f.store.getActive(f.baseRule.rule.ruleId)).toBeNull();
    await close(); await f.closeStore();
    const reopened = await QualEvoStore.openPGlite(f.storePath); cleanups.push(() => reopened.close());
    expect(await reopened.listRevisionOutcomes()).toEqual(outcomes);
    expect(await reopened.listRuleVersions()).toEqual(rulesBefore);
    expect(await reopened.getApplicationJob(applicationJobDigest(f.jobs.mining))).toMatchObject({ state: 'finished',
      result: { receipt: { workerResult: { value: f.values['pr-mining-v1'] } } } });
    const replay = createApplicationJobDispatcher({ store: reopened });
    expect(await replay(f.jobs.revision, new AbortController().signal)).toEqual(done[1].output);
    expect(await replay(f.jobs.mining, new AbortController().signal)).toEqual(done[0].output);
    expect(f.executions).toHaveLength(2);
  }, 60_000);

  it.each(['runtime', 'disabled', 'resolver'] as const)('blocks missing %s configuration through a real callback before allocation', async kind => {
    const store = await QualEvoStore.openPGlite(); cleanups.push(() => store.close());
    const { boss } = await queue();
    let allocations = 0;
    const runtime = { id: 'authored-blocked-runtime', limits: revisionLimits, backend: { kind: 'authored-test-no-isolation' as const,
      reserve() { allocations++; throw new Error('Must not allocate'); } } };
    const dispatch = createApplicationJobDispatcher({ store, ...(kind === 'runtime' ? {} : { runtime }),
      config: { enabled: kind !== 'disabled', model: 'authored-never-run' },
      ...(kind === 'resolver' ? {} : { resolveWorkspace: async () => { allocations++; throw new Error('Must not resolve'); } }) });
    await workApplication(boss, dispatch);
    const id = await enqueueApplication(boss, baseJob), job = await completed(boss, id!);
    expect(job.output).toEqual({ status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started',
      reason: kind === 'runtime' ? 'runtime_unavailable' : kind === 'disabled' ? 'disabled' : 'workspace_resolver_unavailable' });
    expect(allocations).toBe(0);
    expect(await store.listSemanticReviews()).toEqual([]);
    expect(await store.getApplicationJob(applicationJobDigest(baseJob))).toMatchObject({ state: 'finished', attempts: 1 });
  }, 30_000);

  it('rejects a trusted resolver returning a workspace that cannot reproduce the frozen review snapshot', async () => {
    const f = await fixture(), { boss } = await queue();
    await boss.updateQueue(APPLICATION_QUEUE, { retryLimit: 0 });
    await workApplication(boss, createApplicationJobDispatcher({ store: f.store, config: f.config,
      runtime: f.dependency, resolveWorkspace: async () => f.workspace }));
    const id = await enqueueApplication(boss, f.jobs.review), job = await completed(boss, id!, 'failed');
    expect(job.retryCount).toBe(0); expect(f.executions).toEqual([]); expect(f.calls).toEqual([]);
    expect((await f.store.listSemanticReviews()).filter(review => review.ruleDigest === f.reviewRule.digest)).toEqual([]);
    expect(await f.store.getApplicationJob(applicationJobDigest(f.jobs.review))).toMatchObject({ state: 'retryable', attempts: 1,
      result: { status: 'failed', modelExecution: 'not_run', cleanup: 'not_started', reason: 'input_rejected' } });
    expect(JSON.stringify(job.output)).not.toContain(f.directory);
  }, 60_000);

  it('retains unverified cleanup as a terminal blocked record and never publishes its generated candidate', async () => {
    const f = await fixture(), { boss } = await queue(true);
    f.faults.destroyFailure = true;
    await workApplication(boss, createApplicationJobDispatcher({ store: f.store, config: f.config,
      runtime: f.dependency, resolveWorkspace: f.resolveWorkspace }));
    const id = await enqueueApplication(boss, f.jobs.mining), job = await completed(boss, id!);
    expect(job.output).toEqual({ status: 'blocked', modelExecution: 'not_run', cleanup: 'retained-for-recovery', reason: 'cleanup_not_verified' });
    expect(job.retryCount).toBe(0);
    expect(f.executions).toHaveLength(1);
    expect(await f.store.listPrMiningCandidates()).toEqual([]);
    expect(await f.store.getApplicationJob(applicationJobDigest(f.jobs.mining))).toMatchObject({ state: 'finished', attempts: 1 });
  }, 60_000);
});
