import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { fromPglite, type PgBoss } from 'pg-boss';
import { afterEach, expect, it, vi } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase } from '../src/storage/database.js';
import { digestOf } from '../src/core/identity.js';
import type { StoredRuleVersion } from '../src/core/semantic-rule.js';
import { ReviewFixtureSchema } from '../src/core/semantic-review.js';
import { applicationJobDigest, applicationJobId, ApplicationJobSchema, applicationJobGovernance } from '../src/application-job-contract.js';
import { createApplicationJobDispatcher, ApplicationJobRetryError, ApplicationJobBusyError } from '../src/application-dispatcher.js';
import { GovernedReviewPlanInputSchema, governedReviewJobs, governedReviewStatus, runGovernedReviewPlan, enqueueGovernedReviewPlan,
  deriveGovernedReviewPlan, GOVERNED_REVIEW_LIMITS } from '../src/governed-semantic-review.js';
import { enqueueApplication, openQueue, workApplication, APPLICATION_QUEUE } from '../src/jobs.js';
import { buildSemanticReview } from '../src/semantic-review.js';
import { semanticInputs } from './helpers/semantic-review-fixture.js';
import { applicationJobsFixture } from './helpers/application-jobs-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!(); });
async function simple() {
  const db = await openPGliteDatabase(), store = await QualEvoStore.initialize(db); cleanup.push(() => store.close());
  const f = semanticInputs(), rule = await store.importRuleVersion(f.rule.rule, [f.problemCase]);
  const snapshot = await store.importChangeSnapshot(f.snapshot.snapshot);
  return { db, store, rule, snapshot, input: { id: 'plan-1', repository: snapshot.snapshot.repository.id, paths: ['src/sample.ts'],
    snapshotDigest: snapshot.digest, workspaceId: 'review-workspace' } };
}
async function apply(store: QualEvoStore, rule: StoredRuleVersion, action: 'register' | 'bootstrap-shadow' | 'suspend' | 'retire', id = action) {
  if (rule.rule.schemaVersion !== 2) throw new Error('Expected v2 fixture');
  return store.applySemanticGovernance({ id: `${rule.rule.ruleId}-${rule.rule.version}-${id}`, action,
    namespace: 'local-semantic-review', ruleDigest: rule.digest, scopeDigest: digestOf(rule.rule.scope),
    expectedHeadDigest: (await store.getSemanticGovernance(rule.rule.ruleId)).headDigest,
    actor: 'authored-governance-fixture', source: 'fixture', reason: 'Local fixture declaration only', createdAt: '2026-10-02T00:00:00Z' });
}
async function bootstrap(store: QualEvoStore, rule: StoredRuleVersion) { await apply(store, rule, 'register'); await apply(store, rule, 'bootstrap-shadow'); }
async function runtimeFixture() {
  const f = await applicationJobsFixture(); cleanup.push(f.cleanup);
  await bootstrap(f.store, f.reviewRule);
  const input = { id: 'runtime-plan', repository: f.reviewSnapshot.snapshot.repository.id, paths: ['src/sample.ts'],
    snapshotDigest: f.reviewSnapshot.digest, workspaceId: 'review-workspace' };
  const dependencies = { store: f.store, runtime: f.dependency, config: f.config, resolveWorkspace: f.resolveWorkspace };
  return { ...f, input, dependencies };
}
async function queue() {
  const db = new PGlite(), boss = await openQueue({ db: fromPglite(db), backend: 'pglite', schedule: false, supervise: false });
  await boss.updateQueue(APPLICATION_QUEUE, { retryDelay: 0, retryBackoff: false });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await boss.stop({ graceful: true }); await db.close(); } };
  cleanup.push(close); return { boss, close };
}
async function completed(boss: PgBoss, id: string) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await boss.getJobById(APPLICATION_QUEUE, id);
    if (result?.state === 'completed') return result;
    if (result?.state === 'failed') throw new Error(`Queue failed: ${JSON.stringify(result.output)}`);
    await delay(40);
  }
  throw new Error('Governed queue callback deadline exceeded');
}

