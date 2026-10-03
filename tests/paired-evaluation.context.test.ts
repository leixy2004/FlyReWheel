import { expect, it } from 'vitest';
import { createPairedEvaluationDemo } from '../src/paired-evaluation-demo.js';
import { evaluatePairedReviews } from '../src/paired-evaluation.js';
import { buildSemanticReview } from '../src/semantic-review.js';
import { digestOf } from '../src/core/identity.js';
import { makeReviewEvidence } from '../src/adapters/semantic-review-fixture.js';
import { type ContextReviewFixture } from '../src/core/semantic-review.js';
import { downstreamContext, downstreamContextEvidence } from './helpers/context-downstream-fixture.js';

type Demo = ReturnType<typeof createPairedEvaluationDemo>;
function addContext(demo: Demo, armIndex: number, path = 'src/unchanged-contract.ts') {
  const unit = demo.runs.arms[armIndex].units[0], old = unit.review!.value.fixtures!;
  if (old.schemaVersion !== 2) throw new Error('Expected per-anchor source fixture');
  const context = downstreamContext(demo.dataset.prs[0].snapshot, path), evidence = downstreamContextEvidence(context, 'synthetic-oracle-context');
  const sourceEvidence = old.evidence.map(item => makeReviewEvidence(demo.dataset.prs[0].snapshot, item.anchor, 'changed-source'));
  const refs = [...sourceEvidence.map(item => item.id), evidence.id];
  const fixtures: ContextReviewFixture = { ...old, schemaVersion: 3, repositoryContextDigests: [context.digest], evidence: [...sourceEvidence, evidence],
    judgments: old.judgments.map(judgment => ({ ...judgment, evidenceRefs: refs,
      anchorJudgments: judgment.anchorJudgments.map(anchor => ({ ...anchor, evidenceRefs: refs })) })) };
  const value = buildSemanticReview({ rule: unit.rule, snapshot: demo.dataset.prs[0].snapshot, fixtures, repositoryContexts: [context], attempt: unit.review!.value.config.attempt });
  unit.review = { digest: digestOf(value), value };
  return context;
}
const score = (demo: Demo) => evaluatePairedReviews(demo.dataset, demo.annotations, demo.runs);
it('rederives the snapshot-only paired report byte-identically', () => {
  const report = score(createPairedEvaluationDemo());
  expect(report.scorer).toBe('exact-anchor-issue-paired-v1');
  expect(report.digest).toBe('b4ef714a908c1fca5cd43ef3ea0d60158a688cd0e452223df7ed7415dcd81f5f');
  expect('repositoryContextDigests' in report.arms[0].units[0]).toBe(false);
});
it('propagates exact frozen context sets while keeping the same labels, counts and unverified truth boundary', () => {
  const demo = createPairedEvaluationDemo(), old = score(demo), context = addContext(demo, 0); addContext(demo, 1);
  const report = score(demo);
  expect(report.scorer).toBe('exact-anchor-context-issue-paired-v2');
  expect(report.arms.map(arm => arm.counts)).toEqual(old.arms.map(arm => arm.counts));
  for (const arm of report.arms) {
    expect(arm.units[0].repositoryContextDigests).toEqual([context.digest]);
    expect(arm.units[1].repositoryContextDigests).toEqual([]);
  }
  expect(report.comparisons).toEqual(old.comparisons);
  expect(report.inputBindings.annotations).toEqual(old.inputBindings.annotations);
  expect(report.sourceAttestation).toBe('package-integrity-and-local-declarations-only');
  expect(report.auditWarnings.join(' ')).toContain('does not establish historical availability');
  expect(score(structuredClone(demo))).toEqual(report);
});
it.each([false, true])('blocks paired deltas for unequal selected context sets, alternative-context=%s', alternative => {
  const demo = createPairedEvaluationDemo(); addContext(demo, 0);
  if (alternative) addContext(demo, 1, 'src/other-contract.ts');
  expect(score(demo).comparisons[0]).toMatchObject({ status: 'incomparable', deltas: null, transitions: null,
    reasons: ['Mismatched selected repository context: pr-1/call-family'] });
});
it('binds selected contexts for failed/not-run units and refuses unfair comparisons', () => {
  const demo = createPairedEvaluationDemo(), context = addContext(demo, 0); addContext(demo, 1);
  demo.runs.arms[0].units[1].repositoryContextDigests = [context.digest];
  expect(score(demo).comparisons[0]).toMatchObject({ status: 'incomparable', deltas: null, reasons: ['Mismatched selected repository context: pr-2/call-family'] });
});
it('rejects a unit declaration that differs from its embedded review', () => {
  const demo = createPairedEvaluationDemo(); addContext(demo, 0); addContext(demo, 1);
  demo.runs.arms[0].units[0].repositoryContextDigests = ['f'.repeat(64)];
  expect(() => score(demo)).toThrow('repository context selection contradicts its frozen review');
});
it('revalidates embedded context bytes even after the caller updates the frozen review digest', () => {
  const demo = createPairedEvaluationDemo(); addContext(demo, 0); addContext(demo, 1);
  const review = demo.runs.arms[0].units[0].review!, context = review.value.repositoryContexts![0];
  const entry = context.context.entries[0];
  if (entry.state !== 'captured') throw new Error('Expected captured fixture');
  entry.bytesBase64 = Buffer.from('tampered').toString('base64'); review.digest = digestOf(review.value);
  expect(() => score(demo)).toThrow();
});
it('rejects empty, duplicate and unsorted selected digest declarations', () => {
  for (const selection of [[], ['a'.repeat(64), 'a'.repeat(64)], ['f'.repeat(64), 'a'.repeat(64)]]) {
    const demo = createPairedEvaluationDemo(); demo.runs.arms[0].units[1].repositoryContextDigests = selection;
    expect(() => score(demo)).toThrow();
  }
});
