import { describe, expect, it, vi } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { buildSemanticReview, validateSemanticReview } from '../src/semantic-review.js';
import { type AnchorReviewFixture, type LegacyReviewFixture, ReviewFixtureSchema, semanticReviewId } from '../src/core/semantic-review.js';
import { makeSnapshotAnchor, makeReviewEvidence, snapshotSource } from '../src/adapters/semantic-review-fixture.js';
import * as astGrep from '../src/adapters/ast-grep.js';
import { semanticInputs, readAsset } from './helpers/semantic-review-fixture.js';

function mixed(assets = false) {
  const input = semanticInputs({ after: '// Policy: public reads are exempt; private reads require authorization.\nfunction privateRead() { dangerousRead(); }\nfunction publicRead() { dangerousRead(); }\nfunction unresolvedRead() { dangerousRead(); }\n', ...(assets ? { assets: [readAsset] } : {}) });
  const target = buildSemanticReview(input).coverage.targets[0], source = snapshotSource(input.snapshot, 'after', target.path);
  const anchors = [...source.matchAll(/dangerousRead\(\)/g)].map(match => makeSnapshotAnchor(input.snapshot, 'after', target.path, match.index, match.index + match[0].length));
  const policy = makeReviewEvidence(input.snapshot, makeSnapshotAnchor(input.snapshot, 'after', target.path, 0, source.indexOf('\n')), 'local-policy');
  const evidence = anchors.map(anchor => makeReviewEvidence(input.snapshot, anchor, 'source'));
  const fixtures: AnchorReviewFixture = { schemaVersion: 2, kind: 'semantic-review-offline-fixtures', ruleDigest: input.rule.digest, snapshotDigest: input.snapshot.digest,
    evidence: [policy, ...evidence], judgments: [{ targetId: target.id, decision: 'violation', reasoning: 'Authored conditional rule fixture: one private read violates policy, while the public read is exempt.',
      evidenceRefs: [policy.id, evidence[0].id], missingContext: [], anchorJudgments: anchors.slice(0, 2).map((anchor, index) => ({ anchor,
        decision: index === 0 ? 'violation' : 'safe', reasoning: index === 0 ? 'Private read lacks authorization in this authored fixture.' : 'Explicit public-read exception in this authored fixture.',
        evidenceRefs: [policy.id, evidence[index].id], missingContext: [] })) }] };
  return { input, fixtures, anchors, evidence, policy };
}

