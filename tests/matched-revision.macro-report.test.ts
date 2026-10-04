import { describe, it, expect } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { createMatchedFixture } from '../experiments/matched-revision/fixture.js';
import { runMatchedRevision } from '../experiments/matched-revision/runner.js';
import { macroHierarchy, boundedRepositoryDifference, aggregateMatchedResults } from '../experiments/matched-revision/macro-report.js';
const row = (repository: string, family: string, episode: string, repetition: number, value: number | null) => ({ repository, family, episode, repetition, value });
async function fixture() {
  const f = createMatchedFixture(); const r = await runMatchedRevision({ ...f, mode: 'authored_fixture' });
  if (r.execution !== 'completed') throw Error('Expected fixture report');
  return { ...f, report: r, repetition: 1 };
}
const rehash = (r: { digest: string }) => { const { digest, ...body } = r; r.digest = digestOf(body); };
describe('paired repository/family macro reporting', () => {
  it('matches independently worked hierarchical fractions, not pooled findings', () => {
    expect(macroHierarchy([row('R', 'A', 'a', 1, .9), row('R', 'B', 'b', 1, 0)]).value).toBe(.45);
    expect(macroHierarchy([row('A', 'f1', 'a', 1, 1), row('A', 'f2', 'b', 1, 0), row('B', 'f1', 'c', 1, 1)]).value).toBe(.75);
    const h = macroHierarchy([row('R', 'A', 'a', 1, -1), row('R', 'A', 'a', 2, 0), row('R', 'A', 'b', 1, 1), row('R', 'B', 'c', 1, -.5)]);
    expect(h.value).toBe(-.125); expect(h.repositories[0].families[0].value).toBe(.25);
  });
  it('propagates missing denominators while retaining complete-case coverage at each level', () => {
    const h = macroHierarchy([row('R', 'A', 'a', 1, 1), row('R', 'B', 'b', 1, null)]);
    expect(h.value).toBeNull(); expect(h.repositories[0]).toMatchObject({ value: null, planned: 2, estimable: 1, completeCaseDescriptive: 1 });
    expect(() => macroHierarchy([row('R', 'A', 'a', 1, 0), row('R', 'A', 'a', 1, 1)])).toThrow('duplicate');
  });
  it('matches independent Decimal Hoeffding reference without issuing an empirical CI', () => {
    const bound = boundedRepositoryDifference(Array(200).fill(.25));
    expect(bound.halfWidth).toBeCloseTo(.19206455826398415, 14);
    expect(bound.lower).toBeCloseTo(.05793544173601585, 14);
    expect(bound.upper).toBeCloseTo(.44206455826398415, 14);
    expect(bound.scope).toBe('mathematical-reference-not-empirical-interval');
    expect(boundedRepositoryDifference([0, 0]).lower).toBe(-1);
    expect(() => boundedRepositoryDifference([0])).toThrow();
    expect(() => boundedRepositoryDifference([0, 0], 0)).toThrow();
  });
  it('recomputes scores and pairs identities, retaining missing executions and Unknown', async () => {
    const f = await fixture(); const mutated = structuredClone(f.report);
    mutated.arms[0].metrics.positiveRecall.value = .123; rehash(mutated);
    const result = aggregateMatchedResults([{ ...f, report: mutated }, { ...f, report: null, repetition: 2 }]);
    expect(result.plannedUnits).toBe(2); expect(result.missingReports).toBe(1);
    expect(result.units[0].arms.every(a => a.metrics.positiveRecall.value === 1)).toBe(true);
    expect(result.units[1].arms.every(a => a.metrics.positiveRecall.value === 0 && a.metrics.repeatedFeedbackStrictResolution.value === 0)).toBe(true);
    expect(result.units.every(u => u.unknownReferences === 1)).toBe(true);
    expect(result.strata[0].armMacros[0].metrics.positiveRecall.value).toBeNull();
    expect(result.strata[0].armMacros[0].metrics.positiveRecall.repositories[0].families[0].episodes[0].completeCaseDescriptive).toBe(1);
    expect(result.strata[0].costs.every(c => c.totalStandaloneCostMicros === null && c.unknownUnits === 1)).toBe(true);
    expect(result.strata[0].uncertainty.interval).toBeNull();
    expect(result.strata[0].uncertainty.reasons).toContain('authored-inputs-zero-empirical-episodes');
  });
  it('rejects duplicate slots, changed report identities, missing arms and substituted targets', async () => {
    const f = await fixture(); expect(() => aggregateMatchedResults([f, f])).toThrow('Duplicate');
    expect(() => aggregateMatchedResults([f, { ...f, repetition: 2 }])).toThrow('multiple repetition');
    for (const kind of ['digest', 'target', 'arm', 'model', 'observation', 'calls', 'invoked', 'outputDigest', 'effectiveState']) {
      const report = structuredClone(f.report);
      if (kind === 'digest') report.packetDigest = '0'.repeat(64);
      if (kind === 'target') report.arms[0].future[0].targetId = 'substitute';
      if (kind === 'arm') report.arms.pop();
      if (kind === 'observation') report.arms[0].future[0].prediction = 'safe';
      if (kind === 'calls') report.arms[0].calls = [];
      if (kind === 'outputDigest') report.arms[0].calls[0].outputDigest = '0'.repeat(64);
      if (kind === 'effectiveState') report.arms[0].effectiveState = { kind: 'scoped_memory', initialLesson: 'substituted', delta: null };
      if (kind === 'invoked') report.arms[0].calls[0].invoked = false;
      if (kind === 'model') { report.arms[0].calls[0].request.model = 'changed'; report.arms[0].calls[0].requestDigest = digestOf(report.arms[0].calls[0].request); }
      rehash(report); expect(() => aggregateMatchedResults([{ ...f, report }])).toThrow();
    }
  });
  it('does not mix model/settings strata or permit changed repeated packets', async () => {
    const f = await fixture(); const other = createMatchedFixture();
    other.packet.episode.id = 'other'; other.packet.episode.settings.reviewerModel = 'other-authored-model';
    other.packet.digest = digestOf(other.packet.episode);
    const result = aggregateMatchedResults([f, { ...other, report: null, repetition: 1 }]);
    expect(result.strata).toHaveLength(2);
    other.packet.episode.id = f.packet.episode.id; other.packet.digest = digestOf(other.packet.episode);
    expect(() => aggregateMatchedResults([f, { ...other, report: null, repetition: 2 }])).toThrow('Repetitions changed');
  });
  it('retains zero-denominator families and unmeasured call costs', async () => {
    const f = createMatchedFixture(); f.future.cases[0].label = 'unknown'; f.future.digest = digestOf(f.future.cases);
    const r = aggregateMatchedResults([{ ...f, repetition: 1, report: null }]);
    expect(r.strata[0].paired[0].metrics.positiveRecall.value).toBeNull();
    expect(r.strata[0].uncertainty.reasons).toContain('zero-required-denominator');
    const valid = await fixture(); valid.report = structuredClone(valid.report); valid.report.arms[0].calls[0].usage = null; rehash(valid.report);
    expect(aggregateMatchedResults([valid]).strata[0].costs.find(c => c.arm === valid.report.arms[0].arm)!.totalStandaloneCostMicros).toBeNull();
  });
});