it('freezes exact selection, exclusions and heads, retains historical plans and returns no-eligible without truth claims', async () => {
  const f = await simple();
  const importedOnly = await f.store.createGovernedReviewPlan(f.input);
  expect(importedOnly.plan.selection.selected).toEqual([]);
  expect(importedOnly.plan.selection.excluded).toEqual([]); // Import alone remains inert.
  expect(await runGovernedReviewPlan({ store: f.store }, importedOnly.digest, new AbortController().signal)).toMatchObject({ state: 'no_eligible_rules', jobs: [], certification: 'none' });
  await apply(f.store, f.rule, 'register');
  const candidate = await f.store.createGovernedReviewPlan({ ...f.input, id: 'candidate-plan' });
  expect(candidate.plan.selection.excluded[0].reason).toBe('candidate');
  await apply(f.store, f.rule, 'bootstrap-shadow');
  const selected = await f.store.createGovernedReviewPlan({ ...f.input, id: 'selected-plan' });
  expect(selected.plan.selection.selected).toMatchObject([{ ruleDigest: f.rule.digest, status: 'local-shadow', selectionEvidence: { kind: 'unvalidated-root-bootstrap' } }]);
  expect(governedReviewJobs(selected)).toMatchObject([{ ruleDigest: f.rule.digest, governancePlanDigest: selected.digest }]);
  expect(selected.plan.selectionDigest).toBe(digestOf(selected.plan.selection));
  expect(selected.plan.governanceHeads).toEqual([{ ruleId: f.rule.rule.ruleId, headDigest: (await f.store.getSemanticGovernance(f.rule.rule.ruleId)).headDigest }]);
  await apply(f.store, f.rule, 'suspend');
  expect(await f.store.getGovernedReviewPlan(selected.digest)).toEqual(selected);
  expect(await f.store.createGovernedReviewPlan({ ...f.input, id: 'selected-plan' })).toEqual(selected);
  await expect(f.store.requireCurrentGovernedReviewPlan(selected.digest)).rejects.toMatchObject({ code: 'STALE_GOVERNANCE_PLAN' });
  expect(await governedReviewStatus(f.store, selected.digest)).toMatchObject({ currentGovernance: 'stale-plan', state: 'pending' });
  const suspended = await f.store.createGovernedReviewPlan({ ...f.input, id: 'suspended-plan' });
  expect(suspended.plan.selection.excluded[0].reason).toBe('suspended');
  await apply(f.store, f.rule, 'retire');
  const retired = await f.store.createGovernedReviewPlan({ ...f.input, id: 'retired-plan' });
  expect(retired.plan.selection.excluded[0].reason).toBe('retired');
  expect(await f.store.getActive(f.rule.rule.ruleId)).toBeNull();
  expect(await f.store.listSemanticReviews()).toEqual([]);
  expect(await f.store.getGovernedReviewPlan(importedOnly.digest)).toEqual(importedOnly);
}, 30_000);

