import { digestOf } from './core/identity.js';
import { SemanticRuleVersionSchema, type StoredRuleVersion } from './core/semantic-rule.js';
import type { StoredRevisionComparison, StoredRevisionDecision } from './core/revision-comparison.js';
import {
  GOVERNANCE_LIMITS, SEMANTIC_GOVERNANCE_NAMESPACE, SemanticGovernanceEventSchema, semanticGovernanceTrust,
  type SemanticGovernanceBinding, type SemanticGovernanceCommand, type SemanticGovernanceEvidence,
  type SemanticGovernanceEvent, type SemanticGovernanceState, type SemanticGovernanceStatus,
} from './core/semantic-governance.js';

export class SemanticGovernanceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'SemanticGovernanceError'; }
}
export function governanceFail(code: string, message: string): never { throw new SemanticGovernanceError(code, message); }
export const emptySemanticGovernance = (ruleId: string): SemanticGovernanceState => ({
  namespace: SEMANTIC_GOVERNANCE_NAMESPACE, ruleId, headDigest: null, sequence: 0, versions: [], shadowRuleDigest: null, trust: semanticGovernanceTrust,
});
export function semanticGovernanceBinding(stored: StoredRuleVersion, expectedScopeDigest?: string): SemanticGovernanceBinding {
  if (stored.rule.schemaVersion !== 2) governanceFail('UNSUPPORTED_RULE_SCHEMA', 'Local semantic governance requires an immutable semantic-v2 rule');
  const rule = SemanticRuleVersionSchema.parse(stored.rule), scopeDigest = digestOf(rule.scope);
  if (digestOf(rule) !== stored.digest) governanceFail('INTEGRITY_FAILURE', 'Governance rule content digest mismatch');
  if (expectedScopeDigest !== undefined && expectedScopeDigest !== scopeDigest) governanceFail('GOVERNANCE_SCOPE_MISMATCH', 'Command scope digest must match the exact immutable version scope');
  return { ruleDigest: stored.digest, ruleId: rule.ruleId, version: rule.version, scope: rule.scope, scopeDigest, parentDigest: rule.provenance.parentDigest };
}
/** Compatibility is bounded local evidence, never a production quality gate or authenticated approval. */
export function acceptedGovernanceEvidence(decision: StoredRevisionDecision, report: StoredRevisionComparison, candidate: SemanticGovernanceBinding, baseDigest?: string): SemanticGovernanceEvidence {
  const value = decision.decision, comparison = report.comparison;
  if (digestOf(value) !== decision.digest || digestOf(comparison) !== report.digest || value.comparisonDigest !== report.digest) governanceFail('INTEGRITY_FAILURE', 'Governance decision/comparison content binding mismatch');
  if (value.candidateRuleDigest !== candidate.ruleDigest || comparison.input.candidateRuleDigest !== candidate.ruleDigest
    || comparison.ruleId !== candidate.ruleId || comparison.candidateVersion !== candidate.version
    || comparison.baseRuleDigest !== candidate.parentDigest || (baseDigest !== undefined && comparison.baseRuleDigest !== baseDigest)) {
    governanceFail('GOVERNANCE_EVIDENCE_MISMATCH', 'Selection requires a decision for this exact candidate and direct base; supersede also binds the exact predecessor');
  }
  const observations = [...comparison.cases, ...comparison.feedback], scorer = comparison.scorer;
  if (value.choice !== 'accept' || value.comparisonStatus !== 'compatible' || comparison.summary.status !== 'compatible'
    || (scorer !== 'per-anchor-semantic-v3' && scorer !== 'per-anchor-context-v4' && scorer !== 'scope-applicability-v5') || !observations.length
    || observations.some(item => !['preserved', 'corrected'].includes(item.outcome)
      || !['violation', 'safe'].includes(item.expected) || !['violation', 'safe'].includes(item.base.state)
      || (!['violation', 'safe'].includes(item.candidate.state) && !(scorer === 'scope-applicability-v5' && item.expected === 'safe' && item.candidate.state === 'not_applicable' && 'feedbackId' in item)))) {
    governanceFail('GOVERNANCE_SELECTION_BLOCKED', 'Revised shadow selection requires exact accepted, current-scored, nonempty fully compatible local evidence; unknown, unscored, regressed and deferred evidence cannot qualify');
  }
  return { kind: 'accepted-local-comparison', decisionDigest: decision.digest, comparisonDigest: report.digest,
    baseRuleDigest: comparison.baseRuleDigest, candidateRuleDigest: candidate.ruleDigest, scorer,
    decisionSource: value.source, comparisonStatus: 'compatible', observations: observations.length,
    semanticEvidence: comparison.trust.semanticEvidence, scope: 'declared-cases-and-selected-feedback-only', certification: 'none' };
}

