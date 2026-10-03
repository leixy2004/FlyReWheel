import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import type { ReviewFixture } from '../src/core/semantic-review.js';
import { buildSemanticReview } from '../src/semantic-review.js';
import { makeRepositoryContextAnchor, makeRepositoryContextEvidence, validateRepositoryContext } from '../src/repository-context.js';
import { makeReviewEvidence, makeSnapshotAnchor, snapshotSource } from '../src/adapters/semantic-review-fixture.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase } from '../src/storage/database.js';
import { readAsset, semanticInputs } from './helpers/semantic-review-fixture.js';
import { reviewContextRecord } from './helpers/review-context-record.js';
import { revisionComparisonFixture, revisionDecision } from './helpers/revision-comparison-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'review-context-storage-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const db = await openPGliteDatabase(join(directory, 'db')), store = await QualEvoStore.initialize(db);
  let open = true;
  const close = async () => { if (open) { open = false; await store.close(); } };
  cleanup.push(close);
  const inputs = semanticInputs({ assets: [readAsset] });
  const rule = await store.importRuleVersion(inputs.rule.rule, [inputs.problemCase]);
  const snapshot = await store.importChangeSnapshot(inputs.snapshot.snapshot);
  const context = await store.importRepositoryContext(reviewContextRecord(snapshot).context);
  const target = buildSemanticReview({ rule, snapshot }).coverage.targets[0];
  const source = snapshotSource(snapshot, 'after', target.path), start = source.indexOf('dangerousRead()');
  const anchor = makeSnapshotAnchor(snapshot, 'after', target.path, start, start + 'dangerousRead()'.length);
  const evidence = makeRepositoryContextEvidence(context, makeRepositoryContextAnchor(context, 'policy.md', 0, 26), 'local-policy');
  const sourceEvidence = makeReviewEvidence(snapshot, anchor, 'changed-source'), evidenceRefs = [sourceEvidence.id, evidence.id];
  const fixtures: ReviewFixture = { schemaVersion: 3, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest,
    snapshotDigest: snapshot.digest, repositoryContextDigests: [context.digest], evidence: [sourceEvidence, evidence],
    judgments: [{ targetId: target.id, decision: 'violation', reasoning: 'Authored policy-backed judgment', evidenceRefs, missingContext: [],
      anchorJudgments: [{ anchor, decision: 'violation', reasoning: 'Authored policy-backed anchor', evidenceRefs, missingContext: [] }] }] };
  const input = { ruleDigest: rule.digest, snapshotDigest: snapshot.digest, repositoryContextDigests: [context.digest], fixtures };
  return { directory, db, store, close, rule, snapshot, context, fixtures, input };
}

it('persists exact selected packages and context citations, preserving identities after reopen without Git', async () => {
  const f = await fixture(), review = await f.store.runSemanticReview(f.input);
  expect(review.config).toMatchObject({ runtime: 'semantic-snapshot-review-v3', repositoryContextDigests: [f.context.digest] });
  expect(review.repositoryContexts).toEqual([f.context]);
  expect(review.findings).toHaveLength(1); expect(review.findings[0].status).toBe('violation');
  expect(review.coverage).toMatchObject({ repositoryContext: 'incomplete', introduction: 'unverified', snapshotVerification: 'package-integrity-only' });
  expect(review.notification).toBe('not_performed');
  expect(await f.store.runSemanticReview(f.input)).toEqual(review);
  expect(await f.store.getReviewFinding(review.findings[0].id)).toMatchObject({ finding: review.findings[0], verdict: 'Unknown' });
  const legacy = await f.store.runSemanticReview({ ruleDigest: f.rule.digest, snapshotDigest: f.snapshot.digest });
  expect(legacy).not.toHaveProperty('repositoryContexts'); expect(legacy.config).not.toHaveProperty('repositoryContextDigests');
  expect(legacy.id).not.toBe(review.id);
  await f.close();
  const reopened = await QualEvoStore.openPGlite(join(f.directory, 'db')); cleanup.push(() => reopened.close());
  expect(await reopened.getSemanticReview(review.id)).toEqual(review);
  expect(await reopened.listSemanticReviews({ ruleDigest: f.rule.digest })).toContainEqual(review);
}, 30_000);

