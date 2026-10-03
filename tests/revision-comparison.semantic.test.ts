import { afterEach, describe, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { RevisionDecisionSchema } from '../src/core/revision-comparison.js';
import { deriveRevisionComparison } from '../src/revision-comparison.js';
import { QualEvoStore } from '../src/storage/store.js';
import { defaultComparisonCases, revisionComparisonFixture, revisionDecision, type ComparisonFixtureOptions } from './helpers/revision-comparison-fixture.js';

let store: QualEvoStore | undefined;
afterEach(async () => { await store?.close(); store = undefined; });
async function fixture(options: ComparisonFixtureOptions = {}) {
  const f = await revisionComparisonFixture(options); store = f.store; return f;
}
const zero = { id: 'zero', detector: { kind: 'ast-grep' as const, language: 'typescript', pattern: 'neverCalled($ARG)' } };

describe('explicit semantic comparison without detector hits', () => {
  it.each([
    { name: 'detectorless candidate', candidateAssets: [] },
    { name: 'detectorless base and candidate', baseAssets: [], candidateAssets: [] },
    { name: 'zero-hit candidate', candidateAssets: [zero] },
    { name: 'zero-hit base and candidate', baseAssets: [zero], candidateAssets: [zero] },
  ])('scores $name only from validated target and anchor judgments', async options => {
    const f = await fixture(options);
    expect(f.candidateReview.occurrences).toEqual([]);
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison).toMatchObject({ scorer: 'per-anchor-semantic-v3', summary: { status: 'compatible', preserved: 1, corrected: 2, inconclusive: 0 } });
    expect(result.comparison.feedback[0]).toMatchObject({ candidate: { state: 'safe', reason: 'explicit_semantic_judgment' }, outcome: 'corrected' });
    expect(await f.store.getRevisionComparison(result.digest)).toEqual(result);
    expect((await f.store.recordRevisionDecision(revisionDecision(result.digest))).decision.activation).toBe('not_performed');
  }, 30_000);

  it.each([
    { candidateAssets: [], candidateJudgment: 'not_run' as const, state: 'unscored', reason: 'no_assets' },
    { candidateAssets: [zero], candidateJudgment: 'not_run' as const, state: 'unscored', reason: 'zero_hits' },
    { candidateAssets: [], candidateJudgment: 'unknown' as const, state: 'unknown', reason: 'semantic_unknown' },
    { candidateAssets: [zero], candidateJudgment: 'unknown' as const, state: 'unknown', reason: 'semantic_unknown' },
  ])('never calls absent/unknown semantic evidence safe: $candidateJudgment/$reason', async options => {
    const f = await fixture({ candidateAssets: options.candidateAssets,
      cases: defaultComparisonCases.map(value => ({ ...value, candidateJudgment: options.candidateJudgment })) });
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.cases.every(value => value.candidate.state === options.state && value.candidate.reason === options.reason && value.outcome === 'inconclusive')).toBe(true);
    expect(result.comparison.feedback[0].candidate).toEqual({ state: options.state, reason: options.reason });
    await expect(f.store.recordRevisionDecision(revisionDecision(result.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  }, 30_000);

  it.each(['unknown', 'not_run'] as const)('requires known baseline semantics even when the detectorless candidate is correct: %s', async baseJudgment => {
    const f = await fixture({ baseAssets: [], candidateAssets: [], cases: defaultComparisonCases.map(value => value.expected === 'violation' ? { ...value, baseJudgment } : value) });
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.cases.find(value => value.caseId === 'positive-case')).toMatchObject({ candidate: { state: 'violation' }, outcome: 'inconclusive' });
    expect(result.comparison.feedback[0].outcome).toBe('corrected');
    expect(result.comparison.summary.status).toBe('inconclusive');
  }, 30_000);

  it('does not let removing both a detector and a declared positive evade the old positive', async () => {
    const f = await fixture({ candidateAssets: [], cases: defaultComparisonCases.map(value => value.expected === 'violation'
      ? { ...value, candidateRole: null, candidateJudgment: 'safe' } : value) });
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.cases[0]).toMatchObject({ baseRole: 'positive', candidateRole: null, candidate: { state: 'safe' }, outcome: 'regressed' });
    expect(result.comparison.summary.status).toBe('regressed');
    await expect(f.store.recordRevisionDecision(revisionDecision(result.digest))).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  }, 30_000);

  it('keeps detectorless decisions unknown when required context is absent', async () => {
    const f = await fixture({ candidateAssets: [], cases: defaultComparisonCases.map(value => ({ ...value, contextKind: 'unrelated-context' })) });
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.cases.every(value => value.candidate.state === 'unknown' && value.outcome === 'inconclusive')).toBe(true);
    expect(result.comparison.feedback[0].candidate).toEqual({ state: 'unknown', reason: 'semantic_unknown' });
  }, 30_000);
});

