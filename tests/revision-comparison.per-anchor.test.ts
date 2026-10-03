import { afterEach, describe, expect, it } from 'vitest';
import { makeReviewEvidence, makeSnapshotAnchor } from '../src/adapters/semantic-review-fixture.js';
import { digestOf } from '../src/core/identity.js';
import { RevisionDecisionSchema } from '../src/core/revision-comparison.js';
import { reviewTargetId, type AnchorReviewFixture, type LegacyReviewFixture } from '../src/core/semantic-review.js';
import { deriveRevisionComparison } from '../src/revision-comparison.js';
import type { QualEvoStore } from '../src/storage/store.js';
import { comparisonDate, defaultComparisonCases, revisionComparisonFixture, revisionDecision } from './helpers/revision-comparison-fixture.js';

let store: QualEvoStore | undefined;
afterEach(async () => { await store?.close(); store = undefined; });

type MixedOptions = {
  baseContract?: 'legacy' | 'anchors'; targetDecision?: 'violation' | 'unknown';
  targetMissingContext?: string[]; safeMissingContext?: string[]; safeEvidenceKind?: string;
  omitSafeAnchor?: boolean; shiftSafeAnchor?: boolean; safeDecision?: 'safe' | 'unknown'; candidateLegacy?: boolean; dropPositive?: boolean;
};
async function mixedFixture(options: MixedOptions = {}) {
  const f = await revisionComparisonFixture({ baseAssets: [], candidateAssets: [], cases: [{ ...defaultComparisonCases[0],
    ...(options.dropPositive ? { candidateRole: null } : {}) }] });
  store = f.store;
  const source = f.sources[0], problemCase = f.cases[0];
  const anchors = [...source.source.matchAll(/danger\([^)]*\)/g)].map(match => makeSnapshotAnchor(f.snapshot, 'after', source.path, match.index!, match.index! + match[0].length));
  const candidateSafeAnchor = options.shiftSafeAnchor
    ? makeSnapshotAnchor(f.snapshot, 'after', source.path, anchors[1].span.start.offset + 1, anchors[1].span.end.offset) : anchors[1];
  const baseEvidence = anchors.map(anchor => makeReviewEvidence(f.snapshot, anchor, 'fixture-context'));
  const candidateEvidence = anchors.map((anchor, index) => makeReviewEvidence(f.snapshot, anchor, index === 1 ? options.safeEvidenceKind ?? 'fixture-context' : 'fixture-context'));
  const baseTargetId = reviewTargetId(f.baseRule.digest, f.snapshot.digest, 0, source.path, problemCase.sourceDigest);
  const candidateTargetId = reviewTargetId(f.candidateRule.digest, f.snapshot.digest, 0, source.path, problemCase.sourceDigest);
  const baseCommon = { kind: 'semantic-review-offline-fixtures' as const, ruleDigest: f.baseRule.digest, snapshotDigest: f.snapshot.digest, evidence: baseEvidence };
  const baseFixtures: LegacyReviewFixture | AnchorReviewFixture = options.baseContract === 'anchors'
    ? { ...baseCommon, schemaVersion: 2, judgments: [{ targetId: baseTargetId, decision: 'violation', reasoning: 'Two independently adjudicated violations', evidenceRefs: baseEvidence.map(item => item.id), missingContext: [],
      anchorJudgments: anchors.map((anchor, index) => ({ anchor, decision: 'violation', reasoning: 'Explicit baseline violation', evidenceRefs: [baseEvidence[index].id], missingContext: [] })) }] }
    : { ...baseCommon, schemaVersion: 1, judgments: [{ targetId: baseTargetId, decision: 'violation', reasoning: 'Two explicitly adjudicated legacy violations', evidenceRefs: baseEvidence.map(item => item.id), findingAnchors: anchors }] };
  const baseReview = await f.store.runSemanticReview({ ruleDigest: f.baseRule.digest, snapshotDigest: f.snapshot.digest, fixtures: baseFixtures });
  const candidateCommon = { kind: 'semantic-review-offline-fixtures' as const, ruleDigest: f.candidateRule.digest, snapshotDigest: f.snapshot.digest, evidence: candidateEvidence };
  const candidateFixtures: AnchorReviewFixture | LegacyReviewFixture = options.candidateLegacy
    ? { ...candidateCommon, schemaVersion: 1, judgments: [{ targetId: candidateTargetId, decision: 'violation', reasoning: 'Legacy target and both anchors remain violations', evidenceRefs: candidateEvidence.map(item => item.id), findingAnchors: anchors }] }
    : { ...candidateCommon, schemaVersion: 2, judgments: [{ targetId: candidateTargetId, decision: options.targetDecision ?? 'violation', reasoning: 'Target-level judgment is independent of exact anchor outcomes', evidenceRefs: candidateEvidence.map(item => item.id), missingContext: options.targetMissingContext ?? [],
      anchorJudgments: [
        { anchor: anchors[0], decision: 'violation', reasoning: 'The positive call still violates the rule', evidenceRefs: [candidateEvidence[0].id], missingContext: [] },
        ...(options.omitSafeAnchor ? [] : [{ anchor: candidateSafeAnchor, decision: options.safeDecision ?? 'safe', reasoning: 'This exact second call has a separate adjudication', evidenceRefs: [candidateEvidence[1].id], missingContext: options.safeMissingContext ?? [] }]),
      ] }] };
  const candidateReview = await f.store.runSemanticReview({ ruleDigest: f.candidateRule.digest, snapshotDigest: f.snapshot.digest, fixtures: candidateFixtures });
  const feedback = await Promise.all(anchors.map(async (anchor, index) => {
    const finding = baseReview.findings.find(item => digestOf(item.anchor) === digestOf(anchor))!;
    return f.store.appendReviewFeedback({ id: `mixed-feedback-${index}`, findingId: finding.id, reviewId: baseReview.id, ruleDigest: f.baseRule.digest, ruleVersion: f.baseInput.version,
      source: 'fixture', actor: 'fixture-author', kind: 'label', label: index === 0 ? 'TP' : 'FP', reason: 'Exact selected same-file anchor', createdAt: comparisonDate });
  }));
  const request = await f.store.createRevisionRequest({ id: 'mixed-revision-request', baseRuleDigest: f.baseRule.digest, requestedRuleVersion: f.candidateInput.version,
    feedbackIds: feedback.map(item => item.id), requestedChange: 'Preserve the same-file TP and correct its distinct FP anchor', actor: 'fixture-author', source: 'fixture', createdAt: comparisonDate });
  const input = { id: 'mixed-revision-comparison', requestDigest: request.digest, candidateRuleDigest: f.candidateRule.digest,
    reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: candidateReview.id }], caseBindings: [{ caseId: problemCase.id, baseReviewId: baseReview.id }] };
  return { ...f, anchors, baseReview, candidateReview, feedback, request, input };
}

