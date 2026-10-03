import { expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { PrMiningRequestInputSchema } from '../src/core/pr-mining.js';
import { derivePrMiningRequest, derivePrMiningCandidate, miningBudget } from '../src/pr-mining.js';
import { validateChangeSnapshot } from '../src/change-snapshot.js';
import { validateGithubPrEvidence } from '../src/github-pr-evidence.js';
import { miningFixture } from './helpers/pr-mining-fixture.js';

it('pins before to merge-base and after to head with exact source, object and statement digests and unknown-only cases', () => {
  const { evidence, request, cases, candidate } = miningFixture();
  expect(cases.map(value => value.commit)).toEqual([evidence.evidence.snapshot.mergeBase, evidence.evidence.snapshot.head]);
  expect(cases.every(value => value.expected === 'unknown' && value.split === 'training' && value.provenance.reviewedBy === null)).toBe(true);
  expect(request.request.sourceBindings.map(value => value.caseDigest)).toEqual(cases.map(digestOf));
  expect(request.request.statementBindings.map(value => value.digest)).toEqual([
    digestOf(evidence.evidence.pull), digestOf(evidence.evidence.discussions.issueComments[0]),
    digestOf(evidence.evidence.discussions.reviews[0]), digestOf(evidence.evidence.discussions.reviewComments[0]),
  ]);
  expect(request.request.trust).toMatchObject({ labels: 'unknown-only', historicalReviewCheckpoint: false, certification: 'none' });
  expect(derivePrMiningCandidate(candidate, request)).toMatchObject({ source: 'fixture', synthesis: 'not_run', semanticValidation: 'not_run', activation: 'not_performed' });
  expect(cases[0].sourceDigest).toBe(evidence.evidence.snapshot.changes[0].before.state === 'captured' && evidence.evidence.snapshot.changes[0].before.sha256);
});

it('rejects absent/excluded sides, empty snapshots, nonexistent discussions, identity drift, duplicate and unsupported paths', () => {
  const { evidence, input } = miningFixture();
  expect(() => derivePrMiningRequest({ ...input, sources: [{ side: 'before', path: 'missing.ts' }] }, evidence)).toThrow('exact captured side');
  expect(() => derivePrMiningRequest({ ...input, evidenceDigest: 'f'.repeat(64) }, evidence)).toThrow('identity mismatch');
  expect(() => derivePrMiningRequest({ ...input, statements: [{ kind: 'review', id: 999 }] }, evidence)).toThrow('absent');
  expect(() => PrMiningRequestInputSchema.parse({ ...input, sources: [input.sources[0], input.sources[0]] })).toThrow('Duplicate');
  expect(() => PrMiningRequestInputSchema.parse({ ...input, statements: [input.statements[0], input.statements[0]] })).toThrow('Duplicate');
  for (const path of ['../secret', '/tmp/a', 'src/*.ts', 'src/a\\b', 'src/a\n']) {
    expect(() => PrMiningRequestInputSchema.parse({ ...input, sources: [{ side: 'before', path }] })).toThrow();
  }
  const empty = validateChangeSnapshot({ ...evidence.evidence.snapshot, changes: [], coverage: { changedPaths: 0, capturedSides: 0, excludedSides: 0, capturedBytes: 0, scope: 'changed-entries-only' } });
  const emptyEvidence = validateGithubPrEvidence({ ...evidence.evidence, snapshotDigest: empty.digest, snapshot: empty.snapshot, source: { ...evidence.evidence.source, compareFileCount: 0 } });
  expect(() => derivePrMiningRequest({ ...input, evidenceDigest: emptyEvidence.digest }, emptyEvidence)).toThrow('exact captured side');
  const changed = structuredClone(evidence.evidence.snapshot), before = changed.changes[0].before;
  if (before.state !== 'captured') throw new Error('Fixture missing captured bytes');
  changed.changes[0].before = { state: 'excluded', reason: 'total-byte-limit', path: before.path, mode: before.mode, objectId: before.objectId, byteLength: before.byteLength, sha256: null };
  changed.coverage.capturedSides--; changed.coverage.excludedSides++; changed.coverage.capturedBytes -= before.byteLength; changed.limits.maxTotalBytes = changed.coverage.capturedBytes;
  const excluded = validateChangeSnapshot(changed), excludedEvidence = validateGithubPrEvidence({ ...evidence.evidence, snapshotDigest: excluded.digest, snapshot: excluded.snapshot });
  expect(() => derivePrMiningRequest({ ...input, evidenceDigest: excludedEvidence.digest }, excludedEvidence)).toThrow('exact captured side');
});

it('rejects candidate provenance/identity mismatches, extra/missing source or regression cases, v1 rules and fixture laundering', () => {
  const { request, candidate } = miningFixture();
  for (const field of ['ruleId', 'version'] as const) expect(() => derivePrMiningCandidate({ ...candidate, rule: { ...candidate.rule, [field]: 'wrong' } }, request)).toThrow('requested rule');
  expect(() => derivePrMiningCandidate({ ...candidate, requestDigest: 'f'.repeat(64) }, request)).toThrow('identity mismatch');
  expect(() => derivePrMiningCandidate({ ...candidate, source: 'supplied' }, request)).toThrow('fixture candidate');
  const clone = () => structuredClone(candidate);
  const missing = clone(); missing.rule.provenance.sourceCases.pop();
  expect(() => derivePrMiningCandidate(missing, request)).toThrow('every exact selected');
  for (const key of ['repository', 'commit', 'path', 'sourceDigest'] as const) {
    const value = clone(); value.rule.provenance.sourceCases[0][key] = key === 'commit' ? '9'.repeat(40) : key === 'sourceDigest' ? '9'.repeat(64) : 'wrong';
    expect(() => derivePrMiningCandidate(value, request)).toThrow('every exact selected');
  }
  const extra = clone(); extra.rule.regressionCases.push({ caseId: 'not-selected', role: 'negative' });
  expect(() => derivePrMiningCandidate(extra, request)).toThrow('regression cases');
  expect(() => derivePrMiningCandidate({ ...candidate, rule: { ...candidate.rule, schemaVersion: 1 } } as never, request)).toThrow();
  expect(() => derivePrMiningCandidate({ ...candidate, rule: { ...candidate.rule, label: 'TP' } } as never, request)).toThrow();
  expect(() => miningBudget('x'.repeat(2_000_001))).toThrow('2MB');
});

it('keeps cases stable across changed authored objectives but changes frozen request and statement identities', () => {
  const { evidence, input, cases, request } = miningFixture();
  const changed = derivePrMiningRequest({ ...input, id: 'other-request', objective: 'Different supplied hypothesis' }, evidence);
  expect(changed.cases).toEqual(cases); expect(changed.request.digest).not.toBe(request.digest);
  const statements = structuredClone(evidence.evidence); statements.discussions.issueComments[0].body = 'Edited statement';
  const editedEvidence = validateGithubPrEvidence(statements), edited = derivePrMiningRequest({ ...input, evidenceDigest: editedEvidence.digest }, editedEvidence);
  expect(edited.request.request.statementBindings[1].digest).not.toBe(request.request.statementBindings[1].digest);
  expect(edited.cases[0].id).not.toBe(cases[0].id);
});

it('accepts explicitly supplied requests/candidates without attributing them to a human or model', () => {
  const { evidence, input, candidate } = miningFixture();
  const { request } = derivePrMiningRequest({ ...input, source: 'supplied' }, evidence);
  const value = derivePrMiningCandidate({ ...candidate, requestDigest: request.digest, source: 'supplied' }, request);
  expect(value.source).toBe('supplied'); expect(value.synthesis).toBe('not_run');
  expect(request.request.trust.identity).toBe('caller-declared-unverified');
});
