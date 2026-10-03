import { z } from 'zod';
import { EvaluationWorkspaceBindingSchema } from '../workspace/history-policy.js';
import { DigestSchema } from './model.js';
import { RepositoryIdSchema } from './semantic-rule.js';
import { AnchorTargetJudgmentSchema, FixtureJudgmentSchema, ReviewEvidenceSchema } from './semantic-review-evidence.js';
import { ContextReviewEvidenceSchema, RepositoryContextDigestSetSchema } from './semantic-review-context.js';
import { CodexWorkspaceRequestSchema } from '../workspace/codex-runner.js';

const Text = z.string().min(1).max(16_384).refine(value => !!value.trim(), 'Expected nonblank text');
const unique = (values: readonly string[]) => new Set(values).size === values.length;
/** Model-writable observations only: no execution, truth labels or publication fields. */
export const SemanticReviewModelResponseSchema = z.object({
  ruleDigest: DigestSchema, snapshotDigest: DigestSchema,
  evidence: z.array(ReviewEvidenceSchema).max(1000).refine(values => unique(values.map(v => v.id)), 'Duplicate evidence IDs'),
  judgments: z.array(FixtureJudgmentSchema.safeExtend({ missingContext: z.array(Text).max(100).refine(unique) }))
    .max(500).refine(values => unique(values.map(v => v.targetId)), 'Duplicate judgment targets'),
}).strict();
export type SemanticReviewModelResponse = z.infer<typeof SemanticReviewModelResponseSchema>;
/** Independent target coverage and per-anchor decisions. Legacy response stays immutable. */
export const PerAnchorSemanticReviewModelResponseSchema = z.object({
  ruleDigest: DigestSchema, snapshotDigest: DigestSchema,
  evidence: z.array(ReviewEvidenceSchema).max(1000).refine(values => unique(values.map(v => v.id)), 'Duplicate evidence IDs'),
  judgments: z.array(AnchorTargetJudgmentSchema).max(500)
    .refine(values => unique(values.map(v => v.targetId)), 'Duplicate judgment targets'),
}).strict();
export const ContextSemanticReviewModelResponseSchema = PerAnchorSemanticReviewModelResponseSchema.extend({
  repositoryContextDigests: RepositoryContextDigestSetSchema,
  evidence: z.array(ContextReviewEvidenceSchema).max(1000).refine(values => unique(values.map(v => v.id)), 'Duplicate evidence IDs'),
}).strict();
export type ContextSemanticReviewModelResponse = z.infer<typeof ContextSemanticReviewModelResponseSchema>;
export type PerAnchorSemanticReviewModelResponse = z.infer<typeof PerAnchorSemanticReviewModelResponseSchema>;

export const SemanticReviewModelContextSchema = z.object({ kind: z.literal('full-repository'),
  repository: RepositoryIdSchema, checkout: z.literal('after'), workspace: CodexWorkspaceRequestSchema.shape.workspace,
  evaluation: EvaluationWorkspaceBindingSchema.optional(),
}).strict();
export type SemanticReviewModelContext = z.infer<typeof SemanticReviewModelContextSchema>;
export const SemanticReviewModelLimitsSchema = z.object({
  maxInputBytes: z.number().int().min(1).max(2_000_000),
  maxOutputBytes: z.number().int().min(1).max(1_000_000),
  timeoutMs: z.number().int().min(1).max(300_000),
}).strict();
export type SemanticReviewModelLimits = z.infer<typeof SemanticReviewModelLimitsSchema>;
export const DEFAULT_SEMANTIC_REVIEW_MODEL_LIMITS: SemanticReviewModelLimits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, timeoutMs: 30_000 };
