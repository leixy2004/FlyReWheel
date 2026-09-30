import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundleDigest, canonicalJson, digestOf, deriveVerdict, evaluateEvidence,
  FeedbackSchema, FindingSchema, type Feedback, type Finding, type ProblemCase,
  type PromotionPolicy, type RuleBundle,
} from '../src/core/index.js';
import { QualEvoStore, openPGliteDatabase, type Database } from '../src/storage/index.js';

const NOW = '2026-09-30T00:00:00Z';
const POLICY: PromotionPolicy = { minKnownCases: 2, minPositiveCases: 1, minNegativeCases: 1, minPrecision: 1, minRecall: 1, maxAbstentionRate: 0, minFeedbackLabels: 0 };
const CONFIG = digestOf({ detector: 'fixture', adjudicator: 'offline-fixture-v1' });
function problemCase(id: string, split: ProblemCase['split'] = 'training', expected: ProblemCase['expected'] = 'violation'): ProblemCase {
  return {
    id, lineageId: `lineage:${id}`, split, expected, title: `Synthetic ${id}`,
    repository: 'fixture://auth', commit: 'a'.repeat(40), path: `${id}.ts`, sourceDigest: digestOf(`synthetic source:${id}`),
    provenance: { kind: 'human', reference: `fixture:simulated-human-reviewed:${id}`, reviewedBy: 'human-reviewer', derivedFromCaseId: null },
  };
}
function bundle(version = '1', parentDigest: string | null = null): RuleBundle {
  return {
    schemaVersion: 1, ruleId: 'auth-before-read', version,
    skill: { title: 'Guard privileged reads', invariant: 'A privileged read requires authorization', applicability: ['Privileged route'], exceptions: ['Documented public route'], requiredContext: ['route-policy'] },
    detector: { kind: 'ast-grep', language: 'typescript', pattern: 'readSecret($ARG)' },
    regressionCases: [{ caseId: 'training-bug', role: 'positive' }],
    provenance: { sourceCaseIds: ['training-bug'], parentDigest, author: 'fixture-author', createdAt: NOW, rationale: 'Synthetic bug/fix learning case', evidenceRefs: ['fixture:training-bug'] },
  };
}
function feedback(finding: Finding, id: string, label: Feedback['label'] = null, kind: Feedback['kind'] = 'label'): Feedback {
  return { id, findingId: finding.id, bundleDigest: finding.bundleDigest, ruleVersion: finding.ruleVersion, actor: 'reviewer', source: 'human', kind, label, reason: 'Explicit review event', createdAt: NOW };
}
let db: Database;
let store: QualEvoStore;
let digest: string;
beforeEach(async () => {
  db = await openPGliteDatabase();
  store = await QualEvoStore.initialize(db);
  await store.importProblemCase(problemCase('training-bug'));
  digest = (await store.importBundle(bundle())).digest;
});
afterEach(async () => { await store.close(); });
async function findingFor(c: ProblemCase, state: Finding['candidateState'] = 'passed', bundleHash = digest): Promise<Finding> {
  const { bundle: currentBundle } = await store.getBundle(bundleHash);
  const run = await store.createRun({ key: `run:${c.id}:${bundleHash}`, repository: c.repository, commit: c.commit, bundleDigest: bundleHash, configDigest: CONFIG });
  const decision = state === 'passed' ? 'violation' : state === 'rejected' ? 'safe' : 'unknown';
  const finding: Finding = {
    id: `finding:${c.id}:${bundleHash}`, runId: run.id, bundleDigest: bundleHash, ruleId: currentBundle.ruleId, ruleVersion: currentBundle.version,
    sourceDigest: c.sourceDigest, location: { path: c.path, startLine: 1, endLine: 1 }, candidateState: state,
    execution: { state: state === 'execution_error' ? 'failed' : state === 'not_verified' ? 'not_run' : 'succeeded', error: state === 'execution_error' ? 'fixture execution failed' : null },
    adjudication: ['passed', 'rejected', 'abstained'].includes(state) ? { decision, source: 'agent', reasoning: 'Test record modeling an agent prediction', evidenceRefs: [`fixture:${c.id}`] } : null,
    evidenceRefs: [`fixture:${c.id}`],
  };
  return store.appendFinding(finding);
}
async function evaluation(id: string, bundleHash = digest, states: Finding['candidateState'][] = ['passed', 'rejected']) {
  const cases = [problemCase(`${id}-positive`, 'holdout'), problemCase(`${id}-negative`, 'holdout', 'safe')];
  const findings: Finding[] = [];
  for (let i = 0; i < cases.length; i++) {
    await store.importProblemCase(cases[i]);
    findings.push(await findingFor(cases[i], states[i], bundleHash));
  }
  await store.createEvaluation({ id, bundleDigest: bundleHash, datasetVersion: 'synthetic-v1', caseIds: cases.map(c => c.id), configDigest: CONFIG, createdAt: NOW }, findings.map((finding, i) => ({ caseId: cases[i].id, runId: finding.runId, findingId: finding.id })));
  return { cases, findings };
}

