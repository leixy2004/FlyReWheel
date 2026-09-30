import { describe, expect, it } from 'vitest';
import { validateSynthesisDraft } from '../src/adapters/model-validation.js';
import { RuleSynthesisDraftSchema, type SynthesisInput } from '../src/adapters/model-contract.js';

const before = 'def suffix(tokens, count):\n    return tokens[-count:]\n';
const guardedAfter = 'def suffix(tokens, count):\n    if count == 0:\n        return []\n    return tokens[-count:]\n';
const pair = { caseId: 'guarded-suffix', split: 'training' as const, path: 'suffix.py', language: 'python', before, after: guardedAfter, problem: 'Zero count returns all tokens instead of none', evidenceRefs: ['case://guarded-suffix'] };
const input: SynthesisInput = { goal: 'Find incorrect zero-length slicing', pairs: [pair] };
const draft = RuleSynthesisDraftSchema.parse({ status: 'candidate', skill: { title: 'Zero-length suffix is empty', invariant: 'A zero count must return no tokens', applicability: ['Negative-count suffix slicing'], exceptions: ['A dominating guard handles zero first'], requiredContext: ['dominating-guards'] }, detector: { kind: 'ast-grep', language: 'python', pattern: 'tokens[-count:]' }, supportingCaseIds: [pair.caseId], reasoning: 'The fix adds a zero-count guard; the structural operation remains.' });

describe('coupled Skill + detector synthesis replay', () => {
  it('accepts a guard repair with one candidate both before and after', () => {
    expect(validateSynthesisDraft(input, draft)).toEqual([{ caseId: pair.caseId, beforeMatches: 1, afterMatches: 1, requiresSemanticValidation: true }]);
  });
  it('records zero post-fix matches without treating structural replay as quality certification', () => {
    expect(validateSynthesisDraft({ ...input, pairs: [{ ...pair, after: 'def suffix(tokens, count):\n    return safe_suffix(tokens, count)\n' }] }, draft)).toEqual([{ caseId: pair.caseId, beforeMatches: 1, afterMatches: 0, requiresSemanticValidation: false }]);
  });
  it('still rejects a detector that misses the pre-fix case', () => {
    expect(() => validateSynthesisDraft(input, { ...draft, detector: { ...draft.detector, pattern: 'irrelevant_call($X)' } })).toThrow('did not recall');
  });
  it('still rejects parser errors in post-fix source', () => {
    expect(() => validateSynthesisDraft({ ...input, pairs: [{ ...pair, after: 'def broken(:\n    return tokens[-count:]\n' }] }, draft)).toThrow('coverage is unverified');
  });
});
