import { describe, expect, it, vi } from 'vitest';
import { buildSemanticReview, validateSemanticReview } from '../src/semantic-review.js';
import * as astGrep from '../src/adapters/ast-grep.js';
import { digestOf, ruleVersionDigest } from '../src/core/identity.js';
import { type LegacyReviewFixture as ReviewFixture, REVIEW_LIMITS, ReviewScanSchema, deriveLocalReviewVerdict, LocalReviewFeedbackSchema } from '../src/core/semantic-review.js';
import { makeSnapshotAnchor, makeReviewEvidence, snapshotSource, validateSnapshotAnchor } from '../src/adapters/semantic-review-fixture.js';
import { validateChangeSnapshot, type ChangeSnapshot } from '../src/change-snapshot.js';
import { capturedSide, readAsset, semanticInputs } from './helpers/semantic-review-fixture.js';

function fixture(input: ReturnType<typeof semanticInputs>, decision: 'safe' | 'violation' | 'unknown' = 'violation', kind = 'local-policy'): ReviewFixture {
  const review = buildSemanticReview(input), target = review.coverage.targets[0];
  const source = snapshotSource(input.snapshot, 'after', target.path), start = source.indexOf('dangerousRead()');
  const anchor = makeSnapshotAnchor(input.snapshot, 'after', target.path, start, start + 'dangerousRead()'.length);
  const evidence = makeReviewEvidence(input.snapshot, makeSnapshotAnchor(input.snapshot, 'after', target.path, 0, source.length), kind);
  return { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: input.rule.digest, snapshotDigest: input.snapshot.digest, evidence: [evidence],
    judgments: [{ targetId: target.id, decision, reasoning: 'Explicit synthetic fixture judgment; not independently verified policy.', evidenceRefs: [evidence.id], findingAnchors: decision === 'violation' ? [anchor] : [] }] };
}
function changedSnapshot(value: ChangeSnapshot) {
  const sides = value.changes.flatMap(change => [change.before, change.after]);
  value.coverage = { changedPaths: value.changes.length, capturedSides: sides.filter(side => side.state === 'captured').length,
    excludedSides: sides.filter(side => side.state === 'excluded').length, capturedBytes: sides.reduce((sum, side) => sum + (side.state === 'captured' ? side.byteLength : 0), 0), scope: 'changed-entries-only' };
  return validateChangeSnapshot(value);
}

