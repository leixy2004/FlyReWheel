import { expect, it, vi } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { runRevisionComparisonDemo } from '../src/revision-demo.js';
import { digestOf } from '../src/core/identity.js';
import { bindGovernedOfflineFixtures, runGovernedOfflineReview } from '../src/governed-review-offline.js';
import { governedReviewJobs } from '../src/governed-semantic-review.js';
import { applicationJobDigest } from '../src/application-job-contract.js';

async function fixture() {
  const store = await QualEvoStore.openPGlite(), demo = await runRevisionComparisonDemo(store);
  const candidate = await store.getRuleVersion(demo.compatible.candidateRuleDigest);
  if (candidate.rule.schemaVersion !== 2) throw new Error('Expected semantic fixture');
  const common = { namespace: 'local-semantic-review' as const, ruleDigest: candidate.digest, scopeDigest: digestOf(candidate.rule.scope),
    actor: 'fixture', source: 'fixture' as const, reason: 'Authored offline selection', createdAt: '2026-10-13T00:00:00Z' };
  const registered = await store.applySemanticGovernance({ ...common, id: 'offline-register', action: 'register', expectedHeadDigest: null });
  const chosen = await store.applySemanticGovernance({ ...common, id: 'offline-select', action: 'select-shadow', expectedHeadDigest: registered.digest, decisionDigest: demo.compatible.decision.digest });
  const response = (await store.getSemanticReview(demo.compatible.candidateReviewId)).fixtures!;
  const fixtures = new Map([[digestOf(response), response]]);
  const input = { id: 'offline-plan', repository: candidate.rule.scope.repositories[0], paths: ['src/negative.ts'], snapshotDigest: demo.snapshotDigest, workspaceId: 'offline-unused' };
  const plan = await store.createGovernedReviewPlan(bindGovernedOfflineFixtures(input, fixtures));
  return { store, demo, fixtures, input, plan, suspend: () => store.applySemanticGovernance({ ...common, id: 'offline-suspend', action: 'suspend', expectedHeadDigest: chosen.digest }) };
}
it('binds authored evidence to exact governed jobs, preserves admission and reuses completed output', async () => {
  const f = await fixture();
  try {
    const job = governedReviewJobs(f.plan)[0], signal = new AbortController().signal;
    expect(job).toMatchObject({ ruleDigest: f.demo.compatible.candidateRuleDigest, offlineFixtureDigest: [...f.fixtures.keys()][0] });
    const first = await runGovernedOfflineReview(f.store, f.plan.digest, f.fixtures, signal);
    expect(first).toMatchObject({ executionMode: 'authored-offline-fixtures', modelExecution: 'not_run', workspaceExecution: 'not_run' });
    expect(first.jobs[0]).toMatchObject({ attempts: 1, admission: { planDigest: f.plan.digest }, result: { status: 'completed' } });
    const review = await f.store.getSemanticReview(first.jobs[0].result!.outcome!.id);
    expect(review.config.fixtureDigest).toBe(job.offlineFixtureDigest); expect(review.executionReceipt).toBeUndefined();
    expect(await runGovernedOfflineReview(f.store, f.plan.digest, f.fixtures, signal)).toEqual(first);
    expect((await f.store.getApplicationJobHistory(applicationJobDigest(job))).recordedAttempts).toBe(1);
    await f.suspend();
    await expect(runGovernedOfflineReview(f.store, f.plan.digest, f.fixtures, signal)).rejects.toMatchObject({ code: 'STALE_GOVERNANCE_PLAN' });
    expect(await f.store.getSemanticReview(review.id)).toEqual(review);
  } finally { await f.store.close(); }
}, 30_000);
it('rejects changed authored input before claiming and a selection suspended before admission', async () => {
  const f = await fixture();
  try {
    const changed = structuredClone([...f.fixtures.values()][0]); changed.judgments[0].reasoning = 'changed authored bytes';
    await expect(runGovernedOfflineReview(f.store, f.plan.digest, new Map([[digestOf(changed), changed]]), new AbortController().signal)).rejects.toThrow('frozen plan');
    const job = governedReviewJobs(f.plan)[0]; expect(await f.store.getApplicationJob(applicationJobDigest(job))).toBeNull();
    const admit = f.store.admitGovernedReviewJob.bind(f.store);
    vi.spyOn(f.store, 'admitGovernedReviewJob').mockImplementationOnce(async (...args) => { await f.suspend(); return admit(...args); });
    const done = await runGovernedOfflineReview(f.store, f.plan.digest, f.fixtures, new AbortController().signal);
    expect(done.jobs[0]).toMatchObject({ admission: null, result: { status: 'blocked', reason: 'stale_governance_plan' } });
    expect((await f.store.listSemanticReviews({ ruleDigest: job.ruleDigest })).length).toBe(2); // Only the demo's structural and fixture reviews.
  } finally { vi.restoreAllMocks(); await f.store.close(); }
}, 30_000);
it('keeps legacy plans unchanged and rejects missing, extra or evaluation fixture bindings', async () => {
  const f = await fixture();
  try {
    const legacy = await f.store.createGovernedReviewPlan({ ...f.input, id: 'legacy-plan' });
    expect(legacy.plan.input).not.toHaveProperty('offlineFixtures'); expect(governedReviewJobs(legacy)[0]).not.toHaveProperty('offlineFixtureDigest');
    await expect(runGovernedOfflineReview(f.store, legacy.digest, f.fixtures, new AbortController().signal)).rejects.toThrow('new plan ID');
    expect(() => bindGovernedOfflineFixtures({ ...f.input, evaluationExportId: 'frozen-study' }, f.fixtures)).toThrow('evaluation');
    const wrong = bindGovernedOfflineFixtures({ ...f.input, id: 'wrong-rule' }, f.fixtures); wrong.offlineFixtures![0].ruleDigest = f.demo.baseRuleDigest;
    await expect(f.store.createGovernedReviewPlan(wrong)).rejects.toThrow('every selected rule');
    expect(() => bindGovernedOfflineFixtures(f.input, new Map())).toThrow();
  } finally { await f.store.close(); }
}, 30_000);
