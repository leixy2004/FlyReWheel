import { expect, it } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import type { SemanticGovernanceCommand } from '../src/core/semantic-governance.js';
import { acceptedGovernanceEvidence, advanceSemanticGovernance, deriveSemanticGovernanceEvent, emptySemanticGovernance, semanticGovernanceBinding } from '../src/semantic-governance.js';
import { revisionComparisonFixture, revisionDecision, comparisonDate } from './helpers/revision-comparison-fixture.js';

it('rejects misleading compatibility claims including empty, unknown, unscored, regressed and obsolete evidence', async () => {
  const f = await revisionComparisonFixture();
  try {
    const report = await f.store.createRevisionComparison(f.input), decision = await f.store.recordRevisionDecision(revisionDecision(report.digest));
    const target = semanticGovernanceBinding(f.candidateRule);
    expect(acceptedGovernanceEvidence(decision, report, target)).toMatchObject({ kind: 'accepted-local-comparison', observations: 3, certification: 'none', decisionSource: 'fixture' });
    for (const mutation of [
      (value: typeof report.comparison) => { value.cases = []; value.feedback = []; },
      (value: typeof report.comparison) => { value.cases[0].candidate.state = 'unknown'; },
      (value: typeof report.comparison) => { value.cases[0].base.state = 'unscored'; },
      (value: typeof report.comparison) => { value.cases[0].expected = 'unknown'; },
      (value: typeof report.comparison) => { value.cases[0].outcome = 'inconclusive'; },
      (value: typeof report.comparison) => { value.cases[0].outcome = 'regressed'; },
      (value: typeof report.comparison) => { value.scorer = 'explicit-semantic-v2'; },
      (value: typeof report.comparison) => { delete value.scorer; },
    ]) {
      const comparison = structuredClone(report.comparison); mutation(comparison);
      const comparisonDigest = digestOf(comparison), value = { ...decision.decision, comparisonDigest };
      expect(() => acceptedGovernanceEvidence({ digest: digestOf(value), decision: value }, { digest: comparisonDigest, comparison }, target)).toThrow(/requires exact accepted/);
    }
    expect(() => acceptedGovernanceEvidence({ ...decision, digest: 'f'.repeat(64) }, report, target)).toThrow(/content binding/);
    expect(() => acceptedGovernanceEvidence(decision, report, { ...target, scopeDigest: 'f'.repeat(64), parentDigest: 'f'.repeat(64) })).toThrow(/exact candidate and direct base/);
    expect(() => acceptedGovernanceEvidence(decision, report, target, 'f'.repeat(64))).toThrow(/exact candidate and direct base/);
  } finally { await f.store.close(); }
}, 30_000);

it('derives allowed transitions only, guards predecessor/successor linkage, and never mutates supplied state', async () => {
  const f = await revisionComparisonFixture();
  try {
    const base = semanticGovernanceBinding(f.baseRule), candidate = semanticGovernanceBinding(f.candidateRule);
    const report = await f.store.createRevisionComparison(f.input), decision = await f.store.recordRevisionDecision(revisionDecision(report.digest));
    const proof = acceptedGovernanceEvidence(decision, report, candidate, base.ruleDigest);
    let state = emptySemanticGovernance(base.ruleId);
    const command = (id: string, binding = base) => ({ id, namespace: 'local-semantic-review' as const, ruleDigest: binding.ruleDigest, scopeDigest: binding.scopeDigest,
      expectedHeadDigest: state.headDigest, actor: 'fixture-actor', source: 'fixture' as const, reason: 'Explicit synthetic state transition', createdAt: comparisonDate });
    const advance = (value: SemanticGovernanceCommand, binding = base, evidence: typeof proof | null = null) => {
      const before = structuredClone(state), event = deriveSemanticGovernanceEvent(value, state, binding, undefined, evidence);
      state = advanceSemanticGovernance(state, event, digestOf(event));
      expect(before.sequence).toBe(state.sequence - 1); return event;
    };
    advance({ ...command('register'), action: 'register' });
    const candidateState = structuredClone(state);
    expect(() => deriveSemanticGovernanceEvent({ ...command('invalid-suspend'), action: 'suspend' }, state, base)).toThrow(/requires local-shadow/);
    expect(() => deriveSemanticGovernanceEvent({ ...command('wrong-namespace-binding'), action: 'register', ruleDigest: candidate.ruleDigest }, state, base)).toThrow(/exact logical rule/);
    expect(state).toEqual(candidateState);
    advance({ ...command('bootstrap'), action: 'bootstrap-shadow' }, base, { kind: 'unvalidated-root-bootstrap' });
    advance({ ...command('register-child', candidate), action: 'register' }, candidate);
    const replace: SemanticGovernanceCommand = { ...command('replace'), action: 'supersede', decisionDigest: decision.digest,
      successor: { ruleDigest: candidate.ruleDigest, scopeDigest: candidate.scopeDigest } };
    for (const changed of [{ ...candidate, ruleId: 'wrong-rule' }, { ...candidate, parentDigest: 'f'.repeat(64) }, { ...candidate, scopeDigest: 'f'.repeat(64) }]) {
      expect(() => deriveSemanticGovernanceEvent(replace, state, base, changed, proof)).toThrow(/same-rule direct successor/);
    }
    expect(() => deriveSemanticGovernanceEvent(replace, state, base, candidate, null)).toThrow(/compatible accepted evidence/);
    expect(() => deriveSemanticGovernanceEvent({ ...replace, expectedHeadDigest: null }, state, base, candidate, proof)).toThrow(/Local governance changed/);
    const before = structuredClone(state), event = deriveSemanticGovernanceEvent(replace, state, base, candidate, proof);
    const after = advanceSemanticGovernance(state, event, digestOf(event));
    expect(state).toEqual(before);
    expect(after.versions.map(value => value.status)).toEqual(['superseded', 'local-shadow']);
    expect(after.shadowRuleDigest).toBe(candidate.ruleDigest);
  } finally { await f.store.close(); }
}, 30_000);
