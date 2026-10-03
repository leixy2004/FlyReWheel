import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QualEvoStore } from '../dist/storage/store.js';
import { runRevisionComparisonDemo } from '../dist/revision-demo.js';
import { digestOf } from '../dist/core/identity.js';

// Compiled, authored-fixture-only plumbing check. No model, provider or publication calls.
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('This smoke prohibits external calls'); };
const directory = await mkdtemp(join(tmpdir(), 'local-semantic-governance-'));
let store;
try {
  store = await QualEvoStore.openPGlite(join(directory, 'db'));
  const demo = await runRevisionComparisonDemo(store);
  const base = await store.getRuleVersion(demo.baseRuleDigest);
  const candidate = await store.getRuleVersion(demo.compatible.candidateRuleDigest);
  const select = () => store.selectLocalSemanticRules({ repository: base.rule.scope.repositories[0], paths: ['src/positive.ts'] });
  assert.equal((await select()).selected.length, 0, 'Accepted fixture comparison must remain inert');
  let expectedHeadDigest = null;
  const apply = async (id, rule, action, extra = {}) => {
    const command = { id, namespace: 'local-semantic-review', ruleDigest: rule.digest, scopeDigest: digestOf(rule.rule.scope), expectedHeadDigest,
      actor: 'synthetic-fixture', source: 'fixture', reason: 'Explicit authored local governance smoke only', createdAt: '2026-10-02T00:00:00Z', action, ...extra };
    const result = await store.applySemanticGovernance(command); expectedHeadDigest = result.digest;
    return { command, result };
  };
  await apply('register-root', base, 'register');
  await apply('bootstrap-root', base, 'bootstrap-shadow');
  assert.equal((await select()).selected[0].selectionEvidence.kind, 'unvalidated-root-bootstrap');
  await apply('register-candidate', candidate, 'register');
  assert.equal((await select()).selected[0].ruleDigest, base.digest);
  const replacement = await apply('replace-root', base, 'supersede', { successor: { ruleDigest: candidate.digest, scopeDigest: digestOf(candidate.rule.scope) }, decisionDigest: demo.compatible.decision.digest });
  const selected = await select();
  assert.equal(selected.selected[0].ruleDigest, candidate.digest);
  assert.equal(selected.excluded[0].reason, 'superseded');
  assert.equal(selected.selected[0].selectionEvidence.decisionSource, 'fixture');
  assert.equal(selected.selected[0].selectionEvidence.semanticEvidence, 'offline-fixture-declarations');
  await apply('suspend-candidate', candidate, 'suspend');
  assert.equal((await select()).selected.length, 0);
  const suspended = await store.getSemanticGovernance(base.rule.ruleId);
  await store.close(); store = await QualEvoStore.openPGlite(join(directory, 'db'));
  assert.deepEqual(await store.getSemanticGovernance(base.rule.ruleId), suspended);
  assert.deepEqual(await store.applySemanticGovernance(replacement.command), replacement.result);
  await apply('resume-candidate', candidate, 'select-shadow', { decisionDigest: demo.compatible.decision.digest });
  await apply('retire-candidate', candidate, 'retire');
  assert.equal((await select()).selected.length, 0);
  assert.equal(await store.getActive(base.rule.ruleId), null);
  assert.equal((await store.getSemanticReview(demo.baseReviewId)).ruleDigest, base.digest);
  const history = await store.getSemanticGovernanceHistory(base.rule.ruleId);
  assert.equal(history.length, 7);
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ mode: 'compiled-offline-local-semantic-governance-smoke', namespace: 'local-semantic-review',
    acceptedDecisionAutomaticSelection: false, rootBootstrap: 'explicit-unvalidated',
    replacement: { explicit: true, predecessor: base.digest, successor: candidate.digest, comparisonDigest: demo.compatible.comparison.digest, decisionDigest: demo.compatible.decision.digest },
    finalState: await store.getSemanticGovernance(base.rule.ruleId),
    history: history.map(({ digest, event }) => ({ digest, sequence: event.sequence, action: event.command.action, previousEventDigest: event.previousEventDigest, transitions: event.transitions })),
    durableReopen: 'passed', retryAfterHeadAdvance: 'passed', explicitHistoricalReviewRead: 'passed', v1ActiveRegistry: 'unchanged',
    externalCalls: networkCalls, certification: 'none', productionActivation: 'not_performed',
    limitations: ['Authored fixtures test plumbing and guards; they do not establish model quality or authenticated human approval.', 'PGlite transactions were exercised; a live PostgreSQL server was not used.'] }, null, 2));
} finally { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); }