describe('independent exact-anchor semantic judgments', () => {
  it.each([false, true])('represents a useful conditional rule with a violation and legitimate exception in one file (assets=%s)', assets => {
    const { input, fixtures, anchors } = mixed(assets), review = buildSemanticReview({ ...input, fixtures });
    expect(review.config.runtime).toBe('semantic-snapshot-review-v2');
    expect(review.coverage.targets[0].semantic.state).toBe('violation');
    expect(review.findings.find(item => digestOf(item.anchor) === digestOf(anchors[0]))).toMatchObject({ status: 'violation', origin: 'fixture' });
    expect(review.findings.find(item => digestOf(item.anchor) === digestOf(anchors[1]))).toMatchObject({ status: 'safe', origin: 'fixture' });
    expect(review.findings.find(item => digestOf(item.anchor) === digestOf(anchors[2]))?.status).toBe(assets ? 'not_verified' : undefined);
    expect(buildSemanticReview({ ...input, fixtures })).toEqual(review);
    expect(validateSemanticReview(review, input.rule, input.snapshot)).toEqual(review);
  });

  it('keeps known anchors while target-level context is unresolved, without borrowing their evidence', () => {
    const { input, fixtures } = mixed();
    fixtures.judgments[0].decision = 'unknown'; fixtures.judgments[0].evidenceRefs = []; fixtures.judgments[0].missingContext = ['remaining callsite context'];
    const review = buildSemanticReview({ ...input, fixtures });
    expect(review.coverage.targets[0].semantic).toMatchObject({ state: 'unknown', missingContext: ['local-policy', 'remaining callsite context'] });
    expect(review.findings.map(item => item.status).sort()).toEqual(['safe', 'violation']);
  });

  it('gates each anchor using only its own cited context and explicit missingContext', () => {
    const { input, fixtures, anchors, evidence } = mixed();
    fixtures.judgments[0].anchorJudgments[1].evidenceRefs = [evidence[1].id];
    let review = buildSemanticReview({ ...input, fixtures });
    expect(review.coverage.targets[0].semantic.state).toBe('violation');
    expect(review.findings.find(item => digestOf(item.anchor) === digestOf(anchors[1]))).toMatchObject({ status: 'unknown', origin: 'evidence_gate', evidenceRefs: [evidence[1].id] });
    expect(review.findings.find(item => digestOf(item.anchor) === digestOf(anchors[0]))?.status).toBe('violation');
    fixtures.judgments[0].anchorJudgments[0].missingContext = ['authorization implementation is uncaptured'];
    review = buildSemanticReview({ ...input, fixtures });
    expect(review.coverage.targets[0].semantic).toMatchObject({ state: 'unknown', missingContext: ['authorization implementation is uncaptured', 'local-policy'] });
    expect(review.findings.every(item => item.status === 'unknown')).toBe(true);
  });

  it('does not let an individually unresolved anchor support a whole-target safe claim', () => {
    const { input, fixtures } = mixed();
    fixtures.judgments[0].decision = 'safe';
    for (const anchor of fixtures.judgments[0].anchorJudgments) anchor.decision = 'safe';
    fixtures.judgments[0].anchorJudgments[1].missingContext = ['public-read classification unresolved'];
    const review = buildSemanticReview({ ...input, fixtures });
    expect(review.coverage.targets[0].semantic.state).toBe('unknown');
    expect(review.findings.map(item => item.status).sort()).toEqual(['safe', 'unknown']);
  });

  it('keeps explicitly unknown anchors without inventing a detector or a safety claim', () => {
    const { input, fixtures, anchors } = mixed();
    fixtures.judgments[0].anchorJudgments.push({ anchor: anchors[2], decision: 'unknown', reasoning: 'Cannot establish the category of this callsite.', evidenceRefs: [], missingContext: ['callsite classification'] });
    const review = buildSemanticReview({ ...input, fixtures });
    expect(review.occurrences).toEqual([]);
    expect(review.findings.map(item => item.status).sort()).toEqual(['safe', 'unknown', 'violation']);
    expect(review.findings.find(item => item.status === 'unknown')?.anchor).toEqual(anchors[2]);
  });

  it('does not adjudicate uncited, cited-only or structurally matched anchors by file-level safety', () => {
    const { input, fixtures } = mixed(true);
    fixtures.judgments[0].decision = 'safe'; fixtures.judgments[0].anchorJudgments = [];
    // The target evidence cites the exact first span, without an explicit anchor judgment.
    const review = buildSemanticReview({ ...input, fixtures });
    expect(review.coverage.targets[0].semantic.state).toBe('safe');
    expect(review.findings.every(item => item.status === 'not_verified' && item.evidenceRefs.length === 0)).toBe(true);
  });

  it.each(['identical', 'conflicting'] as const)('rejects %s duplicate anchor declarations', kind => {
    const { input, fixtures } = mixed();
    const duplicate = structuredClone(fixtures.judgments[0].anchorJudgments[0]);
    if (kind === 'conflicting') duplicate.decision = 'safe';
    fixtures.judgments[0].anchorJudgments.push(duplicate);
    expect(() => buildSemanticReview({ ...input, fixtures })).toThrow('Duplicate or conflicting anchor judgments');
  });

  it('rejects conflicting target/anchor coverage and a target violation without an explicit violation', () => {
    const { fixtures } = mixed();
    fixtures.judgments[0].decision = 'safe';
    expect(() => ReviewFixtureSchema.parse(fixtures)).toThrow('safe target');
    fixtures.judgments[0].decision = 'violation'; fixtures.judgments[0].anchorJudgments = [];
    expect(() => ReviewFixtureSchema.parse(fixtures)).toThrow('explicit violation anchor');
  });

  const corruptions: [string, (packet: AnchorReviewFixture) => void][] = [
    ['rule', p => { p.ruleDigest = 'a'.repeat(64); }],
    ['snapshot', p => { p.snapshotDigest = 'a'.repeat(64); }],
    ['target', p => { p.judgments[0].targetId = 'a'.repeat(64); }],
    ['missing anchor citation', p => { p.judgments[0].anchorJudgments[1].evidenceRefs = ['a'.repeat(64)]; }],
    ['uncited decisive anchor', p => { p.judgments[0].anchorJudgments[1].evidenceRefs = []; }],
    ['wrong source digest', p => { p.judgments[0].anchorJudgments[1].anchor.sourceDigest = 'a'.repeat(64); }],
    ['wrong snapshot digest', p => { p.judgments[0].anchorJudgments[1].anchor.snapshotDigest = 'a'.repeat(64); }],
    ['wrong after path', p => { p.judgments[0].anchorJudgments[1].anchor.path = 'src/other.ts'; }],
    ['wrong side', p => { p.judgments[0].anchorJudgments[1].anchor.side = 'before'; }],
    ['wrong line', p => { p.judgments[0].anchorJudgments[1].anchor.span.start.line++; }],
    ['wrong column', p => { p.judgments[0].anchorJudgments[1].anchor.span.end.column++; }],
    ['wrong offset', p => { p.judgments[0].anchorJudgments[1].anchor.span.end.offset++; }],
    ['empty anchor', p => { const a = p.judgments[0].anchorJudgments[1].anchor; a.span.end = a.span.start; }],
    ['duplicate target', p => { p.judgments.push(p.judgments[0]); }],
    ['duplicate ref', p => { const a = p.judgments[0].anchorJudgments[1]; a.evidenceRefs.push(a.evidenceRefs[0]); }],
    ['duplicate context', p => { p.judgments[0].anchorJudgments[1].missingContext = ['missing', 'missing']; }],
    ['v3 fields in old fixture', p => { (p as unknown as { schemaVersion: number }).schemaVersion = 1; }],
  ];
  it.each(corruptions)('rejects %s before accepting any mixed outcome', (_, corrupt) => {
    const { input, fixtures } = mixed(); corrupt(fixtures);
    expect(() => buildSemanticReview({ ...input, fixtures })).toThrow();
  });

  it('bounds per-target anchors and preserves scanner-free read rederivation', () => {
    const { input, fixtures } = mixed(true), review = buildSemanticReview({ ...input, fixtures });
    const scanner = vi.spyOn(astGrep, 'detectAstGrep').mockImplementation(() => { throw new Error('Read must not rescan'); });
    try {
      expect(validateSemanticReview(review, input.rule, input.snapshot)).toEqual(review);
      const tampered = structuredClone(review); tampered.findings[0].status = 'safe'; tampered.findings[0].reasoning = 'Invented';
      expect(() => validateSemanticReview(tampered, input.rule, input.snapshot)).toThrow('aggregation');
      const wrongRuntime = structuredClone(review); wrongRuntime.config.runtime = 'semantic-snapshot-review-v1';
      wrongRuntime.id = semanticReviewId(wrongRuntime.ruleDigest, wrongRuntime.snapshotDigest, wrongRuntime.config);
      expect(() => validateSemanticReview(wrongRuntime, input.rule, input.snapshot)).toThrow('runtime does not match');
      expect(scanner).not.toHaveBeenCalled();
    } finally { scanner.mockRestore(); }
    fixtures.judgments[0].anchorJudgments = Array.from({ length: 101 }, () => fixtures.judgments[0].anchorJudgments[0]);
    expect(() => ReviewFixtureSchema.parse(fixtures)).toThrow();
  });
});

