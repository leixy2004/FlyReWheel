import { describe, expect, it } from 'vitest';
import { contextReviewFixture } from './helpers/semantic-review-context-fixture.js';
import { buildSemanticReview, validateSemanticReview } from '../src/semantic-review.js';
import { digestOf } from '../src/core/identity.js';
import { ReviewFixtureSchema, semanticReviewId, type AnchorReviewFixture } from '../src/core/semantic-review.js';
import { makeRepositoryContextAnchor, validateRepositoryContext } from '../src/repository-context.js';
import { validateReviewRepositoryContexts } from '../src/semantic-review-context.js';
import { capturedSide } from './helpers/semantic-review-fixture.js';

const build = (f: ReturnType<typeof contextReviewFixture>) => buildSemanticReview({ ...f.input, fixtures: f.fixtures, repositoryContexts: [f.context] });

describe('selected repository context semantic acceptance', () => {
  it('keeps the same-file decisions unknown without unchanged contract/test support, then accepts authored mixed decisions with the exact selected packages', () => {
    const f = contextReviewFixture();
    const { repositoryContextDigests: ignored, ...base } = f.fixtures;
    const missing: AnchorReviewFixture = { ...base, schemaVersion: 2, evidence: f.sourceEvidence,
      judgments: base.judgments.map(j => ({ ...j, evidenceRefs: [f.sourceEvidence[0].id], anchorJudgments: j.anchorJudgments.map((a, i) => ({ ...a, evidenceRefs: [f.sourceEvidence[i].id] })) })) };
    const unknown = buildSemanticReview({ ...f.input, fixtures: missing });
    expect(unknown.findings.map(item => item.status)).toEqual(['unknown', 'unknown']);
    expect(unknown.coverage.targets[0].semantic.missingContext).toEqual(['callee-contract', 'test']);
    const result = build(f);
    expect(result.config).toMatchObject({ runtime: 'semantic-snapshot-review-v3', repositoryContextDigests: [f.context.digest] });
    expect(result.findings.map(item => item.status).sort()).toEqual(['safe', 'violation']);
    expect(result.findings.every(item => item.anchor.path === 'src/sample.ts' && item.origin === 'fixture' && item.introduction === 'unverified')).toBe(true);
    expect(result.coverage.repositoryContext).toBe('incomplete');
    expect(result.notification).toBe('not_performed');
    expect(validateSemanticReview(result, f.input.rule, f.input.snapshot)).toEqual(result);
  });

  it('keeps required and reported context local to each anchor and target', () => {
    const f = contextReviewFixture();
    f.fixtures.judgments[0].anchorJudgments[1].evidenceRefs = [f.sourceEvidence[1].id];
    const result = build(f);
    expect(result.findings.find(item => digestOf(item.anchor) === digestOf(f.anchors[0]))?.status).toBe('violation');
    expect(result.findings.find(item => digestOf(item.anchor) === digestOf(f.anchors[1]))?.status).toBe('unknown');
    f.fixtures.judgments[0].anchorJudgments[0].missingContext = ['callee dispatch unresolved'];
    expect(build(f).findings.every(item => item.status === 'unknown')).toBe(true);
  });

  it.each(['future', 'wrong repository'] as const)('rejects %s packages even when selected bytes are unchanged', kind => {
    const f = contextReviewFixture(), altered = structuredClone(f.context.context);
    if (kind === 'future') altered.head = '3'.repeat(40); else altered.repository.id = 'synthetic:other';
    const context = validateRepositoryContext(altered);
    expect(() => buildSemanticReview({ ...f.input, repositoryContexts: [context], fixtures: f.fixtures })).toThrow('exact snapshot repository and review head');
  });

  it.each(['tamper', 'selection substitution', 'unselected context', 'unselected path', 'excerpt', 'position', 'object', 'missing reference'] as const)('rejects %s', kind => {
    const f = contextReviewFixture(), citation = f.fixtures.evidence[2];
    if (!('contextDigest' in citation.anchor)) throw new Error('Expected context anchor');
    if (kind === 'tamper') { const e = f.context.context.entries[0]; if (e.state === 'captured') e.bytesBase64 = Buffer.from('altered').toString('base64'); }
    if (kind === 'selection substitution') f.fixtures.repositoryContextDigests = ['a'.repeat(64)];
    if (kind === 'unselected context') citation.anchor.contextDigest = 'a'.repeat(64);
    if (kind === 'unselected path') citation.anchor.path = 'uncaptured.ts';
    if (kind === 'excerpt') citation.content += 'invented';
    if (kind === 'position') citation.anchor.span.end.column++;
    if (kind === 'object') citation.anchor.objectId = 'a'.repeat(40);
    if (kind === 'missing reference') f.fixtures.judgments[0].anchorJudgments[0].evidenceRefs.push('a'.repeat(64));
    expect(() => build(f)).toThrow();
  });

  it.each(['missing', 'excluded'] as const)('cannot cite %s paths from an otherwise selected package', kind => {
    const f = contextReviewFixture(), raw = structuredClone(f.context.context);
    raw.entries = kind === 'missing' ? [{ state: 'missing', path: 'contracts/read.txt' }] : [{ state: 'excluded', path: 'contracts/read.txt', mode: '100644', objectId: 'a'.repeat(40), reason: 'oversize', byteLength: 262_145, sha256: null }];
    raw.coverage = { selectedPaths: 1, capturedPaths: 0, missingPaths: kind === 'missing' ? 1 : 0, excludedPaths: kind === 'excluded' ? 1 : 0, capturedBytes: 0, scope: 'selected-paths-only', historicalAvailability: 'unproven' };
    const context = validateRepositoryContext(raw);
    expect(() => makeRepositoryContextAnchor(context, 'contracts/read.txt', 0, 1)).toThrow('no captured source');
    const citation = structuredClone(f.contextEvidence[0]); citation.anchor.contextDigest = context.digest;
    citation.id = digestOf({ kind: citation.kind, anchor: citation.anchor, content: citation.content });
    f.fixtures.repositoryContextDigests = [context.digest]; f.fixtures.evidence = [f.sourceEvidence[0], citation];
    expect(() => buildSemanticReview({ ...f.input, fixtures: f.fixtures, repositoryContexts: [context] })).toThrow('no captured source');
  });

  it('rejects context anchors as finding locations and rejects supporting context as the only decisive target evidence', () => {
    const f = contextReviewFixture();
    const invalid = structuredClone(f.fixtures);
    Object.assign(invalid.judgments[0].anchorJudgments[0], { anchor: f.contextEvidence[0].anchor });
    expect(ReviewFixtureSchema.safeParse(invalid).success).toBe(false);
    f.fixtures.judgments[0].anchorJudgments[0].evidenceRefs = f.contextEvidence.map(item => item.id);
    expect(() => build(f)).toThrow('own target');
  });

  it('never accepts the new evidence in legacy fixtures or new fixtures without an explicit frozen context selection', () => {
    const f = contextReviewFixture();
    expect(() => buildSemanticReview({ ...f.input, fixtures: f.fixtures })).toThrow('context-aware fixture contract');
    for (const schemaVersion of [1, 2]) expect(ReviewFixtureSchema.safeParse({ ...f.fixtures, schemaVersion }).success).toBe(false);
    expect(() => buildSemanticReview({ ...f.input, repositoryContexts: [] })).toThrow();
    expect(() => buildSemanticReview({ ...f.input, repositoryContexts: [f.context, f.context] })).toThrow('unique');
  });

  it('bounds aggregate inputs, canonicalizes selections, rejects overlapping substitution, and drops copied capture receipts', () => {
    const f = contextReviewFixture();
    expect(() => validateReviewRepositoryContexts(Array(9).fill(f.context), f.input.snapshot)).toThrow('bounded');
    const other = structuredClone(f.context.context); other.entries[0] = capturedSide('contracts/read.txt', 'different contract');
    other.coverage.capturedBytes = other.entries.reduce((n, e) => n + (e.state === 'captured' ? e.byteLength : 0), 0);
    expect(() => validateReviewRepositoryContexts([f.context, validateRepositoryContext(other)], f.input.snapshot)).toThrow('overlapping path');
    const second = structuredClone(f.context.context); second.entries = [capturedSide('other.txt', 'x')];
    second.coverage = { ...second.coverage, selectedPaths: 1, capturedPaths: 1, capturedBytes: 1 };
    const contexts = [f.context, validateRepositoryContext(second)].sort((a,b) => b.digest.localeCompare(a.digest));
    expect(validateReviewRepositoryContexts(contexts, f.input.snapshot).map(v => v.digest)).toEqual(contexts.map(v => v.digest).sort());
    const copiedReceipt = { ...f.context, receipt: { kind: 'local-git-check' as const, checkedAt: '2026-10-02T00:00:00Z', repositoryPath: '/untrusted/copied', gitCommonDirectory: '/untrusted/copied/.git' } };
    expect(validateReviewRepositoryContexts([copiedReceipt], f.input.snapshot)).toEqual([f.context]);
    expect(buildSemanticReview({ ...f.input, repositoryContexts: [copiedReceipt], fixtures: f.fixtures }).repositoryContexts).toEqual([f.context]);
  });

  it('enforces aggregate captured-byte and selected-path limits across valid packages', () => {
    const f = contextReviewFixture();
    const packageOf = (entries: ReturnType<typeof capturedSide>[]) => validateRepositoryContext({ ...f.context.context, entries,
      coverage: { ...f.context.context.coverage, selectedPaths: entries.length, capturedPaths: entries.length, capturedBytes: entries.reduce((n,e) => n + e.byteLength, 0) } });
    const large = packageOf(Array.from({ length: 5 }, (_,i) => capturedSide(`large-${i}.txt`, 'x'.repeat(220_000))));
    expect(() => validateReviewRepositoryContexts([large], f.input.snapshot)).toThrow('aggregate path/byte');
    const first = packageOf(Array.from({ length: 65 }, (_,i) => capturedSide(`a-${String(i).padStart(3, '0')}.txt`, 'x')));
    const second = packageOf(Array.from({ length: 64 }, (_,i) => capturedSide(`b-${String(i).padStart(3, '0')}.txt`, 'x')));
    expect(() => validateReviewRepositoryContexts([first, second], f.input.snapshot)).toThrow('aggregate path/byte');
  });

  it.each(['missing', 'file', 'tree-blob'] as const)('rejects cross-package %s contradictions that individually validate', kind => {
    const f = contextReviewFixture();
    const child = capturedSide('dir/file.ts', 'x');
    const parent = kind === 'missing' ? { state: 'missing' as const, path: 'dir' } : kind === 'file' ? capturedSide('dir', 'regular file')
      : { state: 'excluded' as const, path: 'dir', mode: '040000' as const, objectId: child.objectId, reason: 'directory' as const, byteLength: null, sha256: null };
    const packageOf = (entry: typeof child | typeof parent) => validateRepositoryContext({ ...f.context.context, entries: [entry],
      coverage: { ...f.context.context.coverage, selectedPaths: 1, capturedPaths: entry.state === 'captured' ? 1 : 0,
        excludedPaths: entry.state === 'excluded' ? 1 : 0, missingPaths: entry.state === 'missing' ? 1 : 0, capturedBytes: entry.state === 'captured' ? entry.byteLength : 0 } });
    expect(() => validateReviewRepositoryContexts([packageOf(parent), packageOf(child)], f.input.snapshot)).toThrow('conflict');
  });

  it.each(['binary', 'size'] as const)('rejects contradictory cross-package %s declarations for one Git blob', kind => {
    const f = contextReviewFixture(), entry = capturedSide('a.txt', 'x');
    const packageOf = (entry: import('../src/repository-context.js').RepositoryContextEntry) => validateRepositoryContext({ ...f.context.context, entries: [entry],
      coverage: { ...f.context.context.coverage, selectedPaths: 1, capturedPaths: entry.state === 'captured' ? 1 : 0,
        excludedPaths: entry.state === 'excluded' ? 1 : 0, missingPaths: entry.state === 'missing' ? 1 : 0, capturedBytes: entry.state === 'captured' ? entry.byteLength : 0 } });
    const excluded = { state: 'excluded' as const, path: 'b.txt', objectId: entry.objectId, mode: '100644',
      reason: 'binary' as const, byteLength: kind === 'size' ? 2 : 1, sha256: entry.sha256 };
    expect(() => validateReviewRepositoryContexts([packageOf(entry), packageOf(excluded)], f.input.snapshot)).toThrow('Contradictory');
  });

  it.each(['context child', 'context parent', 'context missing parent', 'object contradiction'] as const)('rejects snapshot/context %s contradictions', kind => {
    const f = contextReviewFixture(), head = f.input.snapshot.snapshot.changes[0].after;
    if (head.state !== 'captured') throw new Error('Expected captured head');
    const entry = kind === 'context child' ? capturedSide('src/sample.ts/contract.ts', 'x')
      : kind === 'context parent' ? capturedSide('src', 'x') : kind === 'context missing parent' ? { state: 'missing' as const, path: 'src' }
      : { state: 'excluded' as const, path: 'elsewhere.ts', objectId: head.objectId, mode: '100644', reason: 'binary' as const, byteLength: head.byteLength, sha256: head.sha256 };
    const context = validateRepositoryContext({ ...f.context.context, entries: [entry],
      coverage: { ...f.context.context.coverage, selectedPaths: 1, capturedPaths: entry.state === 'captured' ? 1 : 0,
        excludedPaths: entry.state === 'excluded' ? 1 : 0, missingPaths: entry.state === 'missing' ? 1 : 0, capturedBytes: entry.state === 'captured' ? entry.byteLength : 0 } });
    expect(() => validateReviewRepositoryContexts([context], f.input.snapshot)).toThrow();
  });

  it('detects package/config tampering on rederivation even when review identity is recomputed', () => {
    const f = contextReviewFixture(), review = build(f);
    review.config.repositoryContextDigests = ['a'.repeat(64)];
    review.id = semanticReviewId(review.ruleDigest, review.snapshotDigest, review.config);
    expect(() => validateSemanticReview(review, f.input.rule, f.input.snapshot)).toThrow('configuration mismatch');
    const without = build(f); delete without.repositoryContexts;
    expect(() => validateSemanticReview(without, f.input.rule, f.input.snapshot)).toThrow('configuration mismatch');
  });
});
