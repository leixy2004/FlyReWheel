import { afterEach, expect, it } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import type { RevisionRequestInput } from '../src/core/semantic-review.js';
import { readAsset, semanticInputs } from './helpers/semantic-review-fixture.js';

const stores: QualEvoStore[] = [];
afterEach(async () => { while (stores.length) await stores.pop()!.close(); });
const early = '2026-10-01T00:00:00Z', late = '2026-10-02T00:00:00Z';

async function fixture(baseTime: string, feedbackTime: string) {
  const store = await QualEvoStore.openPGlite(); stores.push(store);
  const input = semanticInputs({ assets: [readAsset] });
  input.rule.rule.provenance.createdAt = baseTime;
  const rule = await store.importRuleVersion(input.rule.rule, [input.problemCase]);
  const snapshot = await store.importChangeSnapshot(input.snapshot.snapshot);
  const review = await store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: snapshot.digest });
  const finding = review.findings[0];
  expect(finding).toBeDefined();
  await store.appendReviewFeedback({ id: 'selected-feedback', findingId: finding.id, reviewId: review.id,
    ruleDigest: rule.digest, ruleVersion: rule.rule.version, source: 'fixture', actor: 'authored-fixture',
    kind: 'note', label: null, reason: 'Authored temporal handoff check; no human verdict', createdAt: feedbackTime });
  const request: RevisionRequestInput = { id: 'temporal-request', baseRuleDigest: rule.digest,
    requestedRuleVersion: 'next', feedbackIds: ['selected-feedback'], requestedChange: 'Consider the selected note',
    actor: 'authored-fixture', source: 'fixture', createdAt: early };
  return { store, request };
}

it.each([
  { subject: 'base rule', baseTime: late, feedbackTime: early },
  { subject: 'selected feedback', baseTime: early, feedbackTime: late },
])('rejects a request predating $subject without reserving its immutable ID', async ({ baseTime, feedbackTime }) => {
  const { store, request } = await fixture(baseTime, feedbackTime);
  await expect(store.createRevisionRequest(request)).rejects.toMatchObject({ code: 'INVALID_REVISION_REQUEST' });
  expect(await store.listRevisionRequests()).toEqual([]);
  const corrected = await store.createRevisionRequest({ ...request, createdAt: late });
  expect(await store.getRevisionRequest(corrected.digest)).toEqual(corrected);
  expect((await store.getRevisionGenerationEvidence(corrected.digest)).request).toEqual(corrected);
  expect(await store.createRevisionRequest({ ...request, createdAt: late })).toEqual(corrected);
}, 30_000);

it('accepts equal instants expressed with different timezone offsets', async () => {
  const { store, request } = await fixture('2026-10-01T02:00:00+02:00', '2026-09-30T19:00:00-05:00');
  const saved = await store.createRevisionRequest(request);
  expect((await store.getRevisionGenerationEvidence(saved.digest)).request).toEqual(saved);
}, 30_000);
