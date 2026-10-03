import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { SemanticGovernanceCommandSchema, type SemanticGovernanceCommand } from '../src/core/semantic-governance.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase, type Database, type Queryable } from '../src/storage/database.js';
import { deriveRevisionComparison } from '../src/revision-comparison.js';
import { RevisionDecisionSchema } from '../src/core/revision-comparison.js';
import { revisionComparisonFixture, revisionDecision, comparisonDate, type ComparisonFixtureOptions } from './helpers/revision-comparison-fixture.js';
import type { StoredRuleVersion } from '../src/core/semantic-rule.js';
import { demoInputs } from '../src/demo.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); while (cleanup.length) await cleanup.pop()!(); });
async function fixture(options: ComparisonFixtureOptions = {}) {
  const database = options.database ?? await openPGliteDatabase();
  cleanup.push(() => database.close());
  return revisionComparisonFixture({ ...options, database });
}
function fields(rule: StoredRuleVersion, id: string, expectedHeadDigest: string | null) {
  if (rule.rule.schemaVersion !== 2) throw new Error('Expected v2');
  return { id, namespace: 'local-semantic-review' as const, ruleDigest: rule.digest, scopeDigest: digestOf(rule.rule.scope), expectedHeadDigest,
    actor: 'declared-local-reviewer', source: 'local-human-declared' as const, reason: 'Explicit experimental local review choice', createdAt: comparisonDate };
}
async function accepted(f: Awaited<ReturnType<typeof fixture>>) {
  const comparison = await f.store.createRevisionComparison(f.input);
  return f.store.recordRevisionDecision(revisionDecision(comparison.digest));
}
async function registerPair(f: Awaited<ReturnType<typeof fixture>>, bootstrap = true) {
  let head = await f.store.applySemanticGovernance({ ...fields(f.baseRule, 'register-base', null), action: 'register' });
  if (bootstrap) head = await f.store.applySemanticGovernance({ ...fields(f.baseRule, 'bootstrap-base', head.digest), action: 'bootstrap-shadow' });
  head = await f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'register-candidate', head.digest), action: 'register' });
  return head;
}

it('keeps acceptance inert and performs exact local lifecycle, explicit atomic supersede, resume and terminal retirement', async () => {
  const f = await fixture(), beforeRules = await f.store.listRuleVersions(), decision = await accepted(f);
  expect(await f.store.getSemanticGovernance(f.baseInput.ruleId)).toMatchObject({ headDigest: null, versions: [], shadowRuleDigest: null });
  const select = () => f.store.selectLocalSemanticRules({ repository: f.snapshot.snapshot.repository.id, paths: ['src/positive-case.ts'] });
  expect((await select()).selected).toEqual([]);
  let head = await registerPair(f);
  expect((await select()).selected).toMatchObject([{ ruleDigest: f.baseRule.digest, status: 'local-shadow', selectionEvidence: { kind: 'unvalidated-root-bootstrap' } }]);
  expect((await select()).excluded).toMatchObject([{ ruleDigest: f.candidateRule.digest, reason: 'candidate' }]);
  const replacement: SemanticGovernanceCommand = { ...fields(f.baseRule, 'explicit-replacement', head.digest), action: 'supersede',
    successor: { ruleDigest: f.candidateRule.digest, scopeDigest: digestOf(f.candidateInput.scope) }, decisionDigest: decision.digest };
  head = await f.store.applySemanticGovernance(replacement);
  expect(head.event.transitions).toEqual([
    { ruleDigest: f.baseRule.digest, from: 'local-shadow', to: 'superseded' },
    { ruleDigest: f.candidateRule.digest, from: 'candidate', to: 'local-shadow' },
  ]);
  expect(head.event.evidence).toMatchObject({ kind: 'accepted-local-comparison', decisionSource: 'fixture', semanticEvidence: 'offline-fixture-declarations', observations: 3, certification: 'none' });
  expect((await select()).selected).toMatchObject([{ ruleDigest: f.candidateRule.digest, headDigest: head.digest }]);
  expect((await select()).excluded).toMatchObject([{ ruleDigest: f.baseRule.digest, reason: 'superseded' }]);
  head = await f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'suspend-candidate', head.digest), action: 'suspend' });
  expect((await select()).selected).toEqual([]);
  head = await f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'resume-candidate', head.digest), action: 'select-shadow', decisionDigest: decision.digest });
  head = await f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'retire-candidate', head.digest), action: 'retire' });
  expect((await select()).selected).toEqual([]);
  expect((await select()).excluded.map(value => value.reason)).toEqual(['superseded', 'retired']);
  await expect(f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'resurrect-retired', head.digest), action: 'select-shadow', decisionDigest: decision.digest })).rejects.toMatchObject({ code: 'INVALID_GOVERNANCE_TRANSITION' });
  await expect(f.store.applySemanticGovernance({ ...fields(f.baseRule, 'resurrect-superseded', head.digest), action: 'bootstrap-shadow' })).rejects.toMatchObject({ code: 'INVALID_GOVERNANCE_TRANSITION' });
  const history = await f.store.getSemanticGovernanceHistory(f.baseInput.ruleId);
  expect(history).toHaveLength(7);
  for (const [index, entry] of history.entries()) {
    expect(entry.digest).toBe(digestOf(entry.event));
    expect(entry.event.sequence).toBe(index + 1);
    expect(entry.event.previousEventDigest).toBe(index === 0 ? null : history[index - 1].digest);
    expect(entry.event.trust).toEqual({ identityVerification: 'caller-declared-unverified', eligibility: 'local-experimental-review-only', productionActivation: 'not_performed', certification: 'none' });
  }
  expect(await f.store.applySemanticGovernance(replacement)).toEqual(history[3]); // Retry after later events remains a no-op.
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
  expect(await f.store.listRuleVersions()).toEqual(beforeRules);
  expect((await f.store.getReviewFinding(f.finding.id)).feedback).toEqual([f.feedback]);
  expect(await f.store.getSemanticReview(f.baseReview.id)).toEqual(f.baseReview);
  expect(await f.store.getRevisionDecision(decision.digest)).toEqual(decision);
}, 30_000);