describe('bounded semantic snapshot review', () => {
  it('keeps detectorless file units explicit without inventing a candidate or clean verdict', () => {
    const input = semanticInputs(), result = buildSemanticReview(input);
    expect(result.findings).toEqual([]); expect(result.occurrences).toEqual([]);
    expect(result.coverage.targets[0]).toMatchObject({ disposition: 'captured', scans: [], semantic: { state: 'not_run' } });
    expect(result.coverage).toMatchObject({ snapshotVerification: 'package-integrity-only', repositoryContext: 'incomplete', introduction: 'unverified' });
    expect(result.notification).toBe('not_performed'); expect(buildSemanticReview(input)).toEqual(result);
    expect(buildSemanticReview({ ...input, attempt: 'second' }).id).not.toBe(result.id);
  });
  it('creates only explicitly selected safe anchor findings without needing detector occurrences', () => {
    const input = semanticInputs(), fixtures = fixture(input);
    fixtures.judgments[0].decision = 'safe';
    const review = buildSemanticReview({ ...input, fixtures });
    expect(review.occurrences).toEqual([]);
    expect(review.findings).toMatchObject([{ status: 'safe', origin: 'fixture', occurrenceIds: [] }]);
    expect(validateSemanticReview(review, input.rule, input.snapshot)).toEqual(review);
    const unknown = structuredClone(fixtures); unknown.judgments[0].decision = 'unknown';
    expect(() => buildSemanticReview({ ...input, fixtures: unknown })).toThrow('unknown judgment cannot adjudicate');
    const wrongSide = structuredClone(fixtures); wrongSide.judgments[0].findingAnchors[0] = makeSnapshotAnchor(input.snapshot, 'before', 'src/sample.ts', 0, 8);
    expect(() => buildSemanticReview({ ...input, fixtures: wrongSide })).toThrow('exact captured after-side target');
  });

  it('keeps non-selected structural hits unverified for explicit safe anchors and preserves legacy target-only aggregation', () => {
    const input = semanticInputs({ assets: [readAsset], after: 'function run() { dangerousRead(); dangerousRead(); }\n' });
    const fixtures = fixture(input); fixtures.judgments[0].decision = 'safe';
    const explicit = buildSemanticReview({ ...input, fixtures });
    expect(explicit.findings.filter(value => value.status === 'safe')).toHaveLength(1);
    expect(explicit.findings.filter(value => value.status === 'not_verified')).toHaveLength(1);
    const legacy = structuredClone(fixtures); legacy.judgments[0].findingAnchors = [];
    const targetOnly = buildSemanticReview({ ...input, fixtures: legacy });
    expect(targetOnly.findings.every(value => value.status === 'safe')).toBe(true);
    expect(validateSemanticReview(targetOnly, input.rule, input.snapshot)).toEqual(targetOnly);
  });

  it('retains asset occurrences but groups identical source anchors into one finding', () => {
    const input = semanticInputs({ assets: [readAsset, { ...readAsset, id: 'second' }] });
    const result = buildSemanticReview(input);
    expect(result.occurrences).toHaveLength(2); expect(new Set(result.occurrences.map(v => v.id)).size).toBe(2);
    expect(result.occurrences[0].candidateId).toBe(result.occurrences[1].candidateId);
    expect(result.findings).toHaveLength(1); expect(result.findings[0]).toMatchObject({ status: 'not_verified', origin: 'structural', introduction: 'unverified', notificationEligibility: 'unverified' });
    expect(result.findings[0].occurrenceIds).toHaveLength(2);
    expect(validateSemanticReview(result, input.rule, input.snapshot)).toEqual(result);
  });
  it('preserves zero hits, unsupported engines/languages, mismatches and scanner failures', () => {
    const input = semanticInputs({ assets: [
      { ...readAsset, id: 'zero', detector: { ...readAsset.detector, pattern: 'absentCall()' } },
      { id: 'semgrep', detector: { kind: 'semgrep', language: 'typescript', yaml: 'rules: []' } },
      { id: 'opengrep', detector: { kind: 'opengrep', language: 'typescript', yaml: 'rules: []' } },
      { ...readAsset, id: 'unknown', detector: { ...readAsset.detector, language: 'ruby' } },
      { ...readAsset, id: 'python', detector: { ...readAsset.detector, language: 'python' } },
      { ...readAsset, id: 'invalid', detector: { ...readAsset.detector, pattern: ' ' } },
    ] });
    const result = buildSemanticReview(input), target = result.coverage.targets[0];
    expect(target.scans.map(v => v.state)).toEqual(['scanned', 'unsupported_engine', 'unsupported_engine', 'unsupported_language', 'language_mismatch', 'execution_error']);
    expect(target.scans[0].candidateCount).toBe(0); expect(target.semantic.state).toBe('not_run'); expect(result.findings).toEqual([]);
  });
  it.each([
    { name: 'Semgrep', asset: { id: 'semgrep', detector: { kind: 'semgrep' as const, language: 'typescript', yaml: 'rules: []' } }, path: 'src/sample.ts', expected: 'unsupported_engine' },
    { name: 'OpenGrep', asset: { id: 'opengrep', detector: { kind: 'opengrep' as const, language: 'ruby', yaml: 'rules: []' } }, path: 'src/sample.txt', expected: 'unsupported_engine' },
    { name: 'unregistered language', asset: { ...readAsset, detector: { ...readAsset.detector, language: 'ruby' } }, path: 'src/sample.txt', expected: 'unsupported_language' },
    { name: 'different language extension', asset: { ...readAsset, detector: { ...readAsset.detector, language: 'python' } }, path: 'src/sample.ts', expected: 'language_mismatch' },
    { name: 'unknown extension', asset: readAsset, path: 'src/sample.txt', expected: 'language_mismatch' },
    { name: 'missing extension', asset: readAsset, path: 'src/sample', expected: 'language_mismatch' },
  ])('rejects impossible read-time coverage for $name without relying on changed IDs', ({ asset, path, expected }) => {
    const input = semanticInputs({ assets: [asset], path }), original = buildSemanticReview(input);
    expect(original.coverage.targets[0].scans[0].state).toBe(expected);
    expect(validateSemanticReview(original, input.rule, input.snapshot)).toEqual(original);
    for (const state of ReviewScanSchema.shape.state.options.filter(value => value !== expected)) {
      const tampered = structuredClone(original), scan = tampered.coverage.targets[0].scans[0];
      Object.assign(scan, { state, candidateCount: state === 'scanned' ? 0 : null, reason: state === 'scanned' ? null : 'Forged coverage declaration' });
      expect(ReviewScanSchema.safeParse(scan).success).toBe(true);
      expect(tampered.id).toBe(original.id); expect(digestOf(tampered)).not.toBe(digestOf(original));
      expect(() => validateSemanticReview(tampered, input.rule, input.snapshot)).toThrow('eligibility');
    }
  });
  it('rejects fabricated ineligibility for an eligible zero-hit scan', () => {
    const input = semanticInputs({ after: 'safe();\n', assets: [readAsset] }), original = buildSemanticReview(input);
    expect(original.coverage.targets[0].scans[0]).toMatchObject({ state: 'scanned', candidateCount: 0 });
    for (const state of ['unsupported_engine', 'unsupported_language', 'language_mismatch'] as const) {
      const tampered = structuredClone(original);
      Object.assign(tampered.coverage.targets[0].scans[0], { state, candidateCount: null, reason: 'Forged coverage declaration' });
      expect(() => validateSemanticReview(tampered, input.rule, input.snapshot)).toThrow('eligibility');
    }
  });
  it.each([
    ['TS', 'src/sample.TS'], ['typescript', 'src/sample.mts'], ['ts', 'src/sample.cts'],
    ['JS', 'src/sample.JS'], ['javascript', 'src/sample.mjs'], ['js', 'src/sample.cjs'],
    ['TSX', 'src/sample.tsx'], ['jsx', 'src/sample.JSX'], ['PY', 'src/sample.py'], ['python', 'src/sample.PY'],
  ])('preserves eligible language alias %s and literal path %s', (language, path) => {
    const input = semanticInputs({ before: '', after: 'dangerousRead()\n', path, assets: [{ ...readAsset, detector: { ...readAsset.detector, language } }] });
    const result = buildSemanticReview(input);
    expect(result.coverage.targets[0].scans[0]).toMatchObject({ state: 'scanned', candidateCount: 1 });
    expect(validateSemanticReview(result, input.rule, input.snapshot)).toEqual(result);
  });
  it('validates legitimate zero-hit, error and unknown outcomes without rerunning the scanner', () => {
    const zero = semanticInputs({ after: 'safe();\n', assets: [readAsset] });
    const error = semanticInputs({ after: 'function {', assets: [readAsset] });
    const unknown = semanticInputs({ assets: [readAsset] });
    const cases = [
      { input: zero, result: buildSemanticReview(zero) },
      { input: error, result: buildSemanticReview(error) },
      { input: unknown, result: buildSemanticReview({ ...unknown, fixtures: fixture(unknown, 'unknown') }) },
    ];
    expect(cases[0].result.coverage.targets[0].scans[0]).toMatchObject({ state: 'scanned', candidateCount: 0 });
    expect(cases[1].result.coverage.targets[0].scans[0].state).toBe('execution_error');
    expect(cases[2].result.coverage.targets[0].semantic.state).toBe('unknown');
    const scanner = vi.spyOn(astGrep, 'detectAstGrep').mockImplementation(() => { throw new Error('Read validation must not scan'); });
    try {
      for (const { input, result } of cases) expect(validateSemanticReview(result, input.rule, input.snapshot)).toEqual(result);
      expect(scanner).not.toHaveBeenCalled();
    } finally { scanner.mockRestore(); }
  });
  it('records invalid source parsing as execution coverage failure, never safe', () => {
    const result = buildSemanticReview(semanticInputs({ after: 'function {', assets: [readAsset] }));
    expect(result.coverage.targets[0].scans[0].state).toBe('execution_error'); expect(result.coverage.targets[0].semantic.state).toBe('not_run');
  });
  it('allows detectorless explicit semantic fixtures with exact anchors and distinct identity', () => {
    const input = semanticInputs(), fixtures = fixture(input), result = buildSemanticReview({ ...input, fixtures });
    expect(result.config.mode).toBe('offline_fixture'); expect(result.config.fixtureDigest).toBe(digestOf(fixtures));
    expect(result.id).not.toBe(buildSemanticReview(input).id); expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ status: 'violation', origin: 'fixture', occurrenceIds: [], introduction: 'unverified', notificationEligibility: 'unverified' });
    const changed = structuredClone(fixtures); changed.judgments[0].reasoning = 'Another authored fixture explanation';
    expect(buildSemanticReview({ ...input, fixtures: changed }).id).not.toBe(result.id);
  });
  it('requires contextual evidence and keeps unjudged targets and hints unverified', () => {
    const input = semanticInputs({ assets: [readAsset] });
    const result = buildSemanticReview({ ...input, fixtures: fixture(input, 'violation', 'not-the-required-policy') });
    expect(result.coverage.targets[0].semantic).toMatchObject({ state: 'unknown', missingContext: ['local-policy'] });
    expect(result.findings[0]).toMatchObject({ status: 'unknown', origin: 'evidence_gate' });
    const detectorless = semanticInputs();
    expect(buildSemanticReview({ ...detectorless, fixtures: fixture(detectorless, 'violation', 'missing') }).findings).toEqual([]);
    const none = fixture(input); none.judgments = [];
    expect(buildSemanticReview({ ...input, fixtures: none }).findings[0].status).toBe('not_verified');
  });
  it('distinguishes explicit safe and unknown fixture judgments from actual model review', () => {
    const input = semanticInputs({ assets: [readAsset] });
    for (const decision of ['safe', 'unknown'] as const) {
      const result = buildSemanticReview({ ...input, fixtures: fixture(input, decision) });
      expect(result.findings[0]).toMatchObject({ status: decision, origin: 'fixture' });
      expect(result.coverage.targets[0].semantic.state).toBe(decision);
    }
  });
  it('does not adjudicate unrelated structural hits when a fixture identifies one violation', () => {
    const input = semanticInputs({ after: 'dangerousRead(); dangerousRead();\n', assets: [readAsset] });
    const result = buildSemanticReview({ ...input, fixtures: fixture(input) });
    expect(result.findings.map(v => v.status).sort()).toEqual(['not_verified', 'violation']);
  });
  it('keeps empty captured files covered without synthetic nonempty spans', () => {
    const result = buildSemanticReview(semanticInputs({ after: '', assets: [readAsset] }));
    expect(result.coverage.targets[0]).toMatchObject({ disposition: 'captured', semantic: { state: 'not_run' } });
    expect(result.coverage.targets[0].scans[0]).toMatchObject({ state: 'scanned', candidateCount: 0 }); expect(result.findings).toEqual([]);
  });
  it('preserves BOM, Unicode, CRLF and before/after identity', () => {
    const input = semanticInputs({ before: '\ufeff// 😀\r\ndangerousRead();\r\n', after: '\ufeff// 😀\r\ndangerousRead();\r\n', assets: [readAsset] });
    const result = buildSemanticReview(input), anchor = result.findings[0].anchor;
    expect(snapshotSource(input.snapshot, 'after', anchor.path).charCodeAt(0)).toBe(0xfeff);
    expect(anchor.span.start).toMatchObject({ line: 2, column: 1 }); expect(validateSnapshotAnchor(anchor, input.snapshot)).toBe('dangerousRead()');
    const before = { ...anchor, side: 'before' as const };
    const a = makeReviewEvidence(input.snapshot, anchor, 'local-policy'), b = makeReviewEvidence(input.snapshot, before, 'local-policy');
    expect(a.content).toBe(b.content); expect(a.id).not.toBe(b.id);
    const packet = fixture(input); packet.evidence = [b]; packet.judgments[0].evidenceRefs = [b.id];
    expect(buildSemanticReview({ ...input, fixtures: packet }).findings[0].status).toBe('violation');
  });
  it.each(['src/a:b.ts', 'src/tab\tname.ts', 'src/new\nline.ts', ' src/padded.ts'])('reports unsupported scope paths without normalization: %s', path => {
    const result = buildSemanticReview(semanticInputs({ path, assets: [readAsset] }));
    expect(result.coverage.targets[0]).toMatchObject({ path, disposition: 'unsupported_scope', scans: [] }); expect(result.findings).toEqual([]);
  });
  it('preserves excluded/deleted/rename scope cases and never infers introduction', () => {
    const input = semanticInputs({ assets: [readAsset] }), deleted = structuredClone(input.snapshot.snapshot);
    deleted.changes[0] = { status: 'D', before: deleted.changes[0].before, after: { state: 'absent' } };
    expect(buildSemanticReview({ ...input, snapshot: changedSnapshot(deleted) }).coverage.targets[0].disposition).toBe('deleted');
    const excluded = structuredClone(input.snapshot.snapshot);
    excluded.changes[0] = { status: 'T', before: excluded.changes[0].before, after: { state: 'excluded', path: 'src/sample.ts', mode: '120000', objectId: 'a'.repeat(40), byteLength: 8, sha256: null, reason: 'symlink' } };
    expect(buildSemanticReview({ ...input, snapshot: changedSnapshot(excluded) }).coverage.targets[0]).toMatchObject({ disposition: 'excluded', scans: [] });
    const renamed = structuredClone(input.snapshot.snapshot), old = renamed.changes[0].before;
    if (old.state !== 'captured') throw new Error('fixture');
    renamed.changes[0] = { status: 'R100', before: old, after: { ...old, path: 'src/generated/sample.ts' } };
    expect(buildSemanticReview({ ...input, snapshot: changedSnapshot(renamed) }).coverage.targets[0].disposition).toBe('out_of_scope');
  });
  it('really scans full changed files, including retained unchanged matches', () => {
    const input = semanticInputs({ before: 'dangerousRead();\n// old\n', after: 'dangerousRead();\n// new\n', assets: [readAsset] });
    const result = buildSemanticReview(input);
    expect(result.findings).toHaveLength(1); expect(result.findings[0].anchor.span.start.line).toBe(1);
    expect(result.findings[0].introduction).toBe('unverified');
  });
  it('rejects stale/forged fixture rules, snapshots, targets, refs, excerpts and anchors', () => {
    const input = semanticInputs({ assets: [readAsset] }), original = fixture(input);
    const corruptions: Array<(packet: ReviewFixture) => void> = [
      p => { p.ruleDigest = 'a'.repeat(64); }, p => { p.snapshotDigest = 'a'.repeat(64); },
      p => { p.judgments[0].targetId = 'a'.repeat(64); }, p => { p.judgments[0].evidenceRefs = ['a'.repeat(64)]; },
      p => { p.evidence[0].content += 'invented'; }, p => { p.evidence[0].anchor.sourceDigest = 'a'.repeat(64); },
      p => { p.judgments[0].findingAnchors[0].span.start.line++; }, p => { p.judgments[0].findingAnchors[0].side = 'before'; },
      p => { p.judgments.push(p.judgments[0]); }, p => { p.judgments[0].evidenceRefs = []; },
    ];
    for (const corrupt of corruptions) { const p = structuredClone(original); corrupt(p); expect(() => buildSemanticReview({ ...input, fixtures: p })).toThrow(); }
  });
  it('rejects read-time missing coverage, duplicated occurrences and changed aggregate results', () => {
    const input = semanticInputs({ assets: [readAsset] }), original = buildSemanticReview(input);
    for (const mutate of [
      (r: typeof original) => { r.coverage.targets = []; },
      (r: typeof original) => { r.occurrences.push(r.occurrences[0]); },
      (r: typeof original) => { r.findings[0].status = 'violation'; },
      (r: typeof original) => { r.coverage.targets[0].semantic.state = 'safe'; },
    ]) { const result = structuredClone(original); mutate(result); expect(() => validateSemanticReview(result, input.rule, input.snapshot)).toThrow(); }
  });
  it('bounds unbounded authored assets and aggregate scanner work without silent truncation', () => {
    const over = semanticInputs({ assets: Array.from({ length: REVIEW_LIMITS.assets + 1 }, (_, i) => ({ ...readAsset, id: `asset-${i}` })) });
    expect(() => buildSemanticReview(over)).toThrow('detection assets');
    const input = semanticInputs({ assets: [
      readAsset,
      { id: 'semgrep', detector: { kind: 'semgrep', language: 'typescript', yaml: 'rules: []' } },
      { ...readAsset, id: 'unknown', detector: { ...readAsset.detector, language: 'ruby' } },
      { ...readAsset, id: 'python', detector: { ...readAsset.detector, language: 'python' } },
    ] }), snap = structuredClone(input.snapshot.snapshot);
    snap.changes = Array.from({ length: 257 }, (_, i) => ({ status: 'A' as const, before: { state: 'absent' as const }, after: capturedSide(`src/a${String(i).padStart(3, '0')}.ts`, 'safe();\n') }));
    const snapshot = changedSnapshot(snap), result = buildSemanticReview({ ...input, snapshot });
    expect(result.coverage.targets).toHaveLength(257); expect(result.coverage.targets[255].scans[0].state).toBe('scanned');
    expect(result.coverage.targets[256].scans.map(scan => scan.state)).toEqual(['budget_exceeded', 'unsupported_engine', 'unsupported_language', 'language_mismatch']);
    expect(result.coverage.targets[256].semantic.state).toBe('not_run');
    const scanner = vi.spyOn(astGrep, 'detectAstGrep').mockImplementation(() => { throw new Error('Read validation must not scan'); });
    try {
      expect(validateSemanticReview(result, input.rule, snapshot)).toEqual(result);
      expect(scanner).not.toHaveBeenCalled();
    } finally { scanner.mockRestore(); }
  });
  it('rejects v1 review and corrupted rule/snapshot identity before scanning', () => {
    const input = semanticInputs();
    expect(() => buildSemanticReview({ ...input, rule: { ...input.rule, digest: 'a'.repeat(64) } })).toThrow('rule digest');
    expect(() => buildSemanticReview({ ...input, snapshot: { ...input.snapshot, digest: 'a'.repeat(64) } })).toThrow('snapshot digest');
    const changed = structuredClone(input.rule.rule); changed.semantics.mechanism = 'Changed mechanism';
    expect(ruleVersionDigest(changed)).not.toBe(input.rule.digest);
  });
});

it('does not turn simulated labels or workflow events into human correctness', () => {
  const input = semanticInputs({ assets: [readAsset] }), finding = buildSemanticReview(input).findings[0];
  const feedback = LocalReviewFeedbackSchema.parse({ id: 'feedback', findingId: finding.id, reviewId: finding.reviewId, ruleDigest: finding.ruleDigest, ruleVersion: finding.ruleVersion,
    source: 'fixture', actor: 'simulated', kind: 'label', label: 'TP', reason: 'Synthetic test declaration only.', createdAt: '2026-10-01T00:00:00Z' });
  expect(deriveLocalReviewVerdict([feedback])).toBe('Unknown');
  const human = { ...feedback, source: 'local-human-declared' as const };
  expect(deriveLocalReviewVerdict([human])).toBe('TP'); expect(deriveLocalReviewVerdict([human, { ...human, id: 'other', label: 'FP' }])).toBe('Disputed');
  expect(deriveLocalReviewVerdict([{ ...human, kind: 'resolve', label: null }])).toBe('Unknown');
});
