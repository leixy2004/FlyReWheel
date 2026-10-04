import { EvaluationWorkspaceBindingSchema } from '../workspace/history-policy.js';
import { z } from 'zod';
import { IdSchema } from './model.js';
import { RuleProposalSchema } from './pr-mining-model.js';
import { ContractReplacementSchema, RevisionPolicyDiagnosisSchema } from './revision-model.js';
import { MatchedRequiredControlsSchema } from '../workspace/matched-codex-policy.js';
import { CodexModelReasoningEffortSchema } from './codex-model-settings.js';

// Shared fixed response contracts. Arm-specific policy, execution identity,
// provenance and activation authority are never model-writable.
const Text = z.string().min(1).max(32_768).refine(s => !!s.trim(), 'Expected nonblank text');
const Refs = z.array(z.string().min(1).max(300)).max(300).refine(xs => new Set(xs).size === xs.length, 'Duplicate references');
/** Separate shared diagnosis only: no proposal, state, arm or provenance fields.
 * Context status remains a proposed assessment, never verified evidence. */
export const MatchedDiagnosisSchema = z.object({
  diagnoses: z.array(RevisionPolicyDiagnosisSchema).min(1).max(100),
  originalContextStatus: z.enum(['decisive_evidence_present', 'decisive_evidence_absent', 'unknown']),
  revisionContextStatus: z.enum(['sufficient', 'restored_before_revision', 'still_missing', 'unknown']),
}).strict();
export type MatchedDiagnosis = z.infer<typeof MatchedDiagnosisSchema>;
export const RuleContentSchema = RuleProposalSchema.pick({ semantics: true, paths: true, detectionAssets: true });
export type RuleContent = z.infer<typeof RuleContentSchema>;
export const StructuredStateSchema = z.object({ kind: z.literal('structured'), content: RuleContentSchema }).strict();
export const MemoryDeltaSchema = z.object({
  operation: z.enum(['revise', 'qualify', 'suppress']), text: Text,
}).strict();
/** One immutable lossless initial lesson and at most one local delta. No transcript or global memory. */
export const MemoryStateSchema = z.object({
  kind: z.literal('scoped_memory'), initialLesson: Text, delta: MemoryDeltaSchema.nullable(),
}).strict();
export const PersistentStateSchema = z.discriminatedUnion('kind', [StructuredStateSchema, MemoryStateSchema]);
export type PersistentState = z.infer<typeof PersistentStateSchema>;
/** U and H share this exact envelope. Diagnoses, labels, identity and provenance are not writable. */
export const ProposalSchema = z.object({
  action: z.enum(['revise', 'retain', 'abstain', 'request_context']),
  state: PersistentStateSchema.nullable(), replacement: ContractReplacementSchema.nullable(),
  rationale: Text, evidenceRefs: Refs, missingEvidence: z.array(Text).max(32), nextStep: Text.nullable(),
}).strict();
export type Proposal = z.infer<typeof ProposalSchema>;
export const JudgmentSchema = z.object({
  targetId: IdSchema, prediction: z.enum(['violation', 'safe', 'not_applicable', 'unresolved']),
  reason: z.enum(['judgment', 'abstained', 'missing_context', 'scope_excluded', 'unsupported_input']),
  rationale: Text, evidenceRefs: Refs, missingEvidence: z.array(Text).max(32),
}).strict();
export type Judgment = z.infer<typeof JudgmentSchema>;
export const ReviewSchema = z.object({ judgments: z.array(JudgmentSchema).max(200) }).strict();

/** The schema is checked against the fixed stage contract before any dispatch. */
export const MatchedModelRequestSchema = MatchedRequiredControlsSchema.extend({
  stage: z.enum(['proposal', 'gate', 'future']), model: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/),
  modelReasoningEffort: CodexModelReasoningEffortSchema.optional(),
  prompt: z.string().min(1).max(2_097_152), outputSchema: z.unknown(),
}).strict();
export type MatchedModelRequest = z.infer<typeof MatchedModelRequestSchema>;

/** Separately identified native request. Unsupported generation controls cannot
 * be smuggled into this envelope or confused with the frozen legacy request. */
export const NativeEvaluationContextSchema = z.object({
  purpose: z.literal('offline-study'), semantics: z.literal('verified-source-provenance-only'),
  bindings: z.array(EvaluationWorkspaceBindingSchema).min(1).max(64),
}).strict();
export type NativeEvaluationContext = z.infer<typeof NativeEvaluationContextSchema>;

export const SdkNativeMatchedRequestSchema = MatchedModelRequestSchema.omit({ sampler: true, maxOutputTokens: true })
  .extend({ stage: z.enum(['diagnosis', 'proposal', 'gate', 'future']),
    profile: z.literal('paired-restriction-sdk-native-v1-draft'), evaluation: NativeEvaluationContextSchema.optional() }).strict();
export type SdkNativeMatchedRequest = z.infer<typeof SdkNativeMatchedRequestSchema> & { sampler?: never; maxOutputTokens?: never };
