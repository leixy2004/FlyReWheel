import { z } from 'zod';
import type { MatchedCodexExecution } from './matched-codex-policy.js';

const Id = z.string().min(1).max(300);
const Refs = z.array(Id).max(300).refine(xs => new Set(xs).size === xs.length, 'Duplicate selected references');
const CitationSelection = z.object({ evidenceRefs: Refs, requiredEvidenceRefs: Refs }).strict()
  .superRefine((value, ctx) => {
    if (value.requiredEvidenceRefs.some(ref => !value.evidenceRefs.includes(ref))) {
      ctx.addIssue({ code: 'custom', message: 'Required citations must belong to the selected evidence' });
    }
  });
const Targets = z.array(CitationSelection.safeExtend({ targetId: Id })).max(200)
  .refine(xs => new Set(xs.map(x => x.targetId)).size === xs.length, 'Duplicate selected targets');
/** Response binding only. IDs describe the caller's selected prompt evidence;
 * they do not establish source authenticity, semantic truth or launch authority. */
export const MatchedEvidenceSelectionSchema = z.discriminatedUnion('stage', [
  CitationSelection.safeExtend({ stage: z.literal('proposal') }),
  z.object({ stage: z.literal('diagnosis'), feedback: z.array(CitationSelection.safeExtend({ feedbackId: Id })).min(1).max(100)
    .refine(xs => new Set(xs.map(x => x.feedbackId)).size === xs.length, 'Duplicate selected feedback') }).strict(),
  z.object({ stage: z.literal('gate'), targets: Targets }).strict(),
  z.object({ stage: z.literal('future'), targets: Targets }).strict(),
]);
export type MatchedEvidenceSelection = z.infer<typeof MatchedEvidenceSelectionSchema>;
export function matchedOutputContract(stage: MatchedEvidenceSelection['stage']) {
  return stage === 'diagnosis' ? 'matched-diagnosis-v1' as const
    : stage === 'proposal' ? 'matched-proposal-v1' as const : 'matched-review-v1' as const;
}
export function validateMatchedWorkspaceEnvelope(input: {
  outputContract?: string; toolPolicy: string; matchedExecution?: MatchedCodexExecution;
  matchedEvidence?: MatchedEvidenceSelection;
}, selectionRequired: boolean) {
  const matched = ['matched-diagnosis-v1', 'matched-proposal-v1', 'matched-review-v1'].includes(input.outputContract ?? '');
  if (matched !== !!input.matchedExecution) throw new Error('Matched contracts require explicit matched execution controls, only on matched requests');
  if (!matched && input.matchedEvidence) throw new Error('Matched evidence is only permitted on matched contracts');
  if (!matched) return;
  if (input.toolPolicy !== 'selected-evidence-no-tools-v1') throw new Error('Matched output requires the fixed selected-evidence/no-tools policy');
  if (input.outputContract === 'matched-diagnosis-v1' && !['authored-sdk-native-no-model', 'sdk-native-pending-admission'].includes(input.matchedExecution!.kind)) {
    throw new Error('Matched diagnosis requires an SDK-native execution declaration');
  }
  if ((selectionRequired || input.matchedExecution!.kind === 'sdk-native-pending-admission') && !input.matchedEvidence) {
    throw new Error('Matched workspace request requires its selected evidence binding');
  }
  if (input.matchedEvidence && matchedOutputContract(input.matchedEvidence.stage) !== input.outputContract) {
    throw new Error('Matched evidence stage differs from the fixed output contract');
  }
}
