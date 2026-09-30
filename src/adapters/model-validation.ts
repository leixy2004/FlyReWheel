import { detectAstGrep } from './ast-grep.js';
import { sourceDigest } from './candidates.js';
import { type RuleSynthesisDraft, type SynthesisInput } from './model-contract.js';
import { type AdjudicationInput } from './semantic.js';
export function validateDecisionEvidence(input: AdjudicationInput, decision: { decision: string; evidenceRefs: string[] }): void {
  if (decision.evidenceRefs.some(ref => !input.evidence.some(item => item.id === ref))) throw new Error('Agent cited evidence not supplied to this call');
  if (decision.decision !== 'unknown') {
    if (!decision.evidenceRefs.length) throw new Error('A decisive agent verdict requires cited evidence');
    for (const kind of input.skill.requiredContext) {
      if (!input.evidence.some(item => item.kind === kind && decision.evidenceRefs.includes(item.id))) throw new Error(`A decisive agent verdict must cite required context: ${kind}`);
    }
  }
}
export function validateSynthesisDraft(input: SynthesisInput, draft: RuleSynthesisDraft) {
  const supplied = new Set(input.pairs.map(pair => pair.caseId));
  if (draft.supportingCaseIds.some(id => !supplied.has(id))) throw new Error('Synthesis cited an unknown training case');
  return input.pairs.map(pair => {
    const shared = { path: pair.path, language: draft.detector.language, pattern: draft.detector.pattern, ruleId: 'synthesis-draft', ruleVersion: 'unreviewed', bundleDigest: sourceDigest(JSON.stringify(draft)) };
    if (pair.language.toLowerCase() !== draft.detector.language) throw new Error('Synthesized detector language does not match its training pair');
    const beforeMatches = detectAstGrep({ ...shared, source: pair.before }).length;
    const afterMatches = detectAstGrep({ ...shared, source: pair.after }).length;
    if (!beforeMatches) throw new Error(`Draft did not recall the pre-fix training case: ${pair.caseId}`);
    // A guard/branch fix may keep the same high-recall structural candidate.
    // Skill+context adjudication must establish whether surviving candidates are safe.
    return { caseId: pair.caseId, beforeMatches, afterMatches, requiresSemanticValidation: afterMatches > 0 };
  });
}
