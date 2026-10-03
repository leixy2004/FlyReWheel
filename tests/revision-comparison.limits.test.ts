import { afterAll, beforeAll, expect, it } from 'vitest';
import { comparisonInputBudget, deriveRevisionComparison, type RevisionComparisonContext } from '../src/revision-comparison.js';
import { COMPARISON_LIMITS } from '../src/core/revision-comparison.js';
import { revisionComparisonFixture } from './helpers/revision-comparison-fixture.js';

let fixture: Awaited<ReturnType<typeof revisionComparisonFixture>>;
let context: RevisionComparisonContext;
beforeAll(async () => {
  fixture = await revisionComparisonFixture();
  context = { request: fixture.request, baseRule: fixture.baseRule, candidateRule: fixture.candidateRule,
    cases: fixture.cases, feedback: [{ feedback: fixture.feedback, finding: fixture.finding, review: fixture.baseReview }],
    pairs: [{ base: fixture.baseReview, candidate: fixture.candidateReview, snapshot: fixture.snapshot }] };
}, 30_000);
afterAll(async () => { await fixture?.store.close(); });

it('counts cumulative UTF-8 encoded bytes rather than records or JavaScript character counts', () => {
  const count = comparisonInputBudget();
  const input = '🙂'.repeat(999_999); // 3,999,996 UTF-8 bytes plus two JSON quotes.
  for (let i = 0; i < 4; i++) expect(() => count(input)).not.toThrow();
  expect(() => count('1234567')).toThrow('Aggregate comparison input graph');
  const exact = comparisonInputBudget();
  expect(() => exact('x'.repeat(COMPARISON_LIMITS.inputBytes - 2))).not.toThrow();
  expect(() => exact(null)).toThrow('Aggregate comparison input graph');
});

it('bounds the combined resolved case set and requires every declared source/regression case', () => {
  const cases = Array.from({ length: 201 }, (_, index) => ({ ...fixture.cases[0], id: `extra-${index}` }));
  expect(() => deriveRevisionComparison(fixture.input, { ...context, cases })).toThrow('source/regression cases must be unique and bounded');
  expect(() => deriveRevisionComparison(fixture.input, { ...context, cases: fixture.cases.slice(0, 1) })).toThrow('Missing declared problem case');
});

it.each(['execution_error', 'budget_exceeded'] as const)('never scores %s scan coverage as a correction', state => {
  const changed = structuredClone(context);
  const target = changed.pairs[0].candidate.coverage.targets.find(value => value.path.endsWith('safe-case.ts'))!;
  target.scans[0] = { ...target.scans[0], state, candidateCount: null, reason: 'Deliberately incomplete pure comparison fixture' };
  // The pure deriver receives validated reviews in production. Its additional coverage gate remains conservative.
  const report = deriveRevisionComparison(fixture.input, changed);
  expect(report.summary.status).toBe('inconclusive');
  expect(report.cases.find(value => value.caseId === 'safe-case')).toMatchObject({ candidate: { state: 'unscored', reason: 'incomplete_scans' }, outcome: 'inconclusive' });
  expect(report.feedback[0]).toMatchObject({ candidate: { state: 'unscored', reason: 'incomplete_scans' }, outcome: 'inconclusive' });
});

it('rejects an oversized derived result rather than persisting a partial report', () => {
  const changed = structuredClone(context);
  // Regression-only metadata can be large even when a missing case binding remains explicitly unscored.
  changed.cases.find(value => value.id === 'safe-case')!.repository = 'x'.repeat(COMPARISON_LIMITS.resultBytes);
  const input = { ...fixture.input, caseBindings: fixture.input.caseBindings.filter(value => value.caseId !== 'safe-case') };
  expect(() => deriveRevisionComparison(input, changed)).toThrow('Comparison exceeds bounded result bytes');
});