it('requires explicit registration and accepted candidate evidence, with root bootstrap isolated from revised rules', async () => {
  const f = await fixture(), decision = await accepted(f);
  await expect(f.store.applySemanticGovernance({ ...fields(f.baseRule, 'missing-registration', null), action: 'bootstrap-shadow' })).rejects.toMatchObject({ code: 'INVALID_GOVERNANCE_TRANSITION' });
  let head = await registerPair(f, false);
  await expect(f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'bypass-evidence', head.digest), action: 'bootstrap-shadow' })).rejects.toMatchObject({ code: 'GOVERNANCE_SELECTION_BLOCKED' });
  await expect(f.store.applySemanticGovernance({ ...fields(f.baseRule, 'wrong-evidence', head.digest), action: 'select-shadow', decisionDigest: decision.digest })).rejects.toMatchObject({ code: 'GOVERNANCE_EVIDENCE_MISMATCH' });
  for (const choice of ['reject', 'defer'] as const) {
    const other = await f.store.recordRevisionDecision(revisionDecision(decision.decision.comparisonDigest, { id: `decision-${choice}`, choice }));
    await expect(f.store.applySemanticGovernance({ ...fields(f.candidateRule, choice, head.digest), action: 'select-shadow', decisionDigest: other.digest })).rejects.toMatchObject({ code: 'GOVERNANCE_SELECTION_BLOCKED' });
  }
  head = await f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'selected-without-old-activation', head.digest), action: 'select-shadow', decisionDigest: decision.digest });
  expect((await f.store.getSemanticGovernance(f.baseInput.ruleId)).versions.map(value => value.status)).toEqual(['candidate', 'local-shadow']);
  await expect(f.store.applySemanticGovernance({ ...fields(f.baseRule, 'competing-root', head.digest), action: 'bootstrap-shadow' })).rejects.toMatchObject({ code: 'GOVERNANCE_SHADOW_CONFLICT' });
  await expect(f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'register-again', head.digest), action: 'register' })).rejects.toMatchObject({ code: 'INVALID_GOVERNANCE_TRANSITION' });
}, 30_000);

it('never qualifies unknown comparison evidence or a deferred declaration', async () => {
  const f = await fixture({ feedback: { label: 'Unknown' } });
  const comparison = await f.store.createRevisionComparison(f.input);
  expect(comparison.comparison.summary.status).toBe('inconclusive');
  const decision = await f.store.recordRevisionDecision(revisionDecision(comparison.digest, { choice: 'defer' }));
  const head = await registerPair(f, false);
  await expect(f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'unknown-selection', head.digest), action: 'select-shadow', decisionDigest: decision.digest })).rejects.toMatchObject({ code: 'GOVERNANCE_SELECTION_BLOCKED' });
  expect((await f.store.getSemanticGovernance(f.baseInput.ruleId)).headDigest).toBe(head.digest);
  expect((await f.store.getSemanticGovernanceHistory(f.baseInput.ruleId))).toHaveLength(2);
}, 30_000);

