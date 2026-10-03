import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase, type Database } from '../src/storage/database.js';
import { DEFAULT_SNAPSHOT_LIMITS, validateChangeSnapshot } from '../src/change-snapshot.js';
import { digestOf } from '../src/core/identity.js';
import type { ProblemCase, RuleBundle } from '../src/core/model.js';
import type { SemanticRuleVersion } from '../src/core/semantic-rule.js';
import { reviewTargetId, type LocalReviewFeedback, type RevisionRequestInput, type ReviewFinding, type LegacyReviewFixture as ReviewFixture, type SemanticReview } from '../src/core/semantic-review.js';
import { makeSnapshotAnchor, makeReviewEvidence, snapshotSource } from '../src/adapters/semantic-review-fixture.js';
import { readAsset, semanticInputs } from './helpers/semantic-review-fixture.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { while (close.length) await close.pop()!(); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const head = '2'.repeat(40), base = '1'.repeat(40), date = '2026-10-01T00:00:00Z';
async function fixture(database?: Database, source = 'danger(one); danger(two);\n') {
  const db = database ?? await openPGliteDatabase();
  const store = await QualEvoStore.initialize(db);
  close.push(() => store.close());
  const problemCase: ProblemCase = {
    id: 'source-case', lineageId: 'source-lineage', split: 'training', expected: 'unknown', title: 'Authored local fixture',
    repository: 'fixture/repository', commit: head, path: 'src/input.ts', sourceDigest: sha(source),
    provenance: { kind: 'synthetic', reference: 'fixture:review-storage', reviewedBy: null, derivedFromCaseId: null },
  };
  const inputRule: SemanticRuleVersion = {
    schemaVersion: 2, ruleId: 'review-danger', version: 'base',
    semantics: { title: 'Review danger calls', mechanism: 'A danger call may lack a guard', invariant: 'Calls require a guard', applicability: ['Danger calls'], exceptions: [], requiredContext: [], expectedBehavior: 'Review contextual guards' },
    scope: { repositories: [problemCase.repository], paths: { include: ['src'], exclude: [] } },
    detectionAssets: [{ id: 'danger-hint', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'danger($ARG)' } }],
    regressionCases: [],
    provenance: { sourceCases: [{ caseId: problemCase.id, repository: problemCase.repository, commit: head, path: problemCase.path, sourceDigest: problemCase.sourceDigest }], parentDigest: null, author: 'fixture-author', createdAt: date, rationale: 'Storage contract fixture' },
  };
  const rule = await store.importRuleVersion(inputRule, [problemCase]);
  const bytes = Buffer.from(source);
  const snapshot = await store.importChangeSnapshot(validateChangeSnapshot({
    schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: problemCase.repository, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: base, mergeBase: base, head, comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    changes: [{ status: 'A', before: { state: 'absent' }, after: {
      state: 'captured', path: problemCase.path, mode: '100644', objectId: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      byteLength: bytes.length, sha256: sha(source), bytesBase64: bytes.toString('base64'),
    } }],
    coverage: { changedPaths: 1, capturedSides: 1, excludedSides: 0, capturedBytes: bytes.length, scope: 'changed-entries-only' },
  }).snapshot);
  const runInput = { ruleDigest: rule.digest, snapshotDigest: snapshot.digest };
  return { db, store, problemCase, inputRule, rule, snapshot, runInput };
}
function feedback(finding: ReviewFinding, id = 'feedback-1', overrides: Partial<LocalReviewFeedback> = {}): LocalReviewFeedback {
  return { id, findingId: finding.id, reviewId: finding.reviewId, ruleDigest: finding.ruleDigest, ruleVersion: finding.ruleVersion,
    source: 'fixture', actor: 'fixture-author', kind: 'label', label: 'TP', reason: 'Authored plumbing label', createdAt: date, ...overrides };
}
function request(baseRuleDigest: string, overrides: Partial<RevisionRequestInput> = {}): RevisionRequestInput {
  return { id: 'request-1', baseRuleDigest, requestedRuleVersion: 'next-authored-label', feedbackIds: ['feedback-1'],
    requestedChange: 'Consider the selected finding feedback when revising the invariant.', actor: 'fixture-author', source: 'fixture', createdAt: date, ...overrides };
}