describe('per-anchor comparison across immutable review contracts', () => {
  it.each(['legacy', 'anchors'] as const)('preserves a TP and corrects an FP in one file from a %s baseline', async baseContract => {
    const f = await mixedFixture({ baseContract });
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison).toMatchObject({ scorer: 'per-anchor-semantic-v3', summary: { status: 'compatible', preserved: 2, corrected: 1, regressed: 0, inconclusive: 0 } });
    expect(result.comparison.cases[0]).toMatchObject({ candidate: { state: 'violation' }, outcome: 'preserved' });
    expect(result.comparison.feedback.map(row => [row.anchor.path, row.candidate.state, row.outcome])).toEqual([
      [f.anchors[0].path, 'violation', 'preserved'], [f.anchors[1].path, 'safe', 'corrected'],
    ]);
    expect(f.baseReview.findings[0].targetId).not.toBe(f.candidateReview.findings[0].targetId);
    expect(await f.store.getRevisionComparison(result.digest)).toEqual(result);
    expect(await f.store.createRevisionComparison(f.input)).toEqual(result);
    expect((await f.store.recordRevisionDecision(revisionDecision(result.digest))).decision.choice).toBe('accept');
  }, 30_000);

  it('uses explicit legacy anchors on a candidate paired with a new-contract baseline', async () => {
    const f = await mixedFixture({ baseContract: 'anchors', candidateLegacy: true });
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.feedback.map(row => [row.candidate.state, row.outcome])).toEqual([['violation', 'preserved'], ['violation', 'still_failing']]);
    expect(result.comparison.summary.status).toBe('regressed');
  }, 30_000);

  it.each([
    { targetDecision: 'unknown' as const },
    { targetMissingContext: ['Unresolved file-level control flow'] },
  ])('retains independently known anchors when the target is incomplete: %j', async options => {
    const f = await mixedFixture(options);
    const result = await f.store.createRevisionComparison(f.input);
    expect(f.candidateReview.coverage.targets[0].semantic.state).toBe('unknown');
    expect(result.comparison.cases[0]).toMatchObject({ candidate: { state: 'unknown', reason: 'semantic_unknown' }, outcome: 'inconclusive' });
    expect(result.comparison.feedback.map(row => [row.candidate.state, row.outcome])).toEqual([['violation', 'preserved'], ['safe', 'corrected']]);
    expect(result.comparison.summary.status).toBe('inconclusive');
    await expect(f.store.recordRevisionDecision(revisionDecision(result.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  }, 30_000);

  it.each([
    { safeMissingContext: ['The second call guard cannot be established'] },
    { safeEvidenceKind: 'unrelated-context' },
    { safeDecision: 'unknown' as const },
  ])('preserves per-anchor uncertainty without losing the known violation: %j', async options => {
    const f = await mixedFixture(options);
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.feedback[0]).toMatchObject({ candidate: { state: 'violation' }, outcome: 'preserved' });
    expect(result.comparison.feedback[1]).toMatchObject({ candidate: { state: 'unknown', reason: 'semantic_unknown' }, outcome: 'inconclusive' });
    expect(result.comparison.summary.status).toBe('inconclusive');
  }, 30_000);

  it('does not treat an exact evidence citation or another anchor as an adjudication', async () => {
    const f = await mixedFixture({ omitSafeAnchor: true, targetDecision: 'unknown' });
    expect(f.candidateReview.fixtures!.evidence.some(item => digestOf(item.anchor) === digestOf(f.anchors[1]))).toBe(true);
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.feedback[1]).toMatchObject({ candidate: { state: 'unscored', reason: 'anchor_unscored' }, outcome: 'inconclusive' });
  }, 30_000);

  it('does not substitute a valid shifted, overlapping safe span for the exact selected FP anchor', async () => {
    const f = await mixedFixture({ shiftSafeAnchor: true });
    const shifted = f.candidateReview.findings.find(item => item.status === 'safe')!.anchor;
    expect(shifted.path).toBe(f.anchors[1].path);
    expect(shifted.span.start.offset).toBe(f.anchors[1].span.start.offset + 1);
    expect(shifted.span.end.offset).toBe(f.anchors[1].span.end.offset);
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.feedback[0]).toMatchObject({ candidate: { state: 'violation' }, outcome: 'preserved' });
    expect(result.comparison.feedback[1]).toMatchObject({ anchor: f.anchors[1], candidate: { state: 'unscored', reason: 'anchor_unscored' }, outcome: 'inconclusive' });
  }, 30_000);

  it('never inherits a new-contract target-only safe decision at a structural or cited anchor', async () => {
    const f = await revisionComparisonFixture({ cases: [defaultComparisonCases[1]] }); store = f.store;
    const legacy = f.fixtures(f.candidateRule, 'candidate');
    const fixtures: AnchorReviewFixture = { ...legacy, schemaVersion: 2,
      judgments: legacy.judgments.map(({ findingAnchors, ...judgment }) => ({ ...judgment, missingContext: [], anchorJudgments: [] })) };
    const candidate = await f.store.runSemanticReview({ ruleDigest: f.candidateRule.digest, snapshotDigest: f.snapshot.digest, fixtures });
    expect(candidate.coverage.targets[0].semantic.state).toBe('safe');
    expect(candidate.findings.every(item => item.status === 'not_verified')).toBe(true);
    const result = await f.store.createRevisionComparison({ ...f.input, reviewPairs: [{ baseReviewId: f.baseReview.id, candidateReviewId: candidate.id }] });
    expect(result.comparison.cases[0]).toMatchObject({ candidate: { state: 'safe' }, outcome: 'corrected' });
    expect(result.comparison.feedback[0]).toMatchObject({ candidate: { state: 'unscored', reason: 'anchor_unscored' }, outcome: 'inconclusive' });
  }, 30_000);

  it('retains a dropped positive regression alongside the corrected same-file FP', async () => {
    const f = await mixedFixture({ dropPositive: true });
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.cases[0]).toMatchObject({ caseId: 'positive-case', baseRole: 'positive', candidateRole: null, outcome: 'preserved' });
    expect(result.comparison.feedback[1].outcome).toBe('corrected');
  }, 30_000);
});

