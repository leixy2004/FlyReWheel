import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { ProblemCaseSchema } from '../src/core/model.js';
import { SemanticRuleVersionSchema, type StoredRuleVersion } from '../src/core/semantic-rule.js';
import { GOVERNANCE_LIMITS, type SemanticGovernanceCommand } from '../src/core/semantic-governance.js';
import { advanceSemanticGovernance, deriveSemanticGovernanceEvent, emptySemanticGovernance, semanticGovernanceBinding } from '../src/semantic-governance.js';
import { openPGliteDatabase } from '../src/storage/database.js';
import { QualEvoStore } from '../src/storage/store.js';

const rootInput = SemanticRuleVersionSchema.parse(JSON.parse(await readFile(new URL('../examples/semantic-rule-v2.json', import.meta.url), 'utf8')));
const cases = ProblemCaseSchema.array().parse(JSON.parse(await readFile(new URL('../examples/semantic-rule-cases.json', import.meta.url), 'utf8')));
const selection = { repository: rootInput.scope.repositories[0], paths: ['src/worker.ts'] };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

type SimpleAction = 'register' | 'bootstrap-shadow' | 'suspend' | 'retire';
function command(rule: StoredRuleVersion, id: string, action: SimpleAction, expectedHeadDigest: string | null): SemanticGovernanceCommand {
  if (rule.rule.schemaVersion !== 2) throw new Error('Expected a semantic-v2 fixture');
  return { id, action, expectedHeadDigest, namespace: 'local-semantic-review', ruleDigest: rule.digest, scopeDigest: digestOf(rule.rule.scope),
    actor: 'Synthetic limit-test operator', source: 'fixture', reason: 'Explicit local regression fixture only', createdAt: '2026-10-02T00:00:00Z' };
}
async function fixture() {
  const db = await openPGliteDatabase(), store = await QualEvoStore.initialize(db);
  cleanup.push(() => store.close());
  return { db, store, root: await store.importRuleVersion(rootInput, cases) };
}
async function bootstrap(store: QualEvoStore, rule: StoredRuleVersion, prefix: string) {
  const registration = command(rule, `${prefix}-register`, 'register', null);
  const registered = await store.applySemanticGovernance(registration);
  const selected = await store.applySemanticGovernance(command(rule, `${prefix}-bootstrap`, 'bootstrap-shadow', registered.digest));
  return { registration, registered, selected };
}