it('keeps legacy review IDs and payload hashes exactly unchanged', () => {
  const input = semanticInputs({ assets: [readAsset] }), base = buildSemanticReview(input), target = base.coverage.targets[0];
  const source = snapshotSource(input.snapshot, 'after', target.path), start = source.indexOf('dangerousRead()');
  // Frozen pre-v3 golden uses this exact authored 15-code-unit span.
  const anchor = makeSnapshotAnchor(input.snapshot, 'after', target.path, start, start + 15), evidence = makeReviewEvidence(input.snapshot, anchor, 'local-policy');
  expect(base.id).toBe('review_1813985ed8e0c6bf49faf6f5d2a79f1ab24887a32f72b9d4d652af0f2177c583');
  expect(digestOf(base)).toBe('3968e68cb614ab6971054f87a8c7f521debd7fedab800e167a381d4ce412fec3');
  const goldens = {
    violation: ['review_12a46971ac7cc4ae2136355845d237e18cfd32b9b15a15c4fa13abcb17ca6fcd', 'aa0fe4e596aafff2fa7ec5b83cd1575da6532112fbfe27bd9522aa9ee01a1f08'],
    safe: ['review_394da27fc88ec64f2f01370d195b5fbdb529acc3bc197028fbc85bff74c0cebd', '5b01172410a754f78fa48f8e500e08019d6bc307ddcfe1ba3546c91096e12e3e'],
    unknown: ['review_d8fa6adb376fe19ff477713e897977f2ad407f7de978c25a49dee55dc5c868c1', '900244027e57eb96e25d3b6350f289325027c724987f9c9ab34b80e74a54894b'],
  };
  for (const decision of ['violation', 'safe', 'unknown'] as const) {
    const fixtures: LegacyReviewFixture = { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: input.rule.digest, snapshotDigest: input.snapshot.digest,
      evidence: [evidence], judgments: [{ targetId: target.id, decision, reasoning: 'Legacy immutable authored fixture', evidenceRefs: [evidence.id], findingAnchors: decision === 'violation' ? [anchor] : [] }] };
    const review = buildSemanticReview({ ...input, fixtures });
    expect([review.id, digestOf(review)]).toEqual(goldens[decision]);
    expect(validateSemanticReview(review, input.rule, input.snapshot)).toEqual(review);
  }
});
