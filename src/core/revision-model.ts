import { z } from 'zod';
import { EvaluationWorkspaceBindingSchema } from '../workspace/history-policy.js';
import { DigestSchema, IdSchema } from './model.js';
import { RuleProposalSchema, PrMiningModelLimitsSchema, DEFAULT_PR_MINING_MODEL_LIMITS } from './pr-mining-model.js';
import { CodexWorkspaceRequestSchema } from '../workspace/codex-runner.js';
import { RepositoryContextDigestSetSchema } from './semantic-review-context.js';

const Text = z.string().min(1).max(8192).refine(value => !!value.trim(), 'Expected nonblank text');
const Refs = z.array(z.string().min(1).max(300)).max(300);
/** Diagnosis is a model proposal about selected feedback, never a replacement verdict. */
export const RevisionDiagnosisSchema = z.object({
  feedbackId: IdSchema,
  category: z.enum(['judgment', 'context', 'boundary', 'contract', 'insufficient_evidence']),
  reasoning: Text, missingEvidence: z.array(Text).max(32), evidenceRefs: Refs.min(1),
  claim: z.literal('proposal-not-established-fact'),
}).strict();
const Diagnoses = z.array(RevisionDiagnosisSchema).min(1).max(100);
export const LegacyRevisionModelResponseSchema = z.object({
  requestDigest: DigestSchema, baseRuleDigest: DigestSchema, requestedRuleVersion: IdSchema,
  result: z.discriminatedUnion('status', [
    RuleProposalSchema.extend({ diagnoses: Diagnoses, evidenceRefs: Refs.min(1) }).strict(),
    z.object({ status: z.literal('insufficient_evidence'), reasoning: Text,
      missingEvidence: z.array(Text).max(32), evidenceRefs: Refs, diagnoses: Diagnoses }).strict(),
  ]),
}).strict();
/** v1 remains byte-for-byte schema compatible for historical receipt rederivation. */
export const REVISION_OPERATOR_POLICY = 'diagnosis-operators-v1' as const;
export const RevisionPolicyDiagnosisSchema = RevisionDiagnosisSchema.extend({
  category: z.enum(['judgment', 'context', 'boundary', 'contract', 'insufficient_evidence', 'mixed']),
}).strict();
const PolicyDiagnoses = z.array(RevisionPolicyDiagnosisSchema).min(1).max(100);
/** Declared transition evidence is review material, not verified history or executable routing. */
export const ContractReplacementSchema = z.object({
  priorRuleDigest: DigestSchema, previousContract: Text, proposedContract: Text,
  evidenceRefs: Refs.min(1),
  retirement: z.object({ status: z.literal('proposed_requires_review'),
    oldRuleAppliesWhen: Text, replacementAppliesWhen: Text, rationale: Text,
    activation: z.literal('not_performed'),
  }).strict(),
}).strict();
export const RevisionNoRuleChangeSchema = z.object({
  status: z.literal('no_rule_change'), operator: z.enum(['retain_rule', 'request_context', 'abstain']),
  reasoning: Text, nextStep: Text, missingEvidence: z.array(Text).max(32), evidenceRefs: Refs,
  diagnoses: PolicyDiagnoses,
}).strict();
export const RevisionModelResponseSchema = z.object({
  policyVersion: z.literal(REVISION_OPERATOR_POLICY),
  requestDigest: DigestSchema, baseRuleDigest: DigestSchema, requestedRuleVersion: IdSchema,
  result: z.discriminatedUnion('status', [
    RuleProposalSchema.extend({ operator: z.enum(['boundary_update', 'contract_replacement']),
      replacement: ContractReplacementSchema.nullable(), diagnoses: PolicyDiagnoses, evidenceRefs: Refs.min(1) }).strict(),
    RevisionNoRuleChangeSchema,
  ]),
}).strict();
/** v3 binds selected context without changing either historical response schema. */
export const REVISION_CONTEXT_POLICY = 'selected-context-evidence-v1' as const;
export const RevisionRepositoryContextBindingSchema = z.object({
  feedbackId: IdSchema, reviewId: z.string().regex(/^review_[a-f0-9]{64}$/), reviewDigest: DigestSchema, snapshotDigest: DigestSchema,
  repositoryContextDigests: RepositoryContextDigestSetSchema,
  // Only context citations on this exact selected finding, not all review evidence.
  evidenceRefs: z.array(DigestSchema).max(1000)
    .refine(values => values.every((value, i) => i === 0 || values[i - 1] < value), 'Context citation IDs must be unique and sorted'),
}).strict();
export const RevisionRepositoryContextBindingsSchema = z.array(RevisionRepositoryContextBindingSchema).min(1).max(100)
  .refine(values => new Set(values.map(value => value.feedbackId)).size === values.length, 'Duplicate context feedback binding');
export const ContextRevisionModelResponseSchema = RevisionModelResponseSchema.extend({
  evidencePolicyVersion: z.literal(REVISION_CONTEXT_POLICY), repositoryContextBindings: RevisionRepositoryContextBindingsSchema,
}).strict();
export type RevisionOutputContract = 'rule-revision-v1' | 'rule-revision-v2' | 'rule-revision-v3';
export type RevisionModelResponse = z.infer<typeof RevisionModelResponseSchema>;
export type AnyRevisionModelResponse = RevisionModelResponse | z.infer<typeof ContextRevisionModelResponseSchema> | z.infer<typeof LegacyRevisionModelResponseSchema>;
export const RevisionModelLimitsSchema = PrMiningModelLimitsSchema;
export const DEFAULT_REVISION_MODEL_LIMITS = DEFAULT_PR_MINING_MODEL_LIMITS;
export type RevisionModelLimits = z.infer<typeof RevisionModelLimitsSchema>;
/** Workspace is lifecycle infrastructure only; the model receives selected evidence
 * with repository tools disabled by trusted worker configuration. This does not
 * attest isolation. All-local-refs is NOT a temporal evaluation split. */
export const RevisionModelContextSchema = z.object({
  kind: z.literal('selected-evidence-no-tools'),
  workspace: CodexWorkspaceRequestSchema.shape.workspace,
  snapshotDigest: DigestSchema,
  evaluation: EvaluationWorkspaceBindingSchema.optional(),
}).strict();
export type RevisionModelContext = z.infer<typeof RevisionModelContextSchema>;
export const REVISION_GENERATION_LIMITS = { feedback: 100, cases: 200, snapshots: 100,
  inputGraphBytes: 16_000_000, recordBytes: 2_000_000, listBytes: 16_000_000 } as const;