it('rejects selection when an immutable event stream has lost its head instead of returning partial or empty eligibility', async () => {
  const { db, store, root } = await fixture();
  await bootstrap(store, root, 'lost');
  const healthy = await store.importRuleVersion({ ...rootInput, ruleId: 'healthy-governance-stream' });
  await bootstrap(store, healthy, 'healthy');
  expect((await store.selectLocalSemanticRules(selection)).selected).toHaveLength(2);

  // The mutable projection can be damaged without changing the immutable event history.
  await db.query('DELETE FROM qe_local_semantic_governance_heads WHERE rule_id=$1', [rootInput.ruleId]);
  expect((await db.query('SELECT digest FROM qe_local_semantic_governance_events WHERE rule_id=$1', [rootInput.ruleId])).rows).toHaveLength(2);
  await expect(store.getSemanticGovernance(rootInput.ruleId)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(store.getSemanticGovernanceHistory(rootInput.ruleId)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  await expect(store.selectLocalSemanticRules(selection)).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  // Scope filtering cannot hide corruption by silently omitting that stream.
  await expect(store.selectLocalSemanticRules({ ...selection, repository: 'synthetic:unrelated' })).rejects.toMatchObject({ code: 'INTEGRITY_FAILURE' });
  expect((await store.getSemanticGovernance(healthy.rule.ruleId)).shadowRuleDigest).toBe(healthy.digest);
}, 30_000);

it('rejects a 101st logical-rule registration atomically while preserving selection, exact retries and existing-stream writes', async () => {
  const { db, store, root } = await fixture();
  const baseline = await bootstrap(store, root, 'baseline');
  for (let index = 1; index < GOVERNANCE_LIMITS.rules; index++) {
    const rule = await store.importRuleVersion({ ...rootInput, ruleId: `governance-limit-${index}` });
    await store.applySemanticGovernance(command(rule, `register-${index}`, 'register', null));
  }
  const before = await store.selectLocalSemanticRules(selection);
  expect(before.selected).toMatchObject([{ ruleDigest: root.digest, headDigest: baseline.selected.digest }]);
  expect(before.excluded).toHaveLength(GOVERNANCE_LIMITS.rules - 1);
  const eventsBefore = (await db.query('SELECT digest FROM qe_local_semantic_governance_events ORDER BY digest')).rows;
  const overflow = await store.importRuleVersion({ ...rootInput, ruleId: 'governance-limit-overflow' });
  await expect(store.applySemanticGovernance(command(overflow, 'register-overflow', 'register', null))).rejects.toMatchObject({ code: 'GOVERNANCE_LIMIT' });
  expect((await db.query('SELECT rule_id FROM qe_local_semantic_governance_heads')).rows).toHaveLength(GOVERNANCE_LIMITS.rules);
  expect((await db.query('SELECT digest FROM qe_local_semantic_governance_events ORDER BY digest')).rows).toEqual(eventsBefore);
  expect(await store.getSemanticGovernance(overflow.rule.ruleId)).toMatchObject({ headDigest: null, sequence: 0, versions: [] });
  expect(await store.getSemanticGovernanceHistory(overflow.rule.ruleId)).toEqual([]);
  expect(await store.selectLocalSemanticRules(selection)).toEqual(before);
  expect(await store.applySemanticGovernance(baseline.registration)).toEqual(baseline.registered);

  // The catalog cap limits new logical streams, not writes to an existing rule.
  const candidate = await store.importRuleVersion({ ...rootInput, version: 'limit-revision', provenance: { ...rootInput.provenance, parentDigest: root.digest } });
  const registered = await store.applySemanticGovernance(command(candidate, 'existing-stream-register', 'register', baseline.selected.digest));
  const suspended = await store.applySemanticGovernance(command(root, 'existing-stream-suspend', 'suspend', registered.digest));
  expect((await store.selectLocalSemanticRules(selection)).selected).toEqual([]);
  const resumed = await store.applySemanticGovernance(command(root, 'existing-stream-resume', 'bootstrap-shadow', suspended.digest));
  expect((await store.selectLocalSemanticRules(selection)).selected).toMatchObject([{ ruleDigest: root.digest, headDigest: resumed.digest }]);
}, 30_000);

/** Derive a complete valid prefix cheaply; production storage replays this same transition function. */
function nearLimit(selectedAtBoundary: boolean) {
  const root = { digest: digestOf(rootInput), rule: rootInput };
  const revised = SemanticRuleVersionSchema.parse({ ...rootInput, version: 'boundary-revision', provenance: { ...rootInput.provenance, parentDigest: root.digest } });
  const candidate = { digest: digestOf(revised), rule: revised };
  let state = emptySemanticGovernance(rootInput.ruleId);
  const append = (rule: StoredRuleVersion, action: SimpleAction) => {
    const input = command(rule, `boundary-${state.sequence + 1}-${action}`, action, state.headDigest);
    const event = deriveSemanticGovernanceEvent(input, state, semanticGovernanceBinding(rule), undefined,
      action === 'bootstrap-shadow' ? { kind: 'unvalidated-root-bootstrap' } : null);
    state = advanceSemanticGovernance(state, event, digestOf(event));
  };
  append(root, 'register');
  if (selectedAtBoundary) {
    append(root, 'bootstrap-shadow');
    append(candidate, 'register');
  }
  while (state.sequence < GOVERNANCE_LIMITS.events - 1) append(root, state.shadowRuleDigest === null ? 'bootstrap-shadow' : 'suspend');
  return { state, root, candidate };
}

it('rejects bootstrap into the final event slot without mutating the valid suspended prefix', () => {
  const { state, root } = nearLimit(false), before = structuredClone(state);
  expect(state).toMatchObject({ sequence: 249, shadowRuleDigest: null, versions: [{ status: 'suspended' }] });
  expect(() => deriveSemanticGovernanceEvent(command(root, 'final-bootstrap', 'bootstrap-shadow', state.headDigest), state,
    semanticGovernanceBinding(root), undefined, { kind: 'unvalidated-root-bootstrap' })).toThrow('final local history slot');
  expect(state).toEqual(before);
});

it('does not let an unrelated version transition consume the final slot while a shadow remains selected', () => {
  const { state, root, candidate } = nearLimit(true), before = structuredClone(state);
  expect(state).toMatchObject({ sequence: 249, shadowRuleDigest: root.digest });
  expect(() => deriveSemanticGovernanceEvent(command(candidate, 'final-retire-candidate', 'retire', state.headDigest), state,
    semanticGovernanceBinding(candidate))).toThrow('final local history slot');
  expect(state).toEqual(before);
});

it.each(['suspend', 'retire'] as const)('allows %s at event 250 to leave no selected shadow and rejects event 251', action => {
  const { state, root } = nearLimit(true);
  const event = deriveSemanticGovernanceEvent(command(root, `final-${action}`, action, state.headDigest), state, semanticGovernanceBinding(root));
  expect(event).toMatchObject({ sequence: GOVERNANCE_LIMITS.events, previousEventDigest: state.headDigest, shadowRuleDigest: null,
    transitions: [{ ruleDigest: root.digest, from: 'local-shadow', to: action === 'suspend' ? 'suspended' : 'retired' }] });
  const terminal = advanceSemanticGovernance(state, event, digestOf(event));
  expect(terminal.sequence).toBe(GOVERNANCE_LIMITS.events);
  expect(terminal.shadowRuleDigest).toBeNull();
  expect(terminal.versions.filter(value => value.status === 'local-shadow')).toEqual([]);
  expect(() => deriveSemanticGovernanceEvent(command(root, 'beyond-limit', 'bootstrap-shadow', terminal.headDigest), terminal,
    semanticGovernanceBinding(root), undefined, { kind: 'unvalidated-root-bootstrap' })).toThrow('limited to 250 events');
});