it('rejects unregistered, mismatched, duplicate, empty and noncanonical context selections before persistence', async () => {
  const f = await fixture();
  const run = (repositoryContextDigests: string[]) => f.store.runSemanticReview({ ruleDigest: f.rule.digest, snapshotDigest: f.snapshot.digest, repositoryContextDigests });
  for (const digests of [[], [f.context.digest, f.context.digest], ['b'.repeat(64), 'a'.repeat(64)], Array.from({ length: 9 }, (_, i) => i.toString().repeat(64))]) {
    await expect(run(digests)).rejects.toThrow();
  }
  await expect(run(['f'.repeat(64)])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const wrong = await f.store.importRepositoryContext({ ...f.context.context, head: '3'.repeat(40) });
  await expect(run([wrong.digest])).rejects.toThrow(/exact snapshot repository and review head/);
  await expect(f.store.runSemanticReview({ ruleDigest: f.rule.digest, snapshotDigest: f.snapshot.digest, fixtures: f.fixtures })).rejects.toThrow();
  const alternate = await f.store.importRepositoryContext(reviewContextRecord(f.snapshot, 'An alternate policy.\n').context);
  await expect(f.store.runSemanticReview({ ...f.input, repositoryContextDigests: [alternate.digest] })).rejects.toThrow();
  expect(await f.store.listSemanticReviews()).toEqual([]);
}, 30_000);

it('revalidates registered context identity on every read and rolls back a save if the package is absent', async () => {
  const f = await fixture(), review = await f.store.runSemanticReview(f.input);
  const rollback = new Error('Rollback authored corruption');
  await expect(f.db.transaction(async tx => {
    await tx.query('ALTER TABLE qe_repository_contexts DISABLE TRIGGER qe_repository_contexts_immutable');
    const scoped = await QualEvoStore.initialize({ query: tx.query.bind(tx), transaction: operation => operation(tx), migrationTransaction: operation => operation(tx), exec: async () => {}, close: async () => {} });
    await tx.query('UPDATE qe_repository_contexts SET head_sha=$1 WHERE digest=$2', ['f'.repeat(40), f.context.digest]);
    await expect(scoped.getSemanticReview(review.id)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
    await tx.query('DELETE FROM qe_repository_contexts WHERE digest=$1', [f.context.digest]);
    await expect(scoped.getSemanticReview(review.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Exercise the same private persistence boundary used by both authorized
    // builders, after validation but without a registered dependency.
    const missing = buildSemanticReview({ rule: f.rule, snapshot: f.snapshot, repositoryContexts: [f.context], attempt: 'not-registered' });
    const persist = scoped as unknown as { saveSemanticReview(review: typeof missing): Promise<unknown> };
    await expect(persist.saveSemanticReview(missing)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await tx.query('SELECT id FROM qe_semantic_reviews WHERE id=$1', [missing.id])).rows).toEqual([]);
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await f.store.getSemanticReview(review.id)).toEqual(review);
}, 30_000);

it.each(['captured', 'excluded'] as const)('blocks comparison holdout leakage from an uncited %s context entry', async state => {
  const f = await revisionComparisonFixture(); cleanup.push(() => f.store.close());
  let context = reviewContextRecord(f.snapshot, 'Authored heldout policy text.\n');
  const entry = context.context.entries[0];
  if (entry.state !== 'captured') throw new Error('Expected captured fixture');
  if (state === 'excluded') {
    const { bytesBase64: _bytes, ...identity } = entry;
    context = validateRepositoryContext({ ...context.context, entries: [{ ...identity, state: 'excluded', reason: 'binary' }],
      coverage: { ...context.context.coverage, capturedPaths: 0, excludedPaths: 1, capturedBytes: 0 } });
  }
  await f.store.importRepositoryContext(context.context);
  await f.store.importProblemCase({ ...f.cases[0], id: `heldout-${state}`, lineageId: `heldout-${state}`, split: 'holdout',
    path: entry.path, sourceDigest: entry.sha256 });
  const reviews = await Promise.all([f.baseRule, f.candidateRule].map(rule => f.store.runSemanticReview({ ruleDigest: rule.digest,
    snapshotDigest: f.snapshot.digest, repositoryContextDigests: [context.digest] })));
  await expect(f.store.createRevisionComparison({ ...f.input, reviewPairs: [{ baseReviewId: reviews[0].id, candidateReviewId: reviews[1].id }] }))
    .rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  expect(await f.store.listRevisionComparisons()).toEqual([]);
}, 30_000);

it('stores and rederives context-aware comparisons with exact selections and permits an explicit local compatible decision', async () => {
  const f = await revisionComparisonFixture(); cleanup.push(() => f.store.close());
  const context = await f.store.importRepositoryContext(reviewContextRecord(f.snapshot).context);
  const reviews = await Promise.all(([['base', f.baseRule], ['candidate', f.candidateRule]] as const).map(async ([side, rule]) => {
    const legacy = f.fixtures(rule, side);
    const fixtures: ReviewFixture = { ...legacy, schemaVersion: 3, repositoryContextDigests: [context.digest],
      judgments: legacy.judgments.map(({ findingAnchors, ...judgment }) => ({ ...judgment, missingContext: [],
        anchorJudgments: findingAnchors.map(anchor => ({ anchor, decision: judgment.decision, reasoning: judgment.reasoning,
          evidenceRefs: judgment.evidenceRefs, missingContext: [] })) })) };
    return f.store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: f.snapshot.digest,
      repositoryContextDigests: [context.digest], fixtures });
  }));
  const finding = reviews[0].findings.find(value => digestOf(value.anchor) === digestOf(f.finding.anchor))!;
  const feedback = await f.store.appendReviewFeedback({ ...f.feedback, id: 'selected-context-feedback', reviewId: reviews[0].id, findingId: finding.id });
  const request = await f.store.createRevisionRequest({ id: 'selected-context-request', baseRuleDigest: f.baseRule.digest,
    requestedRuleVersion: f.candidateRule.rule.version, feedbackIds: [feedback.id], requestedChange: 'Compare the same selected context packages',
    actor: feedback.actor, source: feedback.source, createdAt: feedback.createdAt });
  const result = await f.store.createRevisionComparison({ ...f.input, id: 'context-comparison', requestDigest: request.digest,
    reviewPairs: [{ baseReviewId: reviews[0].id, candidateReviewId: reviews[1].id }],
    caseBindings: f.input.caseBindings.map(value => ({ ...value, baseReviewId: reviews[0].id })) });
  expect(result.comparison).toMatchObject({ scorer: 'per-anchor-context-v4', summary: { status: 'compatible' },
    reviewBindings: [{ repositoryContextDigests: [context.digest] }], feedback: [{ repositoryContextDigests: [context.digest] }] });
  expect(await f.store.getRevisionComparison(result.digest)).toEqual(result);
  expect((await f.store.recordRevisionDecision(revisionDecision(result.digest))).decision.choice).toBe('accept');
  expect(await f.store.getActive(f.baseRule.rule.ruleId)).toBeNull();
}, 30_000);