it.each([
  { scorer: 'legacy-detector-v1' as const, digest: '7cd141c62e0dae7c79f7b9efc765cf6e2a8103f480fdfb1898356c3c314f819f' },
  { scorer: 'explicit-semantic-v2' as const, digest: '866e7d928e6a2d1c1081ed3d3c8fb8f5f80326575261b80fff1cbc0846f020d1' },
])('preserves $scorer hashes and historical acceptance but blocks a new acceptance', async expected => {
  const f = await revisionComparisonFixture(); store = f.store;
  const comparison = deriveRevisionComparison(f.input, { request: f.request, baseRule: f.baseRule, candidateRule: f.candidateRule, cases: f.cases,
    pairs: [{ base: f.baseReview, candidate: f.candidateReview, snapshot: f.snapshot }], feedback: [{ feedback: f.feedback, finding: f.finding, review: f.baseReview }] }, expected.scorer);
  expect(digestOf(comparison)).toBe(expected.digest);
  const originalBytes = JSON.stringify(comparison);
  await f.database.query('INSERT INTO qe_rule_revision_comparisons(digest,id,request_digest,candidate_rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
    [expected.digest, f.input.id, f.request.digest, f.candidateRule.digest, originalBytes]);
  const input = revisionDecision(expected.digest);
  const decision = RevisionDecisionSchema.parse({ ...input, schemaVersion: 1, kind: 'local-rule-revision-decision', requestDigest: f.request.digest,
    candidateRuleDigest: f.candidateRule.digest, comparisonStatus: 'compatible', identityVerification: 'caller-declared-unverified', activation: 'not_performed', certification: 'none' });
  const digest = digestOf(decision);
  await f.database.query('INSERT INTO qe_rule_revision_decisions(digest,id,comparison_digest,payload) VALUES($1,$2,$3,$4::jsonb)', [digest, decision.id, expected.digest, JSON.stringify(decision)]);
  expect(await f.store.getRevisionComparison(expected.digest)).toEqual({ digest: expected.digest, comparison });
  expect(JSON.stringify((await f.store.createRevisionComparison(f.input)).comparison)).toBe(originalBytes);
  expect(await f.store.getRevisionDecision(digest)).toEqual({ digest, decision });
  expect(await f.store.recordRevisionDecision(input)).toEqual({ digest, decision });
  await expect(f.store.recordRevisionDecision({ ...input, id: 'new-historical-accept' })).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  expect((await f.store.recordRevisionDecision({ ...input, id: 'historical-reject', choice: 'reject' })).decision.choice).toBe('reject');
  expect((await f.store.recordRevisionDecision({ ...input, id: 'historical-defer', choice: 'defer' })).decision.choice).toBe('defer');
  const current = await f.store.createRevisionComparison({ ...f.input, id: 'current-anchor-scoring' });
  expect(current.comparison).toMatchObject({ scorer: 'per-anchor-semantic-v3', summary: { status: 'compatible' } });
  expect(current.digest).not.toBe(expected.digest);
  expect((await f.store.recordRevisionDecision(revisionDecision(current.digest, { id: 'current-accept' }))).decision.choice).toBe('accept');
  expect(JSON.stringify((await f.store.getRevisionComparison(expected.digest)).comparison)).toBe(originalBytes);
}, 30_000);
