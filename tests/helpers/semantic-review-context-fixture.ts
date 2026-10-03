import { semanticInputs, capturedSide } from './semantic-review-fixture.js';
import { validateRepositoryContext, makeRepositoryContextAnchor, makeRepositoryContextEvidence, DEFAULT_REPOSITORY_CONTEXT_LIMITS } from '../../src/repository-context.js';
import { makeSnapshotAnchor, makeReviewEvidence, snapshotSource } from '../../src/adapters/semantic-review-fixture.js';
import { buildSemanticReview } from '../../src/semantic-review.js';
import type { ContextReviewFixture } from '../../src/core/semantic-review.js';

export function contextReviewFixture() {
  const input = semanticInputs({ after: 'export function privateRead() { dangerousRead(); }\nexport function publicRead() { dangerousRead(); }\n', requiredContext: ['callee-contract', 'test'] });
  const contract = 'Public reads are allowed. Private reads require a preceding authorization guard.\n';
  const test = 'An authored contract test declares publicRead exempt and privateRead guarded.\n';
  const entries = [capturedSide('contracts/read.txt', contract), capturedSide('tests/read.txt', test)];
  const context = validateRepositoryContext({ schemaVersion: 1, kind: 'git-repository-context', repository: input.snapshot.snapshot.repository,
    head: input.snapshot.snapshot.head, selection: 'explicit-paths-at-head', limits: DEFAULT_REPOSITORY_CONTEXT_LIMITS, entries,
    coverage: { selectedPaths: 2, capturedPaths: 2, excludedPaths: 0, missingPaths: 0, capturedBytes: entries.reduce((sum, e) => sum + e.byteLength, 0), scope: 'selected-paths-only', historicalAvailability: 'unproven' } });
  const target = buildSemanticReview(input).coverage.targets[0], source = snapshotSource(input.snapshot, 'after', target.path);
  const anchors = [...source.matchAll(/dangerousRead\(\)/g)].map(match => makeSnapshotAnchor(input.snapshot, 'after', target.path, match.index, match.index + match[0].length));
  const sourceEvidence = anchors.map(anchor => makeReviewEvidence(input.snapshot, anchor, 'source'));
  const contextEvidence = entries.map((entry, i) => makeRepositoryContextEvidence(context,
    makeRepositoryContextAnchor(context, entry.path, 0, i === 0 ? contract.length : test.length), i === 0 ? 'callee-contract' : 'test'));
  const fixtures: ContextReviewFixture = { schemaVersion: 3, kind: 'semantic-review-offline-fixtures', ruleDigest: input.rule.digest,
    snapshotDigest: input.snapshot.digest, repositoryContextDigests: [context.digest], evidence: [...sourceEvidence, ...contextEvidence],
    judgments: [{ targetId: target.id, decision: 'violation', reasoning: 'Authored fixture declares the private read violating and the public read exempt.',
      evidenceRefs: [sourceEvidence[0].id, ...contextEvidence.map(item => item.id)], missingContext: [],
      anchorJudgments: anchors.map((anchor, i) => ({ anchor, decision: i === 0 ? 'violation' : 'safe', reasoning: 'Authored same-file contract-based decision, not semantic ground truth.',
        evidenceRefs: [sourceEvidence[i].id, ...contextEvidence.map(item => item.id)], missingContext: [] })) }] };
  return { input, context, fixtures, anchors, sourceEvidence, contextEvidence, target };
}
