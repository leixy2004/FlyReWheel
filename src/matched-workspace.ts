import { z } from 'zod';
import { digestOf } from './core/identity.js';
import { MatchedDiagnosisSchema, ProposalSchema, ReviewSchema, SdkNativeMatchedRequestSchema,
  type SdkNativeMatchedRequest } from './core/matched-revision-model.js';
import { CodexWorkspaceRequestSchema, type CodexWorkspaceRequest, type WorkspaceLimits } from './workspace/codex-runner.js';
import { boundedJson, freeze } from './workspace/execution-receipt.js';
import { MatchedEvidenceSelectionSchema, matchedOutputContract, type MatchedEvidenceSelection } from './workspace/matched-request.js';
import { SDK_NATIVE_MATCHED_PROFILE } from './workspace/matched-codex-policy.js';

/** Pure preparation for the existing external workspace transport. Neither this
 * declaration nor a call-record/authorization digest grants dispatch authority.
 * The runner, OpenSandbox reserve and inner worker independently fail closed. */
export function buildSdkNativeMatchedWorkspaceRequest(raw: SdkNativeMatchedRequest,
  context: Pick<CodexWorkspaceRequest, 'workspace' | 'expectedSha' | 'historyPolicy' | 'evaluation'>,
  evidence: MatchedEvidenceSelection, limits: WorkspaceLimits) {
  const input = SdkNativeMatchedRequestSchema.parse(raw), selected = MatchedEvidenceSelectionSchema.parse(evidence);
  if (selected.stage !== input.stage) throw new Error('Matched request and selected evidence stages differ');
  const schema = input.stage === 'diagnosis' ? MatchedDiagnosisSchema : input.stage === 'proposal' ? ProposalSchema : ReviewSchema;
  if (digestOf(input.outputSchema) !== digestOf(z.toJSONSchema(schema))) throw new Error('Matched request must use the fixed stage output schema');
  const request = CodexWorkspaceRequestSchema.parse({ ...context, model: input.model, prompt: input.prompt,
    ...(input.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: input.modelReasoningEffort }),
    outputContract: matchedOutputContract(input.stage), toolPolicy: 'selected-evidence-no-tools-v1',
    matchedExecution: { kind: 'sdk-native-pending-admission', profile: SDK_NATIVE_MATCHED_PROFILE },
    matchedEvidence: selected, limits });
  boundedJson(request, request.limits.maxInputBytes, 'Matched workspace request');
  return freeze(request);
}
