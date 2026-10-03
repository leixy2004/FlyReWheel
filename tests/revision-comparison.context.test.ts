import { expect, it } from 'vitest';
import { deriveRevisionComparison, type RevisionComparisonScorer } from '../src/revision-comparison.js';
import { RevisionComparisonSchema, RevisionDecisionSchema } from '../src/core/revision-comparison.js';
import { digestOf } from '../src/core/identity.js';
import { buildSemanticReview } from '../src/semantic-review.js';
import { acceptedGovernanceEvidence, semanticGovernanceBinding } from '../src/semantic-governance.js';
import { SemanticGovernanceEvidenceSchema } from '../src/core/semantic-governance.js';
import { buildRevisionModelInput, revisionConsumedSourceDigests, validateRevisionGenerationEvidence } from '../src/revision-generation.js';
import { contextComparisonFixture, downstreamContext } from './helpers/context-downstream-fixture.js';

it('binds context-specific comparison and feedback identities without promoting fixture labels to truth', () => {
  const f = contextComparisonFixture(), report = deriveRevisionComparison(f.input, f.graph);
  expect(report).toMatchObject({ scorer: 'per-anchor-context-v4', summary: { status: 'compatible', corrected: 1 },
    trust: { identity: 'caller-declared-unverified', certification: 'none', semanticEvidence: 'offline-fixture-declarations' } });
  expect(report.reviewBindings[0]).toMatchObject({ repositoryContextDigests: [f.context.digest], baseReviewDigest: digestOf(f.baseReview), candidateReviewDigest: digestOf(f.candidateReview) });
  expect(report.feedback[0]).toMatchObject({ repositoryContextDigests: [f.context.digest], source: 'fixture', label: 'FP', outcome: 'corrected' });
  expect(deriveRevisionComparison(f.input, structuredClone(f.graph))).toEqual(report);
  expect(() => RevisionComparisonSchema.parse({ ...report, scorer: 'per-anchor-semantic-v3' })).toThrow('Context comparison scorer');
  const empty = structuredClone(report); delete empty.reviewBindings[0].repositoryContextDigests; delete empty.feedback[0].repositoryContextDigests;
  expect(() => RevisionComparisonSchema.parse(empty)).toThrow('Context comparison scorer');
});
it.each<RevisionComparisonScorer>(['legacy-detector-v1', 'explicit-semantic-v2', 'per-anchor-semantic-v3'])('rejects context reviews under the historical %s scorer', scorer => {
  const f = contextComparisonFixture();
  expect(() => deriveRevisionComparison(f.input, f.graph, scorer)).toThrow('requires the per-anchor-context-v4 scorer');
});
it('rejects unequal context selections even when both exact-head packages are individually valid', () => {
  const f = contextComparisonFixture(), alternative = downstreamContext(f.snapshot, 'src/other-contract.ts');
  const candidate = f.review(f.candidateRule, 'safe', alternative);
  f.graph.pairs[0].candidate = candidate; f.input.reviewPairs[0].candidateReviewId = candidate.id;
  expect(() => deriveRevisionComparison(f.input, f.graph)).toThrow('exact same selected repository context digest set');
});
it('rejects pairing context-enabled review with snapshot-only review', () => {
  const f = contextComparisonFixture(), candidate = buildSemanticReview({ rule: f.candidateRule, snapshot: f.snapshot });
  f.graph.pairs[0].candidate = candidate; f.input.reviewPairs[0].candidateReviewId = candidate.id;
  expect(() => deriveRevisionComparison(f.input, f.graph)).toThrow('exact same selected repository context digest set');
});
it('rejects embedded package substitution before deriving a context comparison', () => {
  const f = contextComparisonFixture();
  f.graph.pairs[0].candidate.repositoryContexts = [downstreamContext(f.snapshot, 'src/other-contract.ts')];
  expect(() => deriveRevisionComparison(f.input, f.graph)).toThrow('exact immutable selected repository context packages');
});
it('retains the context scorer in accepted local governance evidence', () => {
  const f = contextComparisonFixture(), comparison = deriveRevisionComparison(f.input, f.graph), comparisonDigest = digestOf(comparison);
  const decision = RevisionDecisionSchema.parse({ schemaVersion: 1, kind: 'local-rule-revision-decision', id: 'context-decision',
    comparisonDigest, choice: 'accept', actor: 'fixture-author', source: 'fixture', reason: 'Explicit synthetic local choice', createdAt: '2026-10-02T00:00:00Z',
    requestDigest: f.graph.request.digest, candidateRuleDigest: f.candidateRule.digest, comparisonStatus: 'compatible',
    identityVerification: 'caller-declared-unverified', activation: 'not_performed', certification: 'none' });
  const evidence = acceptedGovernanceEvidence({ digest: digestOf(decision), decision }, { digest: comparisonDigest, comparison }, semanticGovernanceBinding(f.candidateRule));
  expect(SemanticGovernanceEvidenceSchema.parse(evidence)).toMatchObject({ scorer: 'per-anchor-context-v4', certification: 'none', decisionSource: 'fixture' });
});
it('prepares explicit v3 context generation but never silently downcasts into historical contracts', () => {
  const f = contextComparisonFixture(), graph = { ...f.graph, snapshots: [f.snapshot] };
  expect(validateRevisionGenerationEvidence(graph).feedback[0].review.repositoryContexts).toEqual([f.context]);
  expect(revisionConsumedSourceDigests(graph)).toContain(f.evidence.anchor.sourceDigest);
  const input = { ...graph, candidateId: 'candidate', candidateCreatedAt: '2026-10-02T00:00:00Z',
    context: { kind: 'selected-evidence-no-tools' as const, snapshotDigest: f.snapshot.digest, workspace: { repoPath: '/unused', runId: 'unused', attemptId: 'unused' } } };
  expect(buildRevisionModelInput(input, { model: 'not-run' }).outputContract).toBe('rule-revision-v3');
  for (const contract of ['rule-revision-v1', 'rule-revision-v2'] as const) {
    expect(() => buildRevisionModelInput(input, { model: 'not-run' }, contract)).toThrow('UNSUPPORTED_REVISION_CONTEXT');
  }
});

it.each(['missing-context', 'omitted-anchor'])('keeps context evidence from laundering %s into a safe feedback result', mode => {
  const f = contextComparisonFixture(), fixtures = structuredClone(f.candidateReview.fixtures!);
  if (fixtures.schemaVersion !== 3) throw new Error('Expected context-aware fixture');
  if (mode === 'missing-context') fixtures.judgments[0].anchorJudgments[0].missingContext = ['The contract application remains unresolved'];
  else fixtures.judgments[0].anchorJudgments = [];
  const candidate = buildSemanticReview({ rule: f.candidateRule, snapshot: f.snapshot, fixtures, repositoryContexts: [f.context] });
  f.graph.pairs[0].candidate = candidate; f.input.reviewPairs[0].candidateReviewId = candidate.id;
  const report = deriveRevisionComparison(f.input, f.graph);
  expect(report.feedback[0]).toMatchObject({ candidate: { state: mode === 'missing-context' ? 'unknown' : 'unscored' }, outcome: 'inconclusive' });
  expect(report.summary.status).toBe('inconclusive');
});