it('keeps archived acceptance readable but refuses to use obsolete scoring for new local eligibility', async () => {
  const f = await fixture();
  const comparison = deriveRevisionComparison(f.input, { request: f.request, baseRule: f.baseRule, candidateRule: f.candidateRule, cases: f.cases,
    pairs: [{ base: f.baseReview, candidate: f.candidateReview, snapshot: f.snapshot }], feedback: [{ feedback: f.feedback, finding: f.finding, review: f.baseReview }] }, 'explicit-semantic-v2');
  const comparisonDigest = digestOf(comparison);
  await f.database.query('INSERT INTO qe_rule_revision_comparisons(digest,id,request_digest,candidate_rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
    [comparisonDigest, f.input.id, f.request.digest, f.candidateRule.digest, JSON.stringify(comparison)]);
  const decision = RevisionDecisionSchema.parse({ ...revisionDecision(comparisonDigest), schemaVersion: 1, kind: 'local-rule-revision-decision',
    requestDigest: f.request.digest, candidateRuleDigest: f.candidateRule.digest, comparisonStatus: 'compatible', identityVerification: 'caller-declared-unverified', activation: 'not_performed', certification: 'none' });
  const digest = digestOf(decision);
  await f.database.query('INSERT INTO qe_rule_revision_decisions(digest,id,comparison_digest,payload) VALUES($1,$2,$3,$4::jsonb)', [digest, decision.id, comparisonDigest, JSON.stringify(decision)]);
  expect(await f.store.getRevisionDecision(digest)).toEqual({ digest, decision });
  const head = await registerPair(f, false);
  await expect(f.store.applySemanticGovernance({ ...fields(f.candidateRule, 'historical-selection', head.digest), action: 'select-shadow', decisionDigest: digest })).rejects.toMatchObject({ code: 'GOVERNANCE_SELECTION_BLOCKED' });
  expect(await f.store.getRevisionDecision(digest)).toEqual({ digest, decision });
}, 30_000);

it('compares exact scope and CAS hashes and rejects metadata smuggling before mutating history', async () => {
  const f = await fixture();
  const command: SemanticGovernanceCommand = { ...fields(f.baseRule, 'register', null), action: 'register' };
  for (const changed of [{ namespace: 'production' }, { actor: '  ' }, { reason: '' }, { expectedHeadDigest: undefined }, { id: ' padded' }, { approved: true }, { decisionDigest: 'f'.repeat(64) }]) {
    expect(SemanticGovernanceCommandSchema.safeParse({ ...command, ...changed }).success).toBe(false);
  }
  await expect(f.store.applySemanticGovernance({ ...command, scopeDigest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'GOVERNANCE_SCOPE_MISMATCH' });
  expect(await f.store.getSemanticGovernanceHistory(f.baseInput.ruleId)).toEqual([]);
  const head = await f.store.applySemanticGovernance(command);
  expect(await f.store.applySemanticGovernance(command)).toEqual(head);
  await expect(f.store.applySemanticGovernance({ ...command, actor: 'other' })).rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  await expect(f.store.applySemanticGovernance({ ...fields(f.baseRule, 'stale', null), action: 'bootstrap-shadow' })).rejects.toMatchObject({ code: 'STALE_GOVERNANCE_HEAD' });
  await expect(f.store.applySemanticGovernance({ ...fields(f.baseRule, 'wrong-head', 'f'.repeat(64)), action: 'retire' })).rejects.toMatchObject({ code: 'STALE_GOVERNANCE_HEAD' });
  expect(await f.store.getSemanticGovernanceHistory(f.baseInput.ruleId)).toEqual([head]);
}, 30_000);

it('serializes same-ID retries and competing commands; only one current-head winner is committed', async () => {
  const f = await fixture();
  const command: SemanticGovernanceCommand = { ...fields(f.baseRule, 'register', null), action: 'register' };
  const [first, second] = await Promise.all([f.store.applySemanticGovernance(command), f.store.applySemanticGovernance(command)]);
  expect(first).toEqual(second);
  const outcomes = await Promise.allSettled([
    f.store.applySemanticGovernance({ ...fields(f.baseRule, 'select', first.digest), action: 'bootstrap-shadow' }),
    f.store.applySemanticGovernance({ ...fields(f.baseRule, 'retire', first.digest), action: 'retire' }),
  ]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'STALE_GOVERNANCE_HEAD' } });
  expect(await f.store.getSemanticGovernanceHistory(f.baseInput.ruleId)).toHaveLength(2);
  expect((await f.database.query('SELECT * FROM qe_active_rules')).rows).toEqual([]);
}, 30_000);