/** Pure transition derivation. All authorization is explicit caller declaration, not verified identity. */
export function deriveSemanticGovernanceEvent(
  command: SemanticGovernanceCommand, state: SemanticGovernanceState, binding: SemanticGovernanceBinding,
  successor?: SemanticGovernanceBinding, evidence: SemanticGovernanceEvidence | null = null,
): SemanticGovernanceEvent {
  const fail: typeof governanceFail = governanceFail;
  if (command.expectedHeadDigest !== state.headDigest) fail('STALE_GOVERNANCE_HEAD', 'Local governance changed; inspect the current head and submit a new explicit command');
  if (binding.ruleId !== state.ruleId || binding.ruleDigest !== command.ruleDigest || binding.scopeDigest !== command.scopeDigest) fail('GOVERNANCE_BINDING_MISMATCH', 'Command does not bind the exact logical rule, version and scope');
  if (state.sequence >= GOVERNANCE_LIMITS.events) fail('GOVERNANCE_LIMIT', 'Local governance stream is limited to 250 events; no partial transition was applied');
  const subject = state.versions.find(value => value.ruleDigest === binding.ruleDigest);
  if (subject) {
    // Explicit projection avoids allowing stored status to replace immutable version identity.
    const { status: _status, selectionEvidence: _evidence, ...previousBinding } = subject;
    if (digestOf(previousBinding) !== digestOf(binding)) fail('INTEGRITY_FAILURE', 'Registered governance binding changed');
  }
  const transitions: SemanticGovernanceEvent['transitions'] = [];
  const move = (digest: string, from: SemanticGovernanceStatus | null, to: SemanticGovernanceStatus) => transitions.push({ ruleDigest: digest, from, to });
  const requireStatus = (allowed: SemanticGovernanceStatus[]) => {
    if (!subject || !allowed.includes(subject.status)) fail('INVALID_GOVERNANCE_TRANSITION', `Action ${command.action} requires ${allowed.join(' or ')} status`);
  };
  const requireFreeSelection = (allowedDigest?: string) => {
    if (state.shadowRuleDigest !== null && state.shadowRuleDigest !== allowedDigest) fail('GOVERNANCE_SHADOW_CONFLICT', 'Another version is selected; explicitly suspend or supersede it first');
  };
  switch (command.action) {
    case 'register':
      if (subject) fail('INVALID_GOVERNANCE_TRANSITION', 'Version is already registered; replay the original command ID for an idempotent retry');
      if (state.versions.length >= GOVERNANCE_LIMITS.versions) fail('GOVERNANCE_LIMIT', 'Local governance is limited to 100 versions per logical rule');
      move(binding.ruleDigest, null, 'candidate'); break;
    case 'bootstrap-shadow':
      requireStatus(['candidate', 'suspended']); requireFreeSelection();
      if (binding.parentDigest !== null) fail('GOVERNANCE_SELECTION_BLOCKED', 'Explicit unvalidated bootstrap is only available for root versions; revised versions require accepted comparison evidence');
      if (evidence?.kind !== 'unvalidated-root-bootstrap') fail('INTEGRITY_FAILURE', 'Missing explicit unvalidated bootstrap declaration');
      move(binding.ruleDigest, subject!.status, 'local-shadow'); break;
    case 'select-shadow':
      requireStatus(['candidate', 'suspended']); requireFreeSelection();
      if (binding.parentDigest === null || evidence?.kind !== 'accepted-local-comparison' || evidence.decisionDigest !== command.decisionDigest || evidence.candidateRuleDigest !== binding.ruleDigest) fail('GOVERNANCE_SELECTION_BLOCKED', 'Revised selection requires an exact accepted comparison; root versions use explicit unvalidated bootstrap');
      move(binding.ruleDigest, subject!.status, 'local-shadow'); break;
    case 'suspend':
      requireStatus(['local-shadow']); move(binding.ruleDigest, subject!.status, 'suspended'); break;
    case 'retire':
      requireStatus(['candidate', 'local-shadow', 'suspended']); move(binding.ruleDigest, subject!.status, 'retired'); break;
    case 'supersede': {
      requireStatus(['local-shadow', 'suspended']); requireFreeSelection(binding.ruleDigest);
      if (!successor || successor.ruleId !== binding.ruleId || successor.ruleDigest !== command.successor.ruleDigest
        || successor.scopeDigest !== command.successor.scopeDigest || successor.parentDigest !== binding.ruleDigest) fail('GOVERNANCE_BINDING_MISMATCH', 'Supersede requires an exact same-rule direct successor and its scope digest');
      const target = state.versions.find(value => value.ruleDigest === successor.ruleDigest);
      if (!target || !['candidate', 'suspended'].includes(target.status)) fail('INVALID_GOVERNANCE_TRANSITION', 'Successor must already be registered as candidate or suspended');
      if (evidence?.kind !== 'accepted-local-comparison' || evidence.decisionDigest !== command.decisionDigest
        || evidence.baseRuleDigest !== binding.ruleDigest || evidence.candidateRuleDigest !== successor.ruleDigest) fail('GOVERNANCE_SELECTION_BLOCKED', 'Supersede requires compatible accepted evidence for this exact predecessor and successor');
      move(binding.ruleDigest, subject!.status, 'superseded'); move(successor.ruleDigest, target.status, 'local-shadow'); break;
    }
  }
  let shadowRuleDigest = state.shadowRuleDigest;
  for (const transition of transitions) {
    if (transition.ruleDigest === shadowRuleDigest && transition.to !== 'local-shadow') shadowRuleDigest = null;
    if (transition.to === 'local-shadow') shadowRuleDigest = transition.ruleDigest;
  }
  if (state.sequence + 1 === GOVERNANCE_LIMITS.events && shadowRuleDigest !== null) fail('GOVERNANCE_LIMIT', 'The final local history slot is reserved for leaving no shadow selected; suspend or retire before the stream limit');
  return SemanticGovernanceEventSchema.parse({ schemaVersion: 1, kind: 'local-semantic-governance-event', command,
    ruleId: binding.ruleId, sequence: state.sequence + 1, previousEventDigest: state.headDigest,
    bindings: successor ? [binding, successor] : [binding], transitions, shadowRuleDigest, evidence, trust: semanticGovernanceTrust });
}
export function advanceSemanticGovernance(state: SemanticGovernanceState, event: SemanticGovernanceEvent, digest: string): SemanticGovernanceState {
  const versions = state.versions.map(value => ({ ...value }));
  for (const transition of event.transitions) {
    let version = versions.find(value => value.ruleDigest === transition.ruleDigest);
    if (!version) { version = { ...event.bindings.find(value => value.ruleDigest === transition.ruleDigest)!, status: transition.to, selectionEvidence: null }; versions.push(version); }
    version.status = transition.to;
    if (transition.to === 'local-shadow') version.selectionEvidence = event.evidence;
  }
  return { ...state, versions, headDigest: digest, sequence: event.sequence, shadowRuleDigest: event.shadowRuleDigest };
}
