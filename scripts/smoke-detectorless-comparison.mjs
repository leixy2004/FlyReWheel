// Compiled, offline application/store/CLI smoke; authored semantics only.
// Run after npm run build. No network, credentials, model, or target code runs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QualEvoStore } from '../dist/storage/store.js';
import { runRevisionComparisonDemo } from '../dist/revision-demo.js';
import { reviewTargetId } from '../dist/core/semantic-review.js';

const root = await mkdtemp(join(tmpdir(), 'detectorless-comparison-smoke-')), db = join(root, 'db');
let store;
try {
  store = await QualEvoStore.openPGlite(db);
  const demo = await runRevisionComparisonDemo(store);
  assert.equal(demo.compatible.comparison.comparison.summary.status, 'compatible');
  assert.equal(demo.regressed.comparison.comparison.summary.status, 'regressed');
  const originalBase = await store.getRuleVersion(demo.baseRuleDigest);
  const originalReview = await store.getSemanticReview(demo.baseReviewId);
  const base = await store.importRuleVersion({ ...originalBase.rule, ruleId: 'detectorless-smoke', version: 'base', detectionAssets: [] });
  const fixtures = (rule, mode) => ({ ...originalReview.fixtures, ruleDigest: rule.digest,
    judgments: originalReview.fixtures.judgments.map(value => {
      const anchor = value.findingAnchors[0], target = originalReview.coverage.targets.find(item => item.path === anchor.path);
      const decision = mode === 'base' ? 'violation' : mode === 'regressed' || anchor.path.endsWith('negative.ts') ? 'safe' : 'violation';
      return { ...value, targetId: reviewTargetId(rule.digest, demo.snapshotDigest, target.changeIndex, target.path, target.sourceDigest), decision,
        findingAnchors: mode === 'target-only' && decision === 'safe' ? [] : value.findingAnchors };
    }) });
  const baseReview = await store.runSemanticReview({ ruleDigest: base.digest, snapshotDigest: demo.snapshotDigest, fixtures: fixtures(base, 'base') });
  assert.deepEqual(baseReview.occurrences, []);
  const feedback = await Promise.all(baseReview.findings.map((finding, index) => store.appendReviewFeedback({
    id: `detectorless-label-${index}`, findingId: finding.id, reviewId: baseReview.id, ruleDigest: base.digest, ruleVersion: 'base',
    source: 'fixture', actor: 'authored-smoke', kind: 'label', label: finding.anchor.path.endsWith('negative.ts') ? 'FP' : 'TP',
    reason: 'Authored exact-anchor expectation; no human/model truth', createdAt: '2026-10-02T00:00:00Z' })));
  const results = [];
  for (const mode of ['compatible', 'regressed', 'target-only', 'not-run']) {
    const candidate = await store.importRuleVersion({ ...base.rule, version: mode,
      regressionCases: mode === 'regressed' ? base.rule.regressionCases.filter(value => value.role !== 'positive') : base.rule.regressionCases,
      provenance: { ...base.rule.provenance, parentDigest: base.digest } });
    const review = await store.runSemanticReview({ ruleDigest: candidate.digest, snapshotDigest: demo.snapshotDigest,
      ...(mode === 'not-run' ? {} : { fixtures: fixtures(candidate, mode) }) });
    assert.deepEqual(review.occurrences, []); assert(review.coverage.targets.every(value => value.scans.length === 0));
    const request = await store.createRevisionRequest({ id: `${mode}-request`, baseRuleDigest: base.digest, requestedRuleVersion: mode,
      feedbackIds: feedback.map(value => value.id), requestedChange: 'Exercise detectorless semantic comparison conservatively',
      actor: 'authored-smoke', source: 'fixture', createdAt: '2026-10-02T00:00:00Z' });
    const result = await store.createRevisionComparison({ id: `${mode}-comparison`, requestDigest: request.digest,
      candidateRuleDigest: candidate.digest, reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: review.id }],
      caseBindings: base.rule.regressionCases.map(value => ({ caseId: value.caseId, baseReviewId: baseReview.id })) });
    const expected = mode === 'compatible' || mode === 'regressed' ? mode : 'inconclusive';
    assert.equal(result.comparison.scorer, 'per-anchor-semantic-v3'); assert.equal(result.comparison.summary.status, expected);
    const decision = { id: `${mode}-decision`, comparisonDigest: result.digest, choice: 'accept', actor: 'authored-smoke', source: 'fixture',
      reason: 'Authored smoke decision only', createdAt: '2026-10-02T00:00:00Z' };
    if (mode === 'compatible') assert.equal((await store.recordRevisionDecision(decision)).decision.activation, 'not_performed');
    else await assert.rejects(store.recordRevisionDecision(decision), { code: 'REVISION_ACCEPT_BLOCKED' });
    if (mode === 'target-only') assert(result.comparison.feedback.some(value => value.candidate.reason === 'anchor_unscored'));
    if (mode === 'regressed') assert(result.comparison.cases.some(value => value.baseRole === 'positive' && value.candidateRole === null && value.outcome === 'regressed'));
    assert.equal(await store.getActive(base.rule.ruleId), null);
    results.push({ mode, result });
  }
  await store.close(); store = await QualEvoStore.openPGlite(db);
  for (const { result } of results) assert.deepEqual(await store.getRevisionComparison(result.digest), result);
  await store.close(); store = undefined;
  const output = await promisify(execFile)(process.execPath, ['dist/cli.js', 'revisions', 'comparison', '--digest', results[0].result.digest, '--db', db],
    { timeout: 30_000, maxBuffer: 2_000_000 });
  assert.deepEqual(JSON.parse(output.stdout), results[0].result);
  console.log(JSON.stringify({ mode: 'compiled-offline-detectorless-comparison', scorer: 'per-anchor-semantic-v3',
    cases: results.map(({ mode, result }) => ({ mode, digest: result.digest, summary: result.comparison.summary })),
    persistedReopen: true, compiledCliRead: true, modelExecution: 'not_run', notification: 'not_performed', activation: 'not_performed',
    certification: 'none', limitations: ['Authored fixture semantics and feedback only; no model-quality or human-ground-truth evidence.',
      'Exact selected anchors and declared file cases only; incomplete repository context.', 'No external requests, credentials, publication, deployment or commit.'] }, null, 2));
} finally { await store?.close(); await rm(root, { recursive: true, force: true }); }