it('rolls back an inserted event and both sides of supersede if the final head CAS fails', async () => {
  const database = await openPGliteDatabase();
  let rejectHeadWrite = false;
  const wrapped: Database = { ...database, transaction: fn => database.transaction(tx => fn({
    query: (async (sql: string, params?: unknown[]) => {
      if (rejectHeadWrite && /^(INSERT INTO|UPDATE) qe_local_semantic_governance_heads/.test(sql)) return { rows: [] };
      return tx.query(sql, params);
    }) as Queryable['query'],
  })) };
  const f = await fixture({ database: wrapped });
  rejectHeadWrite = true;
  await expect(f.store.applySemanticGovernance({ ...fields(f.baseRule, 'failed-register', null), action: 'register' })).rejects.toMatchObject({ code: 'STALE_GOVERNANCE_HEAD' });
  expect((await database.query('SELECT * FROM qe_local_semantic_governance_events')).rows).toEqual([]);
  rejectHeadWrite = false;
  const decision = await accepted(f), head = await registerPair(f), before = await f.store.getSemanticGovernance(f.baseInput.ruleId);
  const replacement: SemanticGovernanceCommand = { ...fields(f.baseRule, 'replacement', head.digest), action: 'supersede',
    successor: { ruleDigest: f.candidateRule.digest, scopeDigest: digestOf(f.candidateInput.scope) }, decisionDigest: decision.digest };
  rejectHeadWrite = true;
  await expect(f.store.applySemanticGovernance(replacement)).rejects.toMatchObject({ code: 'STALE_GOVERNANCE_HEAD' });
  expect(await f.store.getSemanticGovernance(f.baseInput.ruleId)).toEqual(before);
  expect(await f.store.getSemanticGovernanceHistory(f.baseInput.ruleId)).toHaveLength(3);
  rejectHeadWrite = false;
  expect((await f.store.applySemanticGovernance(replacement)).event.transitions).toHaveLength(2);
}, 30_000);