describe('immutable evidence in real embedded PostgreSQL', () => {

  it('retains immutable records across a local PostgreSQL restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flyrewheel-db-'));
    let disk: QualEvoStore | undefined;
    try {
      disk = await QualEvoStore.openPGlite(directory);
      await disk.importProblemCase(problemCase('training-bug'));
      const stored = await disk.importBundle(bundle());
      await disk.close();
      disk = await QualEvoStore.openPGlite(directory);
      expect(await disk.getBundle(stored.digest)).toEqual(stored);
      expect((await disk.importBundle(bundle())).digest).toBe(stored.digest);
    } finally {
      if (disk) await disk.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('imports are idempotent and logical versions reject changed content', async () => {
    expect((await store.importBundle(bundle())).digest).toBe(digest);
    const modified = bundle(); modified.skill.invariant = 'Changed invariant';
    await expect(store.importBundle(modified)).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    const v2 = bundle('2', digest); v2.skill.requiredContext.push('caller-context');
    const next = await store.importBundle(v2);
    expect(next.digest).not.toBe(digest);
    expect((await store.getBundle(next.digest)).bundle.provenance.parentDigest).toBe(digest);
    expect((await store.getBundle(digest)).bundle).toEqual(bundle());
    await expect(store.importBundle(bundle('3'))).rejects.toMatchObject({ code: 'INVALID_LINEAGE' });
  });
  it('same run key cannot silently change SHA, configuration or bundle', async () => {
    const identity = { key: 'event:42', repository: 'fixture://auth', commit: 'a'.repeat(40), bundleDigest: digest, configDigest: CONFIG };
    const first = await store.createRun(identity);
    expect(await store.createRun(identity)).toEqual(first);
    for (const change of [{ commit: 'b'.repeat(40) }, { configDigest: digestOf('new config') }]) {
      await expect(store.createRun({ ...identity, ...change })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
  });
  it('keeps no feedback, workflow actions and agent judgments out of human labels', async () => {
    const finding = await findingFor(problemCase('training-bug'));
    expect((await store.getFinding(finding.id)).verdict).toBe('Unknown');
    await store.appendFeedback(feedback(finding, 'resolve', null, 'resolve'));
    await store.appendFeedback(feedback(finding, 'merge', null, 'merge'));
    expect((await store.getFinding(finding.id)).verdict).toBe('Unknown');
    expect(() => FeedbackSchema.parse({ ...feedback(finding, 'fake-agent-label', 'TP'), source: 'agent' })).toThrow();
    await store.appendFeedback(feedback(finding, 'positive', 'TP'));
    expect((await store.getFinding(finding.id)).verdict).toBe('TP');
    await store.appendFeedback(feedback(finding, 'negative', 'FP'));
    expect((await store.getFinding(finding.id)).verdict).toBe('Disputed');
  });
  it('binds feedback to exact finding/version, is append-only and idempotent', async () => {
    const finding = await findingFor(problemCase('training-bug'));
    const label = feedback(finding, 'human:1', 'TP');
    await store.appendFeedback(label);
    expect(await store.appendFeedback(label)).toEqual(label);
    await expect(store.appendFeedback({ ...label, label: 'FP' })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
    await expect(store.appendFeedback({ ...label, id: 'wrong-version', ruleVersion: '2' })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    await expect(db.query("UPDATE qe_feedback SET payload='{}'::jsonb WHERE id=$1", [label.id])).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM qe_feedback WHERE id=$1', [label.id])).rejects.toThrow('append-only');
    expect((await store.getFinding(finding.id)).feedback).toHaveLength(1);
  });
  it('prevents lineage, copied-source and derived-case train/holdout leakage', async () => {
    const training = problemCase('training-bug');
    await expect(store.importProblemCase({ ...problemCase('same-family', 'holdout'), lineageId: training.lineageId })).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
    await expect(store.importProblemCase({ ...problemCase('same-bytes', 'holdout'), sourceDigest: training.sourceDigest })).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
    const derived = problemCase('renamed-family', 'holdout'); derived.provenance.derivedFromCaseId = training.id;
    await expect(store.importProblemCase(derived)).rejects.toMatchObject({ code: 'SPLIT_LEAKAGE' });
    const heldout = problemCase('heldout-authoring', 'holdout'); await store.importProblemCase(heldout);
    const contaminated = bundle('2', digest); contaminated.provenance.sourceCaseIds = [heldout.id];
    await expect(store.importBundle(contaminated)).rejects.toMatchObject({ code: 'HOLDOUT_CONTAMINATION' });
  });
});

describe('evaluation and promotion', () => {
  it('records frozen coverage and explicit metric denominators', async () => {
    await evaluation('good');
    const report = await store.evaluate('good', POLICY);
    expect(report.eligible).toBe(true);
    expect(report.evidenceKind).toBe('reviewed_cases');
    expect(report.metrics).toMatchObject({ knownCases: 2, positiveCases: 1, negativeCases: 1, truePositives: 1, falsePositives: 0, alertDenominator: 1, positiveDenominator: 1, precision: 1, recall: 1, feedbackLabeledCases: 0 });
    const saved = await store.getEvaluation('good');
    await expect(store.createEvaluation(saved.manifest, saved.results.slice(0, 1))).rejects.toMatchObject({ code: 'INCOMPLETE_EVALUATION' });
    await expect(store.createEvaluation(saved.manifest, [saved.results[0], saved.results[0]])).rejects.toMatchObject({ code: 'INCOMPLETE_EVALUATION' });
  });

  it('never uses synthetic cases or fixture responses to certify production', async () => {
    const { cases, findings } = await evaluation('synthetic-boundary');
    const realShape = cases.map((c, i) => ({ problemCase: c, finding: findings[i], feedback: [] }));
    const synthetic = realShape.map(item => ({ ...item, problemCase: { ...item.problemCase, provenance: { ...item.problemCase.provenance, kind: 'synthetic' as const } } }));
    const syntheticReport = evaluateEvidence(synthetic, POLICY);
    expect(syntheticReport.evidenceKind).toBe('synthetic_only');
    expect(syntheticReport.eligible).toBe(false);
    expect(syntheticReport.reasons).toContain('Synthetic cases cannot certify production promotion');
    const fixtureResponses = realShape.map(item => ({ ...item, finding: { ...item.finding, adjudication: { ...item.finding.adjudication!, source: 'fixture' as const } } }));
    const fixtureReport = evaluateEvidence(fixtureResponses, POLICY);
    expect(fixtureReport.eligible).toBe(false);
    expect(fixtureReport.reasons).toContain('Offline fixture adjudication cannot certify production promotion');
    const contradicted = realShape.map((item, i) => ({ ...item, feedback: i === 1 ? [feedback(item.finding, 'human-overrides-model-rejection', 'TP')] : [] }));
    expect(evaluateEvidence(contradicted, POLICY).reasons).toContain('Human finding feedback conflicts with the frozen case label');
  });
  it('counts not recalled and abstained positives in recall denominator', async () => {
    await evaluation('miss', digest, ['not_recalled', 'rejected']);
    const missing = await store.evaluate('miss', POLICY);
    expect(missing.metrics).toMatchObject({ falseNegatives: 1, positiveDenominator: 1, recall: 0 });
    expect(missing.eligible).toBe(false);
    await evaluation('unknown', digest, ['abstained', 'rejected']);
    const unknown = await store.evaluate('unknown', POLICY);
    expect(unknown.metrics).toMatchObject({ falseNegatives: 1, abstentions: 1, abstentionRate: 0.5 });
    expect(unknown.eligible).toBe(false);
  });
  it('blocks errors and training data regardless of superficially good metrics', async () => {
    await evaluation('error', digest, ['passed', 'execution_error']);
    expect((await store.evaluate('error', POLICY)).reasons).toContain('Execution errors prevent promotion');
    const c = problemCase('training-bug'); const finding = await findingFor(c);
    const report = evaluateEvidence([{ problemCase: c, finding, feedback: [] }], { ...POLICY, minKnownCases: 1 });
    expect(report.reasons).toContain('Only heldout cases may certify promotion');
    await expect(store.proposePromotion({ id: 'bad', ruleId: bundle().ruleId, bundleDigest: digest, evaluationId: 'error', expectedActiveDigest: null, policy: POLICY })).rejects.toMatchObject({ code: 'PROMOTION_BLOCKED' });
  });
  it('rejects mismatched bytes, commits and bundle configurations in replay', async () => {
    const c = problemCase('case-binding', 'holdout'); await store.importProblemCase(c);
    const f = await findingFor({ ...c, sourceDigest: digestOf('wrong bytes') });
    await expect(store.createEvaluation({ id: 'mismatched', bundleDigest: digest, datasetVersion: 'v1', caseIds: [c.id], configDigest: CONFIG, createdAt: NOW }, [{ caseId: c.id, runId: f.runId, findingId: f.id }])).rejects.toMatchObject({ code: 'CASE_MISMATCH' });
  });
  it('uses expected active digest CAS so stale approvals cannot overwrite newer versions', async () => {
    await evaluation('one');
    await store.proposePromotion({ id: 'first', ruleId: bundle().ruleId, bundleDigest: digest, evaluationId: 'one', expectedActiveDigest: null, policy: POLICY });
    const next = (await store.importBundle(bundle('2', digest))).digest;
    await evaluation('two', next);
    await store.proposePromotion({ id: 'stale', ruleId: bundle().ruleId, bundleDigest: next, evaluationId: 'two', expectedActiveDigest: null, policy: POLICY });
    const approved = await store.approvePromotion({ proposalId: 'first', expectedActiveDigest: null, actor: 'reviewer' });
    expect(await store.approvePromotion({ proposalId: 'first', expectedActiveDigest: null, actor: 'reviewer' })).toEqual(approved);
    await expect(store.approvePromotion({ proposalId: 'stale', expectedActiveDigest: null, actor: 'reviewer' })).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(await store.getActive(bundle().ruleId)).toBe(digest);
    await store.proposePromotion({ id: 'current', ruleId: bundle().ruleId, bundleDigest: next, evaluationId: 'two', expectedActiveDigest: digest, policy: POLICY });
    await expect(store.approvePromotion({ proposalId: 'current', expectedActiveDigest: null, actor: 'reviewer' })).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await store.approvePromotion({ proposalId: 'current', expectedActiveDigest: digest, actor: 'reviewer' });
    expect(await store.getActive(bundle().ruleId)).toBe(next);
  });

  it('permits only one of concurrent competing initial promotions', async () => {
    await evaluation('concurrent-one');
    const next = (await store.importBundle(bundle('2', digest))).digest;
    await evaluation('concurrent-two', next);
    await store.proposePromotion({ id: 'compete-one', ruleId: bundle().ruleId, bundleDigest: digest, evaluationId: 'concurrent-one', expectedActiveDigest: null, policy: POLICY });
    await store.proposePromotion({ id: 'compete-two', ruleId: bundle().ruleId, bundleDigest: next, evaluationId: 'concurrent-two', expectedActiveDigest: null, policy: POLICY });
    const outcomes = await Promise.allSettled([
      store.approvePromotion({ proposalId: 'compete-one', expectedActiveDigest: null, actor: 'alice' }),
      store.approvePromotion({ proposalId: 'compete-two', expectedActiveDigest: null, actor: 'bob' }),
    ]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
    const failed = outcomes.find(value => value.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'STALE_APPROVAL' });
  });
  it('unknown, unreviewed and copied cases cannot inflate confidence', async () => {
    const c = problemCase('training-bug'); const finding = await findingFor(c);
    const unreviewed = { ...c, split: 'holdout' as const, provenance: { ...c.provenance, reviewedBy: null } };
    expect(evaluateEvidence([{ problemCase: unreviewed, finding, feedback: [] }], POLICY).metrics.unknownLabelCases).toBe(1);
    const copied = { ...c, id: 'copied-case', split: 'holdout' as const };
    const report = evaluateEvidence([
      { problemCase: { ...c, split: 'holdout' }, finding, feedback: [] },
      { problemCase: copied, finding, feedback: [] },
    ], POLICY);
    expect(report.reasons).toContain('Duplicate source content cannot inflate evaluation denominators');
  });
  it('rejects an approval if feedback changed after proposal', async () => {
    const { findings } = await evaluation('feedback-race');
    await store.proposePromotion({ id: 'awaiting-review', ruleId: bundle().ruleId, bundleDigest: digest, evaluationId: 'feedback-race', expectedActiveDigest: null, policy: POLICY });
    await store.appendFeedback(feedback(findings[0], 'late-feedback', 'FP'));
    await expect(store.approvePromotion({ proposalId: 'awaiting-review', expectedActiveDigest: null, actor: 'reviewer' })).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(await store.getActive(bundle().ruleId)).toBeNull();
  });
});

describe('schema and identity contracts', () => {
  it('canonicalizes JSON property ordering without silently dropping values', () => {
    expect(digestOf({ b: 2, a: 1 })).toBe(digestOf({ a: 1, b: 2 }));
    expect(() => canonicalJson({ missing: undefined })).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(new Array(1))).toThrow();
    expect(bundleDigest(bundle())).toBe(digest);
  });
  it('rejects conflating execution success with adjudication success', async () => {
    const f = await findingFor(problemCase('training-bug'));
    expect(() => FindingSchema.parse({ ...f, candidateState: 'rejected' })).toThrow();
    expect(() => FindingSchema.parse({ ...f, execution: { state: 'failed', error: 'timeout' } })).toThrow();
    expect(deriveVerdict([])).toBe('Unknown');
    expect(deriveVerdict([feedback(f, 'unknown', 'Unknown')])).toBe('Unknown');
  });
});
