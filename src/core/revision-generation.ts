import { z } from 'zod';
import { DigestSchema, IdSchema } from './model.js';
import { SemanticRuleVersionSchema } from './semantic-rule.js';
import { RevisionModelContextSchema, RevisionModelLimitsSchema, REVISION_OPERATOR_POLICY, REVISION_CONTEXT_POLICY, RevisionRepositoryContextBindingsSchema, RevisionNoRuleChangeSchema } from './revision-model.js';
import { CodexWorkspaceLimits, CodexWorkspaceRequestSchema } from '../workspace/codex-runner.js';
import { RevisionWorkspaceWorkerResult } from '../workspace/worker-protocol.js';
import { hasCompletedWorkspaceProcess } from '../workspace/execution-receipt.js';

/** Same application receipt boundary as mining/review; not cryptographic attestation. */
export const RevisionExecutionReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('rule-revision-workspace-execution'),
  requestDigest: DigestSchema, baseRuleDigest: DigestSchema, inputDigest: DigestSchema,
  generationDigest: DigestSchema, promptDigest: DigestSchema, responseDigest: DigestSchema,
  workspaceRequestDigest: DigestSchema, runtimeResultDigest: DigestSchema,
  model: CodexWorkspaceRequestSchema.shape.model, modelIdentity: z.literal('requested-configuration-not-provider-attested'), runtimeId: IdSchema,
  context: RevisionModelContextSchema, generationLimits: RevisionModelLimitsSchema, workspaceLimits: CodexWorkspaceLimits,
  execution: z.literal('completed'), modelExecution: z.enum(['completed', 'not_run']), cleanup: z.literal('verified'),
  completedAt: z.string().datetime({ offset: true }), lifecycle: z.array(z.string().min(1).max(100)).max(32),
  artifacts: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    sha256: DigestSchema, byteLength: z.number().int().nonnegative().max(16_777_216) }).strict()).max(100),
  workerResult: RevisionWorkspaceWorkerResult,
  trust: z.literal('trusted-runtime-receipt-not-cryptographic-attestation'),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.modelExecution !== (receipt.workerResult.boundary === 'authored-test-no-isolation' ? 'not_run' : 'completed')) {
    ctx.addIssue({ code: 'custom', message: 'Revision receipt must preserve authored fixture/model boundary' });
  }
  if (!hasCompletedWorkspaceProcess(receipt.workerResult, receipt.workspaceLimits.maxOutputBytes)) {
    ctx.addIssue({ code: 'custom', message: 'Completed revision worker requires bounded successful supervision and process stop evidence' });
  }
});
export type RevisionExecutionReceipt = z.infer<typeof RevisionExecutionReceiptSchema>;
export const RevisionCandidateInputSchema = z.object({ id: IdSchema, requestDigest: DigestSchema,
  rule: SemanticRuleVersionSchema, executionReceipt: RevisionExecutionReceiptSchema }).strict();
export type RevisionCandidateInput = z.infer<typeof RevisionCandidateInputSchema>;
/** The rule stays in the existing registry. This immutable record only links the
 * request, generated proposal, and execution; it grants no activation authority. */
const RevisionCandidateRecordSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('generated-rule-revision-candidate'), id: IdSchema,
  requestDigest: DigestSchema, baseRuleDigest: DigestSchema, ruleDigest: DigestSchema,
  source: z.enum(['model', 'fixture']), status: z.literal('candidate_requires_review'),
  synthesis: z.enum(['completed', 'not_run']), validation: z.literal('schema-and-exact-provenance-only'),
  diagnosis: z.literal('model-proposal-not-ground-truth'), semanticValidation: z.literal('not_run'),
  regressionExecution: z.literal('not_run'), activation: z.literal('not_performed'), certification: z.literal('none'),
  executionReceipt: RevisionExecutionReceiptSchema,
}).strict();
export const RevisionCandidateSchema = z.discriminatedUnion('schemaVersion', [
  RevisionCandidateRecordSchema,
  RevisionCandidateRecordSchema.extend({ schemaVersion: z.literal(2), policyVersion: z.literal(REVISION_OPERATOR_POLICY),
    operator: z.enum(['boundary_update', 'contract_replacement']),
    validation: z.literal('schema-exact-provenance-and-operator-constraints'),
  }).strict(),
  RevisionCandidateRecordSchema.extend({ schemaVersion: z.literal(3), policyVersion: z.literal(REVISION_OPERATOR_POLICY),
    evidencePolicyVersion: z.literal(REVISION_CONTEXT_POLICY), repositoryContextBindings: RevisionRepositoryContextBindingsSchema,
    operator: z.enum(['boundary_update', 'contract_replacement']),
    validation: z.literal('schema-exact-provenance-operator-and-context-constraints'),
  }).strict(),
]).superRefine((candidate, ctx) => {
  const receipt = candidate.executionReceipt;
  if (receipt.workerResult.outputContract !== `rule-revision-v${candidate.schemaVersion}`) {
    ctx.addIssue({ code: 'custom', message: 'Revision candidate policy/worker contract mismatch' });
  }
  if (candidate.requestDigest !== receipt.requestDigest || candidate.baseRuleDigest !== receipt.baseRuleDigest
    || candidate.synthesis !== receipt.modelExecution || (receipt.modelExecution === 'not_run' && candidate.source !== 'fixture')) {
    ctx.addIssue({ code: 'custom', message: 'Revision candidate execution provenance mismatch' });
  }
});
export type RevisionCandidate = z.infer<typeof RevisionCandidateSchema>;
export type StoredRevisionCandidate = { digest: string; candidate: RevisionCandidate };

export const RevisionNoMutationInputSchema = z.object({ id: IdSchema, requestDigest: DigestSchema,
  candidateCreatedAt: z.string().datetime({ offset: true }), executionReceipt: RevisionExecutionReceiptSchema }).strict();
export type RevisionNoMutationInput = z.infer<typeof RevisionNoMutationInputSchema>;
/** A persisted diagnosis/next-step outcome, never a replacement version or amended finding. */
const LegacyRevisionNoMutationOutcomeSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('rule-revision-no-mutation'), id: IdSchema,
  requestDigest: DigestSchema, baseRuleDigest: DigestSchema, candidateCreatedAt: z.string().datetime({ offset: true }),
  policyVersion: z.literal(REVISION_OPERATOR_POLICY), result: RevisionNoRuleChangeSchema,
  source: z.enum(['model', 'fixture']), synthesis: z.enum(['completed', 'not_run']),
  diagnosis: z.literal('model-proposal-not-ground-truth'), ruleMutation: z.literal('not_performed'),
  reviewRepair: z.literal('not_performed'), activation: z.literal('not_performed'),
  executionReceipt: RevisionExecutionReceiptSchema,
}).strict();
export const RevisionNoMutationOutcomeSchema = z.discriminatedUnion('schemaVersion', [
  LegacyRevisionNoMutationOutcomeSchema,
  LegacyRevisionNoMutationOutcomeSchema.extend({ schemaVersion: z.literal(2),
    evidencePolicyVersion: z.literal(REVISION_CONTEXT_POLICY), repositoryContextBindings: RevisionRepositoryContextBindingsSchema,
  }).strict(),
]).superRefine((outcome, ctx) => {
  if (outcome.executionReceipt.workerResult.outputContract !== (outcome.schemaVersion === 1 ? 'rule-revision-v2' : 'rule-revision-v3')) {
    ctx.addIssue({ code: 'custom', message: 'Revision outcome policy/worker contract mismatch' });
  }
});
export type StoredRevisionNoMutationOutcome = { digest: string; outcome: z.infer<typeof RevisionNoMutationOutcomeSchema> };