it('preserves literal scope exclusion, caller declarations and no-op external selection', async () => {
  const f = await fixture({ baseScope: { repositories: ['fixture:revision-comparison'], paths: { include: ['src'], exclude: ['src/generated'] } } });
  const head = await f.store.applySemanticGovernance({ ...fields(f.baseRule, 'register', null), action: 'register' });
  await f.store.applySemanticGovernance({ ...fields(f.baseRule, 'bootstrap', head.digest), action: 'bootstrap-shadow' });
  const fetch = vi.fn(() => { throw new Error('No network permitted'); }); vi.stubGlobal('fetch', fetch);
  for (const [repository, paths] of [['fixture:revision-comparison', ['src/generated/code.ts']], ['fixture:revision-comparison-fork', ['src/a.ts']], ['fixture:revision-comparison', ['src-other/a.ts']]] as const) {
    const selection = await f.store.selectLocalSemanticRules({ repository, paths: [...paths] });
    expect(selection.selected).toEqual([]); expect(selection.excluded).toMatchObject([{ reason: 'out_of_scope' }]);
  }
  const selection = await f.store.selectLocalSemanticRules({ repository: 'fixture:revision-comparison', paths: ['src/a.ts', 'docs/readme.md'] });
  expect(selection.selected).toHaveLength(1);
  expect(selection.selected[0].scope).toEqual(f.baseInput.scope);
  expect(selection.selected[0].selectionEvidence).toEqual({ kind: 'unvalidated-root-bootstrap' });
  for (const paths of [[], ['../a'], ['src/**'], ['src/a', 'src/a']]) await expect(f.store.selectLocalSemanticRules({ repository: 'fixture:revision-comparison', paths })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect((await f.store.listSemanticReviews({})).length).toBe(2);
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
}, 30_000);

it('protects immutable events and detects changed payloads, stale heads and tampered pinned rules before selection', async () => {
  const f = await fixture();
  const first = await f.store.applySemanticGovernance({ ...fields(f.baseRule, 'register', null), action: 'register' });
  const head = await f.store.applySemanticGovernance({ ...fields(f.baseRule, 'bootstrap', first.digest), action: 'bootstrap-shadow' });
  await expect(f.database.query('DELETE FROM qe_local_semantic_governance_events WHERE digest=$1', [head.digest])).rejects.toThrow('append-only');
  await expect(f.database.query("UPDATE qe_local_semantic_governance_events SET payload='{}'::jsonb WHERE digest=$1", [head.digest])).rejects.toThrow('append-only');
  await f.database.query('UPDATE qe_local_semantic_governance_heads SET digest=$1,sequence=1 WHERE rule_id=$2', [first.digest, f.baseInput.ruleId]);
  await expect(f.store.getSemanticGovernance(f.baseInput.ruleId)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.database.query('UPDATE qe_local_semantic_governance_heads SET digest=$1,sequence=2 WHERE rule_id=$2', [head.digest, f.baseInput.ruleId]);
  await f.database.exec('ALTER TABLE qe_local_semantic_governance_events DISABLE TRIGGER qe_local_semantic_governance_events_immutable');
  const changed = { ...head.event, shadowRuleDigest: null };
  await f.database.query('UPDATE qe_local_semantic_governance_events SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify(changed), head.digest]);
  await expect(f.store.selectLocalSemanticRules({ repository: 'fixture:revision-comparison', paths: ['src/a.ts'] })).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await f.database.query('UPDATE qe_local_semantic_governance_events SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify(head.event), head.digest]);
  await f.database.exec('ALTER TABLE qe_rule_bundles DISABLE TRIGGER qe_rule_bundles_immutable');
  await f.database.query('UPDATE qe_rule_bundles SET payload=$1::jsonb WHERE digest=$2', [JSON.stringify({ ...f.baseInput, scope: { ...f.baseInput.scope, repositories: ['wrong'] } }), f.baseRule.digest]);
  await expect(f.store.getSemanticGovernanceHistory(f.baseInput.ruleId)).rejects.toMatchObject({ code: 'CORRUPT_RULE_VERSION' });
}, 30_000);

it('durably reopens exact event history and idempotent commands without migrating legacy rule hashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-governance-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = await openPGliteDatabase(join(dir, 'db'));
  const f = await revisionComparisonFixture({ database: db });
  const decision = await accepted(f), head = await registerPair(f);
  const command: SemanticGovernanceCommand = { ...fields(f.baseRule, 'supersede', head.digest), action: 'supersede',
    successor: { ruleDigest: f.candidateRule.digest, scopeDigest: digestOf(f.candidateInput.scope) }, decisionDigest: decision.digest };
  const event = await f.store.applySemanticGovernance(command), history = await f.store.getSemanticGovernanceHistory(f.baseInput.ruleId), state = await f.store.getSemanticGovernance(f.baseInput.ruleId);
  await db.close();
  const reopened = await QualEvoStore.openPGlite(join(dir, 'db')); cleanup.push(() => reopened.close());
  expect(await reopened.getSemanticGovernance(f.baseInput.ruleId)).toEqual(state);
  expect(await reopened.getSemanticGovernanceHistory(f.baseInput.ruleId)).toEqual(history);
  expect(await reopened.applySemanticGovernance(command)).toEqual(event);
  expect(await reopened.getRuleVersion(f.baseRule.digest)).toEqual(f.baseRule);
  expect(await reopened.getRevisionDecision(decision.digest)).toEqual(decision);
  expect(await reopened.getActive(f.baseInput.ruleId)).toBeNull();
}, 30_000);

it('rejects v1 governance but leaves its exact bundle and active registry behavior unchanged', async () => {
  const f = await fixture();
  const { bundle, dataset } = demoInputs();
  const stored = await f.store.importRuleVersion(bundle, dataset.samples.map(item => item.problemCase));
  const command = { ...fields(f.baseRule, 'legacy-register', null), ruleDigest: stored.digest, action: 'register' as const };
  await expect(f.store.applySemanticGovernance(command)).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_SCHEMA' });
  expect(await f.store.getBundle(stored.digest)).toEqual({ digest: stored.digest, bundle });
  expect(await f.store.getSemanticGovernanceHistory(bundle.ruleId)).toEqual([]);
  expect((await f.database.query('SELECT * FROM qe_active_rules')).rows).toEqual([]);
}, 30_000);