it('validates path, repository, authority fields and immutable normalized plan IDs with concurrent retries', async () => {
  const f = await simple(); await bootstrap(f.store, f.rule);
  const [a, b] = await Promise.all([f.store.createGovernedReviewPlan(f.input), f.store.createGovernedReviewPlan({ ...f.input, attempt: 'initial' })]);
  expect(a).toEqual(b);
  expect((await f.db.query('SELECT digest FROM qe_governed_review_plans')).rows).toHaveLength(1);
  for (const change of [{ workspaceId: 'different' }, { attempt: 'different' }]) {
    await expect(f.store.createGovernedReviewPlan({ ...f.input, ...change })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  }
  for (const change of [{ repository: 'other:repo' }, { paths: ['src/missing.ts'] }]) {
    await expect(f.store.createGovernedReviewPlan({ ...f.input, id: 'bad-binding', ...change })).rejects.toMatchObject({ code: 'GOVERNANCE_SNAPSHOT_MISMATCH' });
  }
  for (const paths of [[], ['src/sample.ts', 'src/sample.ts'], ['../secret'], ['src/**'], Array.from({ length: 1001 }, (_, i) => `src/${i}`)]) {
    expect(GovernedReviewPlanInputSchema.safeParse({ ...f.input, paths }).success).toBe(false);
  }
  for (const field of ['runtime', 'backend', 'model', 'selected', 'headDigest', 'label', 'repoPath']) {
    expect(GovernedReviewPlanInputSchema.safeParse({ ...f.input, [field]: 'untrusted' }).success).toBe(false);
  }
  await expect(f.db.query('UPDATE qe_governed_review_plans SET id=$1 WHERE digest=$2', ['changed', a.digest])).rejects.toThrow();
}, 30_000);

it('fails closed above twenty eligible jobs and on manifest byte limits, with no partial persistence', async () => {
  const f = await simple();
  for (let i = 0; i <= GOVERNED_REVIEW_LIMITS.jobs; i++) {
    const rule = await f.store.importRuleVersion({ ...f.rule.rule, ruleId: `bounded-${i}` }); await bootstrap(f.store, rule);
  }
  await expect(f.store.createGovernedReviewPlan(f.input)).rejects.toThrow('20 jobs');
  expect((await f.db.query('SELECT digest FROM qe_governed_review_plans')).rows).toEqual([]);
  const selected = await f.store.selectLocalSemanticRules({ repository: f.input.repository, paths: f.input.paths });
  const entry = selected.selected[0];
  const large = { ...selected, selected: [entry], excluded: Array.from({ length: 80 }, (_, i) => ({ ...entry, ruleId: `excluded-${i}`,
    status: 'candidate' as const, reason: 'candidate' as const, scope: { ...entry.scope, paths: { include: Array.from({ length: 100 }, (_, j) => `${j}-${'a'.repeat(300)}`), exclude: [] } } })) };
  expect(() => deriveGovernedReviewPlan(f.input, large)).toThrow('2MB');
}, 30_000);

it('invalidates a plan on an unrelated registry-head change and rejects substituted jobs before workspace lookup', async () => {
  const f = await runtimeFixture(), plan = await f.store.createGovernedReviewPlan(f.input), [job] = governedReviewJobs(plan);
  const dispatch = createApplicationJobDispatcher(f.dependencies);
  for (const change of [{ snapshotDigest: 'f'.repeat(64) }, { ruleDigest: 'e'.repeat(64) }, { workspaceId: 'other' }, { attempt: 'other' }, { evaluationExportId: 'other' }]) {
    expect(await dispatch({ ...job, ...change }, new AbortController().signal)).toMatchObject({ status: 'blocked', reason: 'governance_plan_rejected' });
  }
  expect(f.resolved).toEqual([]); expect(f.executions).toEqual([]);
  if (f.reviewRule.rule.schemaVersion !== 2) throw new Error('Expected v2');
  const unrelated = await f.store.importRuleVersion({ ...f.reviewRule.rule, ruleId: 'unrelated-rule', scope: { repositories: ['unrelated:repository'], paths: { include: ['docs'], exclude: [] } } });
  await apply(f.store, unrelated, 'register');
  expect(await dispatch(job, new AbortController().signal)).toMatchObject({ status: 'blocked', reason: 'stale_governance_plan', modelExecution: 'not_run' });
  expect(f.resolved).toEqual([]);
  const fresh = await f.store.createGovernedReviewPlan({ ...f.input, id: 'fresh' });
  expect(fresh.plan.selection.excluded[0].reason).toBe('candidate');
}, 30_000);

it('rechecks after workspace resolution and never reserves a runtime for a newly suspended plan', async () => {
  const f = await runtimeFixture(), plan = await f.store.createGovernedReviewPlan(f.input), [job] = governedReviewJobs(plan);
  const dispatch = createApplicationJobDispatcher({ ...f.dependencies, resolveWorkspace: async (selection, signal) => {
    const workspace = await f.resolveWorkspace(selection); signal.throwIfAborted();
    await apply(f.store, f.reviewRule, 'suspend'); return workspace;
  } });
  expect(await dispatch(job, new AbortController().signal)).toMatchObject({ reason: 'stale_governance_plan', cleanup: 'not_started' });
  expect(f.resolved).toHaveLength(1); expect(f.calls).toEqual([]);
  expect(await f.store.getGovernedReviewAdmission(job, 1)).toBeNull();
  expect((await f.store.listSemanticReviews({ ruleDigest: f.reviewRule.digest })).length).toBe(0);
}, 30_000);

it('admits only the owning claim, rejects concurrent delivery and records later changes as historical selection', async () => {
  const f = await runtimeFixture(), plan = await f.store.createGovernedReviewPlan(f.input), [job] = governedReviewJobs(plan);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const original = f.backend.reserve.bind(f.backend);
  f.backend.reserve = (...args) => {
    const runtime = original(...args);
    return { ...runtime, async prepare(signal) { enter(); await barrier; return runtime.prepare(signal); } };
  };
  const dispatch = createApplicationJobDispatcher(f.dependencies), running = dispatch(job, new AbortController().signal);
  await entered;
  await expect(dispatch(job, new AbortController().signal)).rejects.toBeInstanceOf(ApplicationJobBusyError);
  await expect(f.store.admitGovernedReviewJob(job, randomUUID())).rejects.toMatchObject({ code: 'APPLICATION_JOB_FENCED' });
  // Admission lock is already released. This transition must complete while execution waits.
  await apply(f.store, f.reviewRule, 'suspend'); release();
  const result = await running;
  expect(result).toMatchObject({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified' });
  expect(await dispatch(job, new AbortController().signal)).toEqual(result);
  expect(f.executions).toHaveLength(1);
  expect(await governedReviewStatus(f.store, plan.digest)).toMatchObject({ state: 'finished', currentGovernance: 'stale-plan',
    jobs: [{ admission: { planDigest: plan.digest, attempt: 1, selectionDigest: plan.plan.selectionDigest } }] });
  expect((await f.store.getSemanticReview(result.outcome!.id)).notification).toBe('not_performed');
}, 30_000);

it('rechecks governance on safe retries, while explicit digest replay remains usable and distinctly labeled', async () => {
  const f = await runtimeFixture(), plan = await f.store.createGovernedReviewPlan(f.input), [job] = governedReviewJobs(plan);
  const dispatch = createApplicationJobDispatcher(f.dependencies); f.faults.executeFailures = 1;
  await expect(dispatch(job, new AbortController().signal)).rejects.toBeInstanceOf(ApplicationJobRetryError);
  expect(await f.store.getGovernedReviewAdmission(job, 1)).toMatchObject({ attempt: 1, planDigest: plan.digest });
  await apply(f.store, f.reviewRule, 'suspend');
  expect(await dispatch(job, new AbortController().signal)).toMatchObject({ reason: 'stale_governance_plan', modelExecution: 'not_run' });
  expect(await f.store.getGovernedReviewAdmission(job, 2)).toBeNull();
  expect(f.executions).toHaveLength(1);
  const replay = ApplicationJobSchema.parse(f.jobs.review);
  expect(applicationJobGovernance(replay)).toEqual({ reviewSelection: 'explicit-digest-replay-not-governance-governed' });
  expect(applicationJobDigest(replay)).not.toBe(applicationJobDigest(job));
  expect(await dispatch(replay, new AbortController().signal)).toMatchObject({ status: 'completed', modelExecution: 'not_run' });
  expect(f.executions).toHaveLength(2);
}, 30_000);

it('runs root bootstrap to governed review to suspension and comparison-backed successor through actual pg-boss callbacks', async () => {
  const f = await runtimeFixture(), { boss, close } = await queue();
  const dispatch = createApplicationJobDispatcher(f.dependencies), deliveries = new Map<string, number>();
  await workApplication(boss, async (job, signal) => {
    const digest = applicationJobDigest(job), number = (deliveries.get(digest) ?? 0) + 1; deliveries.set(digest, number);
    const result = await dispatch(job, signal);
    if (number === 1 && job.attempt === 'lost-ack') throw new Error('Authored lost acknowledgement');
    return result;
  });
  const plan = await f.store.createGovernedReviewPlan({ ...f.input, attempt: 'lost-ack' }), [job] = governedReviewJobs(plan);
  const enqueued = await enqueueGovernedReviewPlan(f.store, boss, plan.digest);
  expect(enqueued.jobs[0].enqueued).toBe(true);
  expect((await enqueueGovernedReviewPlan(f.store, boss, plan.digest)).jobs[0].enqueued).toBe(false);
  const done = await completed(boss, applicationJobId(job));
  expect(done.retryCount).toBe(1); expect(deliveries.get(applicationJobDigest(job))).toBe(2);
  const baseReview = await f.store.getSemanticReview((done.output as { outcome: { id: string } }).outcome.id);
  expect(baseReview.executionReceipt).toMatchObject({ modelExecution: 'not_run', snapshotCheck: 'exact-local-git-recapture-matched' });
  expect(f.executions).toHaveLength(1);
  for (const finding of baseReview.findings) expect((await f.store.getReviewFinding(finding.id)).feedback).toEqual([]);
  const pending = await f.store.createGovernedReviewPlan({ ...f.input, id: 'pending-before-suspend' });
  await apply(f.store, f.reviewRule, 'suspend');
  await expect(enqueueGovernedReviewPlan(f.store, boss, pending.digest)).rejects.toMatchObject({ code: 'STALE_GOVERNANCE_PLAN' });
  const [pendingJob] = governedReviewJobs(pending);
  await enqueueApplication(boss, pendingJob); // Direct producer bypass is still guarded at the callback.
  expect((await completed(boss, applicationJobId(pendingJob))).output).toMatchObject({ reason: 'stale_governance_plan' });
  const suspended = await f.store.createGovernedReviewPlan({ ...f.input, id: 'suspended' });
  expect((await enqueueGovernedReviewPlan(f.store, boss, suspended.digest)).jobs).toEqual([]);
  const feedback = await f.store.appendReviewFeedback({ id: 'governed-fixture-feedback', findingId: baseReview.findings.find(finding => finding.status === 'violation')!.id,
    reviewId: baseReview.id, ruleDigest: f.reviewRule.digest, ruleVersion: f.reviewRule.rule.version,
    source: 'fixture', actor: 'authored-fixture', kind: 'label', label: 'TP', reason: 'Authored declaration only', createdAt: '2026-10-02T00:00:00Z' });
  const request = await f.store.createRevisionRequest({ id: 'governed-revision', baseRuleDigest: f.reviewRule.digest,
    requestedRuleVersion: 'governed-successor', feedbackIds: [feedback.id], requestedChange: 'Authored compatible successor',
    actor: 'authored-fixture', source: 'fixture', createdAt: '2026-10-02T00:00:00Z' });
  if (f.reviewRule.rule.schemaVersion !== 2) throw new Error('Expected v2');
  const candidate = await f.store.importRuleVersion({ ...f.reviewRule.rule, version: 'governed-successor',
    provenance: { ...f.reviewRule.rule.provenance, parentDigest: f.reviewRule.digest } });
  const target = buildSemanticReview({ rule: candidate, snapshot: f.reviewSnapshot }).coverage.targets[0];
  const value = f.values['semantic-review-v2'] as { ruleDigest: string; snapshotDigest: string; evidence: unknown[]; judgments: { targetId: string }[] };
  f.values['semantic-review-v2'] = { ...value, ruleDigest: candidate.digest, judgments: value.judgments.map(j => ({ ...j, targetId: target.id })) };
  const candidateReview = await f.store.runSemanticReview({ ruleDigest: candidate.digest, snapshotDigest: f.reviewSnapshot.digest,
    fixtures: ReviewFixtureSchema.parse({ schemaVersion: 2, kind: 'semantic-review-offline-fixtures', ...(f.values['semantic-review-v2'] as object) }) });
  const comparison = await f.store.createRevisionComparison({ id: 'governed-comparison', requestDigest: request.digest,
    candidateRuleDigest: candidate.digest, reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: candidateReview.id }], caseBindings: [] });
  expect(comparison.comparison.summary.status).toBe('compatible');
  const decision = await f.store.recordRevisionDecision({ id: 'governed-decision', comparisonDigest: comparison.digest, choice: 'accept',
    source: 'fixture', actor: 'authored-fixture', reason: 'Bounded authored acceptance only', createdAt: '2026-10-02T00:00:00Z' });
  const registered = await apply(f.store, candidate, 'register');
  if (f.reviewRule.rule.schemaVersion !== 2 || candidate.rule.schemaVersion !== 2) throw new Error('Expected v2');
  await f.store.applySemanticGovernance({ id: 'governed-supersede', namespace: 'local-semantic-review', action: 'supersede',
    ruleDigest: f.reviewRule.digest, scopeDigest: digestOf(f.reviewRule.rule.scope), expectedHeadDigest: registered.digest,
    successor: { ruleDigest: candidate.digest, scopeDigest: digestOf(candidate.rule.scope) }, decisionDigest: decision.digest,
    source: 'fixture', actor: 'authored-fixture', reason: 'Explicit local successor', createdAt: '2026-10-02T00:00:00Z' });
  const successor = await f.store.createGovernedReviewPlan({ ...f.input, id: 'successor-plan' }), [successorJob] = governedReviewJobs(successor);
  expect(successorJob.ruleDigest).toBe(candidate.digest);
  expect(successor.plan.selection.excluded).toMatchObject([{ ruleDigest: f.reviewRule.digest, reason: 'superseded' }]);
  expect(successor.plan.selection.selected[0].selectionEvidence).toMatchObject({ kind: 'accepted-local-comparison', decisionSource: 'fixture', certification: 'none' });
  await enqueueGovernedReviewPlan(f.store, boss, successor.digest);
  const succeeded = await completed(boss, applicationJobId(successorJob));
  expect(succeeded.output).toMatchObject({ status: 'completed', modelExecution: 'not_run' });
  expect(f.executions).toHaveLength(2);
  expect(await f.store.getReviewFinding(feedback.findingId)).toMatchObject({ feedback: [feedback], identityVerification: 'caller-declared-unverified' });
  expect(await f.store.getActive(candidate.rule.ruleId)).toBeNull();
  await close(); await f.closeStore();
  const reopened = await QualEvoStore.openPGlite(f.storePath); cleanup.push(() => reopened.close());
  expect(await reopened.getGovernedReviewPlan(plan.digest)).toEqual(plan);
  expect(await createApplicationJobDispatcher({ store: reopened })(successorJob, new AbortController().signal)).toEqual(succeeded.output);
  expect(await governedReviewStatus(reopened, successor.digest)).toMatchObject({ state: 'finished', currentGovernance: 'matches-plan' });
}, 60_000);


it('retries a cleanup-safe governed job through real callbacks, with fresh admissions and one committed review', async () => {
  const f = await runtimeFixture(), { boss } = await queue(), plan = await f.store.createGovernedReviewPlan(f.input), [job] = governedReviewJobs(plan);
  f.faults.executeFailures = 1;
  await workApplication(boss, createApplicationJobDispatcher(f.dependencies));
  await enqueueGovernedReviewPlan(f.store, boss, plan.digest);
  const done = await completed(boss, applicationJobId(job));
  expect(done.retryCount).toBe(1);
  expect(done.output).toMatchObject({ status: 'completed', modelExecution: 'not_run', cleanup: 'verified' });
  expect(f.executions).toHaveLength(2);
  expect(await f.store.getGovernedReviewAdmission(job, 1)).toMatchObject({ attempt: 1, planDigest: plan.digest });
  expect(await f.store.getGovernedReviewAdmission(job, 2)).toMatchObject({ attempt: 2, planDigest: plan.digest });
  expect(await f.store.listSemanticReviews({ ruleDigest: f.reviewRule.digest })).toHaveLength(1);
}, 30_000);

it('historical plans read only their frozen event prefixes, never later rule evidence or its expanded read budget', async () => {
  const f = await simple(); await bootstrap(f.store, f.rule);
  const plan = await f.store.createGovernedReviewPlan(f.input);
  if (f.rule.rule.schemaVersion !== 2) throw new Error('Expected v2');
  const later = await f.store.importRuleVersion({ ...f.rule.rule, version: 'later-unselected', provenance: { ...f.rule.rule.provenance, parentDigest: f.rule.digest } });
  await apply(f.store, later, 'register');
  const transaction = f.db.transaction.bind(f.db);
  vi.spyOn(f.db, 'transaction').mockImplementation(fn => transaction(tx => fn({ query: (sql, params) => {
    if (sql.includes('FROM qe_rule_bundles') && params?.includes(later.digest)) throw new Error('Later evidence must not enter a historical read');
    return tx.query(sql, params);
  } })));
  expect(await f.store.getGovernedReviewPlan(plan.digest)).toEqual(plan);
  await expect(f.store.requireCurrentGovernedReviewPlan(plan.digest)).rejects.toThrow('Later evidence');
}, 30_000);

it('fails closed on a missing admission at completion and rolls back otherwise valid model-domain persistence', async () => {
  const f = await runtimeFixture(), plan = await f.store.createGovernedReviewPlan(f.input), [job] = governedReviewJobs(plan);
  // An object returned by a substituted caller is not a durable store admission.
  vi.spyOn(f.store, 'admitGovernedReviewJob').mockResolvedValue({ schemaVersion: 1, kind: 'local-governed-review-admission',
    jobDigest: applicationJobDigest(job), planDigest: plan.digest, selectionDigest: plan.plan.selectionDigest, attempt: 1,
    semantics: 'head-check-committed-before-execution-not-continuous-authorization' });
  await expect(createApplicationJobDispatcher(f.dependencies)(job, new AbortController().signal)).rejects.toBeInstanceOf(ApplicationJobRetryError);
  expect(await f.store.listSemanticReviews({ ruleDigest: f.reviewRule.digest })).toEqual([]);
  expect(await f.store.getApplicationJob(applicationJobDigest(job))).toMatchObject({ state: 'retryable', result: { reason: 'persistence_failed' } });
}, 30_000);

it.each(['requireCurrentGovernedReviewJob', 'admitGovernedReviewJob'] as const)('retries transient %s storage failures rather than terminally rejecting a valid plan', async method => {
  const f = await runtimeFixture(), plan = await f.store.createGovernedReviewPlan(f.input), [job] = governedReviewJobs(plan);
  vi.spyOn(f.store, method).mockRejectedValueOnce(new Error('Authored transient database transport failure'));
  const dispatch = createApplicationJobDispatcher(f.dependencies);
  await expect(dispatch(job, new AbortController().signal)).rejects.toBeInstanceOf(ApplicationJobRetryError);
  expect(f.executions).toEqual([]);
  expect(await f.store.getApplicationJob(applicationJobDigest(job))).toMatchObject({ state: 'retryable', attempts: 1 });
  expect(await dispatch(job, new AbortController().signal)).toMatchObject({ status: 'completed', modelExecution: 'not_run' });
  expect(await f.store.getGovernedReviewAdmission(job, 2)).toMatchObject({ attempt: 2 });
}, 30_000);
