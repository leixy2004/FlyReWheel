import { validateReviewRepositoryContexts, reviewRepositoryContextDigests } from '../semantic-review-context.js';
import { validateRepositoryContextEvidence, type StoredRepositoryContext } from '../repository-context.js';
import { digestOf } from '../core/identity.js';
import { type StoredChangeSnapshot } from '../change-snapshot.js';
import { sourceDigest, sourcePosition } from './candidates.js';
import { ReviewEvidenceSchema, ReviewFixtureSchema, SnapshotAnchorSchema, type ReviewEvidence, type ReviewFixture, type ReviewTarget, type SnapshotAnchor } from '../core/semantic-review.js';

/** Uses only immutable captured bytes; never opens a path or treats before/after as aliases. */
export function snapshotSource(snapshot: StoredChangeSnapshot, side: 'before' | 'after', path: string): string {
  const value = snapshot.snapshot.changes.map(change => change[side]).find(value => value.state !== 'absent' && value.path === path);
  if (!value || value.state !== 'captured') throw new Error(`Snapshot has no captured ${side} source at the requested path`);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(value.bytesBase64, 'base64'));
}
export function validateSnapshotAnchor(input: SnapshotAnchor, snapshot: StoredChangeSnapshot): string {
  const anchor = SnapshotAnchorSchema.parse(input);
  if (anchor.snapshotDigest !== snapshot.digest) throw new Error('Anchor belongs to another snapshot');
  const source = snapshotSource(snapshot, anchor.side, anchor.path);
  if (sourceDigest(source) !== anchor.sourceDigest) throw new Error('Anchor source digest mismatch');
  if (anchor.span.end.offset <= anchor.span.start.offset) throw new Error('Finding/evidence anchor must be nonempty');
  for (const side of ['start', 'end'] as const) {
    if (digestOf(sourcePosition(source, anchor.span[side].offset)) !== digestOf(anchor.span[side])) throw new Error('Anchor position does not match its exact source offset');
  }
  return source.slice(anchor.span.start.offset, anchor.span.end.offset);
}
export function makeSnapshotAnchor(snapshot: StoredChangeSnapshot, side: 'before' | 'after', path: string, start: number, end: number): SnapshotAnchor {
  const source = snapshotSource(snapshot, side, path);
  const anchor = { snapshotDigest: snapshot.digest, side, path, sourceDigest: sourceDigest(source), span: { start: sourcePosition(source, start), end: sourcePosition(source, end) } };
  validateSnapshotAnchor(anchor, snapshot);
  return anchor;
}
export function makeReviewEvidence(snapshot: StoredChangeSnapshot, anchor: SnapshotAnchor, kind: string): ReviewEvidence {
  const value = { kind, anchor, content: validateSnapshotAnchor(anchor, snapshot) };
  return ReviewEvidenceSchema.parse({ id: digestOf(value), ...value });
}

/** Explicit development fixtures, never a model verdict or independently established context. */
export function validateReviewFixtures(input: ReviewFixture, ruleDigest: string, snapshot: StoredChangeSnapshot, targets: ReviewTarget[], repositoryContexts?: readonly StoredRepositoryContext[]): ReviewFixture {
  const fixtures = ReviewFixtureSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(fixtures)) > 2_000_000) throw new Error('Review fixtures exceed 2MB');
  if (fixtures.ruleDigest !== ruleDigest || fixtures.snapshotDigest !== snapshot.digest) throw new Error('Fixtures do not bind to this exact rule and snapshot');
  if ((fixtures.schemaVersion === 3) !== (repositoryContexts !== undefined)) throw new Error('Repository context selection requires the context-aware fixture contract');
  const contexts = repositoryContexts === undefined ? [] : validateReviewRepositoryContexts(repositoryContexts, snapshot);
  if (fixtures.schemaVersion === 3 && digestOf(fixtures.repositoryContextDigests) !== digestOf(reviewRepositoryContextDigests(contexts))) throw new Error('Fixture repository context selection mismatch');
  const evidence = new Map(fixtures.evidence.map(item => [item.id, item]));
  for (const item of fixtures.evidence) {
    if ('kind' in item.anchor && item.anchor.kind === 'repository-context') {
      const contextDigest = item.anchor.contextDigest;
      const context = contexts.find(value => value.digest === contextDigest);
      if (!context) throw new Error('Fixture cites an unregistered repository context selection');
      validateRepositoryContextEvidence(item as import('../repository-context.js').RepositoryContextEvidence, context);
      continue;
    }
    const content = validateSnapshotAnchor(item.anchor as SnapshotAnchor, snapshot);
    if (content !== item.content || item.id !== digestOf({ kind: item.kind, anchor: item.anchor, content: item.content })) throw new Error('Fixture evidence identity/excerpt mismatch');
  }
  for (const judgment of fixtures.judgments) {
    const target = targets.find(value => value.id === judgment.targetId);
    if (!target || target.disposition !== 'captured') throw new Error('Fixture target is missing, out of scope or not captured');
    const declarations = 'anchorJudgments' in judgment ? [judgment, ...judgment.anchorJudgments] : [judgment];
    for (const declaration of declarations) {
      if (declaration.evidenceRefs.some(ref => !evidence.has(ref))) throw new Error('Fixture cites unavailable evidence');
      if (declaration.decision !== 'unknown' && !declaration.evidenceRefs.length) throw new Error('Decisive fixture decisions require cited snapshot evidence');
      if (fixtures.schemaVersion === 3 && declaration.decision !== 'unknown' && !declaration.evidenceRefs.some(ref => {
        const cited = evidence.get(ref)!;
        return 'side' in cited.anchor && cited.anchor.side === 'after' && cited.anchor.path === target.path && cited.anchor.sourceDigest === target.sourceDigest;
      })) throw new Error('Context-aware decisive judgments require cited after-side snapshot evidence from their own target');
    }
    const anchors = 'anchorJudgments' in judgment ? judgment.anchorJudgments.map(item => item.anchor) : judgment.findingAnchors;
    for (const anchor of anchors) {
      validateSnapshotAnchor(anchor, snapshot);
      if (anchor.side !== 'after' || anchor.path !== target.path || anchor.sourceDigest !== target.sourceDigest) throw new Error('Fixture finding must anchor to its exact captured after-side target');
    }
  }
  return fixtures;
}