it('atomically stores a complete review and exact finding index with immutable idempotent identities', async () => {
  const f = await fixture();
  const [first, same] = await Promise.all([f.store.runSemanticReview(f.runInput), f.store.runSemanticReview(f.runInput)]);
  expect(same).toEqual(first);
  expect(first.findings).toHaveLength(2);
  expect(first.coverage.snapshotVerification).toBe('package-integrity-only');
  expect(await f.store.getSemanticReview(first.id)).toEqual(first);
  for (const finding of first.findings) expect(await f.store.getReviewFinding(finding.id)).toEqual({ finding, feedback: [], verdict: 'Unknown', identityVerification: 'caller-declared-unverified' });
  expect(await f.store.listSemanticReviews({ ruleDigest: f.rule.digest, snapshotDigest: f.snapshot.digest })).toEqual([first]);
  const next = await f.store.runSemanticReview({ ...f.runInput, attempt: 'second' });
  expect(next.id).not.toBe(first.id);
  const ordered = [first, next].sort((a, b) => a.id.localeCompare(b.id));
  expect(await f.store.listSemanticReviews({ limit: 1 })).toEqual([ordered[0]]);
  expect(await f.store.listSemanticReviews({ after: ordered[0].id })).toEqual([ordered[1]]);
  expect(await f.store.listSemanticReviews({ after: ordered[1].id })).toEqual([]);
  expect(await f.store.listSemanticReviews({ ruleDigest: 'f'.repeat(64) })).toEqual([]);
  await expect(f.store.listSemanticReviews({ limit: 101 })).rejects.toThrow();
  await expect(f.store.getSemanticReview('review_' + 'f'.repeat(64))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(f.store.getReviewFinding('review_finding_' + 'f'.repeat(64))).rejects.toMatchObject({ code: 'NOT_FOUND' });
}, 30_000);

it('rolls back the parent and every indexed finding when insertion fails mid-review', async () => {
  const actual = await openPGliteDatabase();
  let failInsert = true, inserts = 0;
  const wrapped: Database = { ...actual, transaction: callback => actual.transaction(tx => callback({
    query: async (sql, params) => {
      if (sql.startsWith('INSERT INTO qe_semantic_review_findings') && ++inserts === 2 && failInsert) throw new Error('Injected finding-index write failure');
      return tx.query(sql, params);
    },
  })) };
  const f = await fixture(wrapped);
  await expect(f.store.runSemanticReview(f.runInput)).rejects.toThrow('Injected');
  expect((await actual.query('SELECT id FROM qe_semantic_reviews')).rows).toEqual([]);
  expect((await actual.query('SELECT id FROM qe_semantic_review_findings')).rows).toEqual([]);
  failInsert = false;
  expect((await f.store.runSemanticReview(f.runInput)).findings).toHaveLength(2);
}, 30_000);

it('keeps fixture feedback separate from declared-human verdicts and rejects stale or conflicting bindings', async () => {
  const f = await fixture();
  const review = await f.store.runSemanticReview(f.runInput), finding = review.findings[0]!;
  const fixtureLabel = feedback(finding);
  expect(await f.store.appendReviewFeedback(fixtureLabel)).toEqual(fixtureLabel);
  expect(await f.store.appendReviewFeedback(fixtureLabel)).toEqual(fixtureLabel);
  expect((await f.store.getReviewFinding(finding.id)).verdict).toBe('Unknown');
  await f.store.appendReviewFeedback(feedback(finding, 'resolve', { source: 'local-human-declared', kind: 'resolve', label: null }));
  await f.store.appendReviewFeedback(feedback(finding, 'merge', { source: 'local-human-declared', kind: 'merge', label: null }));
  await f.store.appendReviewFeedback(feedback(finding, 'note', { source: 'local-human-declared', kind: 'note', label: null }));
  expect((await f.store.getReviewFinding(finding.id)).verdict).toBe('Unknown');
  await f.store.appendReviewFeedback(feedback(finding, 'human-tp', { source: 'local-human-declared' }));
  expect((await f.store.getReviewFinding(finding.id)).verdict).toBe('TP');
  await f.store.appendReviewFeedback(feedback(finding, 'human-unknown', { source: 'local-human-declared', label: 'Unknown' }));
  expect((await f.store.getReviewFinding(finding.id)).verdict).toBe('Unknown');
  await f.store.appendReviewFeedback(feedback(finding, 'human-fp', { source: 'local-human-declared', label: 'FP' }));
  expect((await f.store.getReviewFinding(finding.id)).verdict).toBe('Disputed');
  await expect(f.store.appendReviewFeedback({ ...fixtureLabel, reason: 'Changed immutable content' })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  await expect(f.store.appendReviewFeedback(feedback(finding, 'wrong-version', { ruleVersion: 'other' }))).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
  await expect(f.store.appendReviewFeedback(feedback(finding, 'wrong-rule', { ruleDigest: 'f'.repeat(64) }))).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
  await expect(f.store.appendReviewFeedback(feedback(finding, 'wrong-review', { reviewId: 'review_' + 'f'.repeat(64) }))).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
  await expect(f.store.appendReviewFeedback(feedback(finding, 'bad-note', { kind: 'note', label: 'TP' }))).rejects.toThrow();
  const settled = await Promise.allSettled([
    f.store.appendReviewFeedback(feedback(finding, 'concurrent-feedback', { reason: 'one' })),
    f.store.appendReviewFeedback(feedback(finding, 'concurrent-feedback', { reason: 'two' })),
  ]);
  expect(settled.filter(v => v.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter(v => v.status === 'rejected')).toHaveLength(1);
}, 30_000);

it('pins exact selected feedback in pending requests without synthesizing or reserving a rule version', async () => {
  const f = await fixture();
  const review = await f.store.runSemanticReview(f.runInput), finding = review.findings[0]!;
  const firstFeedback = await f.store.appendReviewFeedback(feedback(finding));
  const originalRules = await f.store.listRuleVersions();
  const input = request(f.rule.digest);
  const [stored, same] = await Promise.all([f.store.createRevisionRequest(input), f.store.createRevisionRequest(input)]);
  expect(same).toEqual(stored);
  expect(stored.digest).toBe(digestOf(stored.request));
  expect(stored.request).toMatchObject({ status: 'pending', synthesis: 'not_run', baseRuleDigest: f.rule.digest, feedbackIds: [firstFeedback.id], feedbackBindings: [{ id: firstFeedback.id, digest: digestOf(firstFeedback) }] });
  await f.store.appendReviewFeedback(feedback(finding, 'later-human', { source: 'local-human-declared', label: 'FP' }));
  expect(await f.store.getRevisionRequest(stored.digest)).toEqual(stored);
  expect(await f.store.listRuleVersions()).toEqual(originalRules);
  expect(await f.store.listRevisionRequests(f.rule.digest)).toEqual([stored]);
  expect(await f.store.listRevisionRequests('f'.repeat(64))).toEqual([]);
  // A request does not reserve this target label: another request may independently name it.
  const second = await f.store.createRevisionRequest({ ...input, id: 'request-2' });
  expect(second.request.requestedRuleVersion).toBe(input.requestedRuleVersion);
  const childRule = { ...f.inputRule, version: input.requestedRuleVersion, provenance: { ...f.inputRule.provenance, parentDigest: f.rule.digest } };
  expect((await f.store.importRuleVersion(childRule)).rule.version).toBe(input.requestedRuleVersion);
  expect(await f.store.getRevisionRequest(stored.digest)).toEqual(stored);
  await expect(f.store.createRevisionRequest({ ...input, requestedChange: 'Mutated instructions' })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  await expect(f.store.createRevisionRequest({ ...input, id: 'same-version', requestedRuleVersion: f.inputRule.version })).rejects.toMatchObject({ code: 'INVALID_REVISION_REQUEST' });
  await expect(f.store.createRevisionRequest({ ...input, id: 'missing', feedbackIds: ['missing'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(f.store.createRevisionRequest({ ...input, id: 'duplicate', feedbackIds: [firstFeedback.id, firstFeedback.id] })).rejects.toThrow();
  const child = await f.store.importRuleVersion(childRule);
  await expect(f.store.createRevisionRequest({ ...input, id: 'cross-version', baseRuleDigest: child.digest, requestedRuleVersion: 'another' })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
  expect((await f.store.listRevisionRequests()).map(v => v.request.id).sort()).toEqual(['request-1', 'request-2']);
  await expect(f.store.getRevisionRequest('f'.repeat(64))).rejects.toMatchObject({ code: 'NOT_FOUND' });
}, 30_000);

it('keeps the v2 review path and legacy v1 execution path explicitly separate', async () => {
  const f = await fixture();
  const v1: RuleBundle = { schemaVersion: 1, ruleId: 'legacy', version: '1', skill: { title: 'Legacy', invariant: 'Legacy invariant', applicability: ['Calls'], exceptions: [], requiredContext: [] },
    detector: { kind: 'ast-grep', language: 'typescript', pattern: 'danger($ARG)' }, regressionCases: [{ caseId: f.problemCase.id, role: 'positive' }],
    provenance: { sourceCaseIds: [f.problemCase.id], parentDigest: null, author: 'fixture', createdAt: date, rationale: 'Fixture', evidenceRefs: ['fixture'] } };
  const legacy = await f.store.importBundle(v1);
  await expect(f.store.runSemanticReview({ ...f.runInput, ruleDigest: legacy.digest })).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
  await expect(f.store.createRevisionRequest(request(legacy.digest))).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
  await expect(f.store.createRun({ key: 'wrong-path', repository: f.problemCase.repository, commit: head, bundleDigest: f.rule.digest, configDigest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
  await expect(f.store.getBundle(f.rule.digest)).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
  expect((await f.store.createRun({ key: 'legacy-still-works', repository: f.problemCase.repository, commit: head, bundleDigest: legacy.digest, configDigest: 'a'.repeat(64) })).identity.bundleDigest).toBe(legacy.digest);
}, 30_000);

it('enforces append-only SQL and exact foreign-key identity bindings', async () => {
  const f = await fixture();
  const review = await f.store.runSemanticReview(f.runInput), finding = review.findings[0]!;
  await f.store.appendReviewFeedback(feedback(finding));
  await f.store.createRevisionRequest(request(f.rule.digest));
  for (const table of ['qe_semantic_reviews', 'qe_semantic_review_findings', 'qe_semantic_review_feedback', 'qe_rule_revision_requests']) {
    await expect(f.db.query(`UPDATE ${table} SET payload=payload`)).rejects.toThrow('append-only');
    await expect(f.db.query(`DELETE FROM ${table}`)).rejects.toThrow('append-only');
  }
  await expect(f.db.query('INSERT INTO qe_semantic_review_feedback(id,finding_id,review_id,rule_digest,rule_version,payload_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
    ['forged-fk', finding.id, review.id, f.rule.digest, 'wrong-version', 'a'.repeat(64), '{}'])).rejects.toThrow();
  await expect(f.db.query('INSERT INTO qe_semantic_review_findings(id,review_id,rule_digest,snapshot_digest,rule_id,rule_version,payload_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    ['forged-finding', review.id, f.rule.digest, 'f'.repeat(64), f.inputRule.ruleId, f.inputRule.version, 'a'.repeat(64), '{}'])).rejects.toThrow();
}, 30_000);

it('revalidates stored review hashes, exact index members and parent snapshot integrity on reads', async () => {
  const f = await fixture();
  const review = await f.store.runSemanticReview(f.runInput), finding = review.findings[0]!;
  await f.db.exec('ALTER TABLE qe_semantic_reviews DISABLE TRIGGER qe_semantic_reviews_immutable');
  await f.db.query('UPDATE qe_semantic_reviews SET payload_digest=$1 WHERE id=$2', ['f'.repeat(64), review.id]);
  await expect(f.store.getSemanticReview(review.id)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.listSemanticReviews()).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.db.query('UPDATE qe_semantic_reviews SET payload_digest=$1 WHERE id=$2', [digestOf(review), review.id]);
  await f.db.exec('ALTER TABLE qe_semantic_review_findings DISABLE TRIGGER qe_semantic_review_findings_immutable');
  const forged = { ...finding, reasoning: 'Forged indexed member' };
  await f.db.query('UPDATE qe_semantic_review_findings SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(forged), digestOf(forged), finding.id]);
  await expect(f.store.getReviewFinding(finding.id)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.getSemanticReview(review.id)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.db.query('UPDATE qe_semantic_review_findings SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(finding), digestOf(finding), finding.id]);
  await f.db.exec('ALTER TABLE qe_change_snapshots DISABLE TRIGGER qe_change_snapshots_immutable');
  await f.db.query('UPDATE qe_change_snapshots SET repository_id=$1 WHERE digest=$2', ['wrong-repository', f.snapshot.digest]);
  await expect(f.store.getSemanticReview(review.id)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
}, 30_000);

it('rejects corrupted feedback and revision payloads rather than deriving a verdict or accepting changed selection', async () => {
  const f = await fixture();
  const review = await f.store.runSemanticReview(f.runInput), finding = review.findings[0]!;
  const label = await f.store.appendReviewFeedback(feedback(finding));
  const saved = await f.store.createRevisionRequest(request(f.rule.digest));
  await f.db.exec('ALTER TABLE qe_semantic_review_feedback DISABLE TRIGGER qe_semantic_review_feedback_immutable');
  await f.db.query('UPDATE qe_semantic_review_feedback SET payload_digest=$1 WHERE id=$2', ['f'.repeat(64), label.id]);
  await expect(f.store.getReviewFinding(finding.id)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.getRevisionRequest(saved.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.db.query('UPDATE qe_semantic_review_feedback SET payload_digest=$1 WHERE id=$2', [digestOf(label), label.id]);
  await f.db.exec('ALTER TABLE qe_rule_revision_requests DISABLE TRIGGER qe_rule_revision_requests_immutable');
  await f.db.query('UPDATE qe_rule_revision_requests SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify({ ...saved.request, requestedChange: 'Tampered request instructions' }), saved.digest]);
  await expect(f.store.getRevisionRequest(saved.digest)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(f.store.listRevisionRequests()).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
}, 30_000);

async function fixtureWithAnchoredJudgment() {
  const input = semanticInputs({ assets: [readAsset] });
  const db = await openPGliteDatabase(), store = await QualEvoStore.initialize(db);
  close.push(() => store.close());
  await store.importRuleVersion(input.rule.rule, [input.problemCase]);
  await store.importChangeSnapshot(input.snapshot.snapshot);
  const path = 'src/sample.ts', source = snapshotSource(input.snapshot, 'after', path), start = source.indexOf('dangerousRead()');
  const anchor = makeSnapshotAnchor(input.snapshot, 'after', path, start, start + 'dangerousRead()'.length);
  const evidence = makeReviewEvidence(input.snapshot, makeSnapshotAnchor(input.snapshot, 'after', path, 0, source.length), 'local-policy');
  const fixtures: ReviewFixture = {
    schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: input.rule.digest, snapshotDigest: input.snapshot.digest, evidence: [evidence],
    judgments: [{ targetId: reviewTargetId(input.rule.digest, input.snapshot.digest, 0, path, anchor.sourceDigest), decision: 'violation', reasoning: 'Authored synthetic plumbing judgment', evidenceRefs: [evidence.id], findingAnchors: [anchor] }],
  };
  return { db, store, input, path, anchor, fixtures, runInput: { ruleDigest: input.rule.digest, snapshotDigest: input.snapshot.digest } };
}

it('rejects caller-injected review results and cross-boundary fixtures before any public-store write', async () => {
  const f = await fixtureWithAnchoredJudgment();
  for (const forgedFields of [{ id: 'review_' + 'f'.repeat(64) }, { findings: [] }, { result: { status: 'safe' } }, { config: { fixtureDigest: 'f'.repeat(64) } }]) {
    await expect(f.store.runSemanticReview({ ...f.runInput, ...forgedFields })).rejects.toThrow();
  }
  const beforeSource = snapshotSource(f.input.snapshot, 'before', f.path);
  const beforeAnchor = makeSnapshotAnchor(f.input.snapshot, 'before', f.path, 0, beforeSource.length);
  const wrongRuleTarget = reviewTargetId('f'.repeat(64), f.input.snapshot.digest, 0, f.path, f.anchor.sourceDigest);
  const wrongSnapshotTarget = reviewTargetId(f.input.rule.digest, 'f'.repeat(64), 0, f.path, f.anchor.sourceDigest);
  const variants: ReviewFixture[] = [];
  let malformed = structuredClone(f.fixtures);
  malformed.judgments[0].findingAnchors = [beforeAnchor]; variants.push(malformed);
  malformed = structuredClone(f.fixtures);
  malformed.judgments[0].targetId = wrongRuleTarget; variants.push(malformed);
  malformed = structuredClone(f.fixtures);
  malformed.judgments[0].targetId = wrongSnapshotTarget; variants.push(malformed);
  malformed = structuredClone(f.fixtures);
  malformed.ruleDigest = 'f'.repeat(64); variants.push(malformed);
  malformed = structuredClone(f.fixtures);
  malformed.snapshotDigest = 'f'.repeat(64); variants.push(malformed);
  malformed = structuredClone(f.fixtures);
  malformed.judgments[0].findingAnchors[0].snapshotDigest = 'f'.repeat(64); variants.push(malformed);
  malformed = structuredClone(f.fixtures);
  malformed.judgments[0].findingAnchors[0].span.start.column++; variants.push(malformed);
  for (const fixtures of variants) await expect(f.store.runSemanticReview({ ...f.runInput, fixtures })).rejects.toThrow();
  expect(await f.store.listSemanticReviews()).toEqual([]);
  expect((await f.db.query('SELECT id FROM qe_semantic_review_findings')).rows).toEqual([]);
  const valid = await f.store.runSemanticReview({ ...f.runInput, fixtures: f.fixtures });
  expect(valid.findings).toHaveLength(1);
  expect(valid.findings[0]).toMatchObject({ status: 'violation', anchor: { side: 'after' } });
  expect((await f.store.getReviewFinding(valid.findings[0].id)).verdict).toBe('Unknown');
  expect((await f.db.query<{ payload: ReviewFinding }>('SELECT payload FROM qe_semantic_review_findings')).rows.every(row => row.payload.anchor.side === 'after')).toBe(true);
}, 30_000);

it('rejects fixture, config and anchor tampering on stored reads even after recomputing the outer payload hash', async () => {
  const f = await fixtureWithAnchoredJudgment();
  const review = await f.store.runSemanticReview({ ...f.runInput, fixtures: f.fixtures });
  const findingId = review.findings[0].id;
  await f.db.exec('ALTER TABLE qe_semantic_reviews DISABLE TRIGGER qe_semantic_reviews_immutable');
  const mutations: ((value: SemanticReview) => void)[] = [
    value => { value.fixtures!.judgments[0].reasoning = 'Rewritten fixture while retaining the original fixture digest'; },
    value => { value.config.fixtureDigest = 'f'.repeat(64); },
    value => { value.occurrences[0].anchor.span.start.column++; },
    value => { value.findings[0].anchor.side = 'before'; },
    value => { value.id = 'review_' + 'f'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const tampered = structuredClone(review); mutate(tampered);
    await f.db.query('UPDATE qe_semantic_reviews SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(tampered), digestOf(tampered), review.id]);
    await expect(f.store.getSemanticReview(review.id)).rejects.toThrow();
    await expect(f.store.getReviewFinding(findingId)).rejects.toThrow();
    await expect(f.store.listSemanticReviews()).rejects.toThrow();
  }
  await f.db.query('UPDATE qe_semantic_reviews SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(review), digestOf(review), review.id]);
  expect(await f.store.getSemanticReview(review.id)).toEqual(review);
  expect((await f.store.getReviewFinding(findingId)).finding.anchor.side).toBe('after');
}, 30_000);

it('rejects impossible stored asset coverage even with the original review ID and recomputed payload hash', async () => {
  const input = semanticInputs({ assets: [
    { id: 'semgrep', detector: { kind: 'semgrep', language: 'typescript', yaml: 'rules: []' } },
    { id: 'opengrep', detector: { kind: 'opengrep', language: 'typescript', yaml: 'rules: []' } },
    { ...readAsset, id: 'unknown', detector: { ...readAsset.detector, language: 'ruby' } },
    { ...readAsset, id: 'mismatch', detector: { ...readAsset.detector, language: 'python' } },
  ] });
  const db = await openPGliteDatabase(), store = await QualEvoStore.initialize(db);
  close.push(() => store.close());
  await store.importRuleVersion(input.rule.rule, [input.problemCase]);
  await store.importChangeSnapshot(input.snapshot.snapshot);
  const review = await store.runSemanticReview({ ruleDigest: input.rule.digest, snapshotDigest: input.snapshot.digest });
  expect(review.coverage.targets[0].scans.map(scan => scan.state)).toEqual(['unsupported_engine', 'unsupported_engine', 'unsupported_language', 'language_mismatch']);
  expect(review.occurrences).toEqual([]); expect(review.findings).toEqual([]);
  expect(await store.getSemanticReview(review.id)).toEqual(review);
  // Simulate out-of-band corruption in this disposable test DB, not a public result-write API.
  await db.exec('ALTER TABLE qe_semantic_reviews DISABLE TRIGGER qe_semantic_reviews_immutable');
  for (let index = 0; index < review.coverage.targets[0].scans.length; index++) {
    const tampered = structuredClone(review);
    Object.assign(tampered.coverage.targets[0].scans[index], { state: 'scanned', candidateCount: 0, reason: null });
    expect(tampered.id).toBe(review.id); expect(digestOf(tampered)).not.toBe(digestOf(review));
    await db.query('UPDATE qe_semantic_reviews SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(tampered), digestOf(tampered), review.id]);
    await expect(store.getSemanticReview(review.id)).rejects.toThrow('eligibility');
    await expect(store.listSemanticReviews()).rejects.toThrow('eligibility');
  }
  await db.query('UPDATE qe_semantic_reviews SET payload=$1::jsonb,payload_digest=$2 WHERE id=$3', [JSON.stringify(review), digestOf(review), review.id]);
  expect(await store.getSemanticReview(review.id)).toEqual(review);
  expect(await store.listSemanticReviews()).toEqual([review]);
}, 30_000);
