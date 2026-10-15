import { expect, it } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { prepareReviewFeedback } from '../src/feedback-preparation.js';
import { semanticInputs, readAsset } from './helpers/semantic-review-fixture.js';
import { digestOf } from '../src/core/identity.js';

async function fixture() {
  const store = await QualEvoStore.openPGlite();
  try {
    const input = semanticInputs({ assets: [readAsset] });
    const rule = await store.importRuleVersion(input.rule.rule, [input.problemCase]);
    const snapshot = await store.importChangeSnapshot(input.snapshot.snapshot);
    const review = await store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: snapshot.digest });
    const finding = review.findings[0];
    if (!finding) throw new Error('Synthetic structural finding missing');
    return { store, finding, input: { id: 'prepared-feedback', findingId: finding.id,
      kind: 'label', label: 'FP', source: 'fixture', actor: 'synthetic-test',
      reason: 'Authored test declaration, not independent human feedback', createdAt: '2026-10-15T00:00:00Z' } };
  } catch (error) { await store.close(); throw error; }
}
it('prepares exact stored identities without feedback/revision/governance effects and retains explicit source', async () => {
  const f = await fixture();
  try {
    const beforeGovernance = await f.store.getSemanticGovernance(f.finding.ruleId);
    const prepared = await prepareReviewFeedback(f.store, f.input);
    expect(prepared).toEqual({ ...f.input, reviewId: f.finding.reviewId, ruleDigest: f.finding.ruleDigest, ruleVersion: f.finding.ruleVersion });
    const declared = await prepareReviewFeedback(f.store, { ...f.input, source: 'local-human-declared' });
    expect(declared.source).toBe('local-human-declared'); // Synthetic schema exercise only; not persisted human feedback.
    expect(await f.store.listReviewFeedback()).toEqual([]);
    expect((await f.store.getReviewFinding(f.finding.id)).verdict).toBe('Unknown');
    expect(await f.store.listRevisionRequests()).toEqual([]);
    expect(await f.store.getSemanticGovernance(f.finding.ruleId)).toEqual(beforeGovernance);
  } finally { await f.store.close(); }
},30000);
it('rejects absent findings, caller-injected identities and invalid authored feedback combinations', async () => {
  const f = await fixture();
  try {
    await expect(prepareReviewFeedback(f.store, { ...f.input, findingId: `review_finding_${'f'.repeat(64)}` })).rejects.toThrow();
    for (const override of [
      { reviewId: f.finding.reviewId }, { ruleDigest: f.finding.ruleDigest }, { ruleVersion: 'other' },
      { kind: 'label', label: null }, { kind: 'note', label: 'FP' }, { kind: 'merge', label: 'TP' },
      { kind: 'resolve', label: 'FP' }, { kind: 'invalid' }, { label: 'invalid' }, { source: 'human' },
      { source: undefined }, { reason: '' }, { createdAt: 'invalid' },
    ]) await expect(prepareReviewFeedback(f.store, { ...f.input, ...override })).rejects.toThrow();
    for (const kind of ['note', 'resolve', 'merge']) {
      expect(await prepareReviewFeedback(f.store, { ...f.input, kind, label: null })).toMatchObject({ kind, label: null });
    }
    expect(await f.store.listReviewFeedback()).toEqual([]);
  } finally { await f.store.close(); }
},30000);
it('reuses immutable add and revision binding; fixture labels do not become human verdicts', async () => {
  const f = await fixture();
  try {
    const prepared = await prepareReviewFeedback(f.store, f.input);
    expect(await f.store.appendReviewFeedback(prepared)).toEqual(prepared);
    expect(await f.store.appendReviewFeedback(prepared)).toEqual(prepared);
    await expect(f.store.appendReviewFeedback({ ...prepared, reason: 'Changed immutable event' })).rejects.toThrow();
    await expect(f.store.appendReviewFeedback({ ...prepared, id: 'wrong-version', ruleVersion: 'other' })).rejects.toThrow('exact finding');
    expect((await f.store.getReviewFinding(f.finding.id)).verdict).toBe('Unknown');
    expect(await f.store.listReviewFeedback()).toHaveLength(1);
    const request = await f.store.createRevisionRequest({ id: 'prepared-request', baseRuleDigest: f.finding.ruleDigest,
      requestedRuleVersion: 'draft-2', feedbackIds: [prepared.id], requestedChange: 'Inspect this authored feedback',
      actor: 'synthetic-test', source: 'fixture', createdAt: f.input.createdAt });
    expect(request.request.feedbackBindings).toEqual([{ id: prepared.id, digest: digestOf(prepared) }]);
    expect(request.request.synthesis).toBe('not_run');
  } finally { await f.store.close(); }
},30000);