describe('feedback safety requires an explicit exact-anchor claim', () => {
  it.each([[], [zero], undefined])('does not turn a target-only safe judgment or its exact evidence citation into anchor safety (%j)', async candidateAssets => {
    const f = await fixture({ candidateAssets, cases: [{ ...defaultComparisonCases[1], candidateTargetOnlySafe: true }] });
    const judgment = f.candidateReview.fixtures!.judgments[0];
    if (!('findingAnchors' in judgment)) throw new Error('Expected legacy fixture judgment');
    expect(judgment.findingAnchors).toEqual([]);
    expect(f.candidateReview.fixtures!.evidence[0].anchor).toEqual(f.finding.anchor);
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.cases[0]).toMatchObject({ candidate: { state: 'safe' }, outcome: 'corrected' });
    expect(result.comparison.feedback[0]).toMatchObject({ candidate: { state: 'unscored', reason: 'anchor_unscored' }, outcome: 'inconclusive' });
    expect(result.comparison.summary.status).toBe('inconclusive');
  }, 30_000);

  it('does not treat an explicitly safe different span in the same file as fixing the selected FP', async () => {
    const f = await fixture({ candidateAssets: [], cases: [{ ...defaultComparisonCases[1], candidateAnchorIndex: 1 }] });
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.cases[0].outcome).toBe('corrected');
    expect(result.comparison.feedback[0]).toMatchObject({ candidate: { state: 'unscored', reason: 'anchor_unscored' }, outcome: 'inconclusive' });
  }, 30_000);

  it('does not score an inherited legacy baseline safe finding as an explicit anchor judgment', async () => {
    const f = await fixture({ cases: [{ ...defaultComparisonCases[1], baseJudgment: 'safe', baseTargetOnlySafe: true }] });
    expect(f.finding.status).toBe('safe');
    const result = await f.store.createRevisionComparison(f.input);
    expect(result.comparison.feedback[0]).toMatchObject({ base: { state: 'unscored', reason: 'anchor_unscored' }, candidate: { state: 'safe' }, outcome: 'inconclusive' });
  }, 30_000);
});

it('rederives legacy reports/decisions unchanged, but requires current scoring for a new accept', async () => {
  const f = await fixture({ cases: [{ ...defaultComparisonCases[1], candidateTargetOnlySafe: true }] });
  const legacy = deriveRevisionComparison(f.input, { request: f.request, baseRule: f.baseRule, candidateRule: f.candidateRule, cases: f.cases,
    pairs: [{ base: f.baseReview, candidate: f.candidateReview, snapshot: f.snapshot }],
    feedback: [{ feedback: f.feedback, finding: f.finding, review: f.baseReview }] }, 'legacy-detector-v1');
  expect(legacy.scorer).toBeUndefined(); expect(legacy.summary.status).toBe('compatible');
  const digest = digestOf(legacy);
  await f.database.query('INSERT INTO qe_rule_revision_comparisons(digest,id,request_digest,candidate_rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
    [digest, f.input.id, f.request.digest, f.candidateRule.digest, JSON.stringify(legacy)]);
  const input = revisionDecision(digest);
  const decision = RevisionDecisionSchema.parse({ ...input, schemaVersion: 1, kind: 'local-rule-revision-decision',
    requestDigest: f.request.digest, candidateRuleDigest: f.candidateRule.digest, comparisonStatus: 'compatible',
    identityVerification: 'caller-declared-unverified', activation: 'not_performed', certification: 'none' });
  const decisionDigest = digestOf(decision);
  await f.database.query('INSERT INTO qe_rule_revision_decisions(digest,id,comparison_digest,payload) VALUES($1,$2,$3,$4::jsonb)',
    [decisionDigest, decision.id, digest, JSON.stringify(decision)]);
  expect(await f.store.getRevisionComparison(digest)).toEqual({ digest, comparison: legacy });
  expect(await f.store.createRevisionComparison(f.input)).toEqual({ digest, comparison: legacy });
  expect(await f.store.getRevisionDecision(decisionDigest)).toEqual({ digest: decisionDigest, decision });
  expect(await f.store.recordRevisionDecision(input)).toEqual({ digest: decisionDigest, decision });
  await expect(f.store.recordRevisionDecision({ ...input, id: 'new-legacy-accept' })).rejects.toMatchObject({ code: 'REVISION_ACCEPT_BLOCKED' });
  expect((await f.store.recordRevisionDecision({ ...input, id: 'legacy-defer', choice: 'defer' })).decision.choice).toBe('defer');
  const current = await f.store.createRevisionComparison({ ...f.input, id: 'current-scoring-comparison' });
  expect(current.comparison).toMatchObject({ scorer: 'per-anchor-semantic-v3', summary: { status: 'inconclusive' } });
  expect(await f.store.listRevisionComparisons()).toHaveLength(2);
}, 30_000);
