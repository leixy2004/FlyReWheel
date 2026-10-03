import { z } from 'zod';
import { DigestSchema, IdSchema } from './model.js';
import { SnapshotAnchorSchema } from './semantic-review-evidence.js';
import { ContextReviewEvidenceSchema } from './semantic-review-context.js';

const Text = z.string().min(1).max(16_384).refine(value => !!value.trim(), 'Expected nonblank text');
const unique = (values: string[]) => new Set(values).size === values.length;
/** A separate comparison claim, never permission to review outside a rule's scope. */
export const ComparisonApplicabilityBindingSchema = z.object({
  policy: z.literal('selected-finding-applicability-v1'),
  requestDigest: DigestSchema, baseRuleDigest: DigestSchema, candidateRuleDigest: DigestSchema,
  baseVersion: IdSchema, candidateVersion: IdSchema,
  baseReviewId: z.string().regex(/^review_[a-f0-9]{64}$/), baseReviewDigest: DigestSchema,
  candidateReviewId: z.string().regex(/^review_[a-f0-9]{64}$/), candidateReviewDigest: DigestSchema,
  snapshotDigest: DigestSchema, repository: z.string().min(1).max(4096), head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  feedbackId: IdSchema, feedbackDigest: DigestSchema,
  findingId: z.string().regex(/^review_finding_[a-f0-9]{64}$/), findingDigest: DigestSchema,
  anchor: SnapshotAnchorSchema,
  repositoryContextDigests: z.array(DigestSchema).max(8).refine(values => values.every((value, i) => i === 0 || values[i - 1] < value), 'Context digests must be sorted and unique'),
}).strict();
export type ComparisonApplicabilityBinding = z.infer<typeof ComparisonApplicabilityBindingSchema>;
export const ComparisonApplicabilityModelResponseSchema = z.object({
  bindingDigest: DigestSchema, decision: z.enum(['NOT_APPLICABLE', 'APPLICABLE', 'UNKNOWN']), reasoning: Text,
  evidence: z.array(ContextReviewEvidenceSchema).max(100).refine(values => unique(values.map(value => value.id)), 'Duplicate evidence IDs'),
  evidenceRefs: z.array(DigestSchema).max(100).refine(unique, 'Duplicate evidence references'),
  missingContext: z.array(Text).max(100).refine(unique, 'Duplicate missing context'),
}).strict();
export type ComparisonApplicabilityModelResponse = z.infer<typeof ComparisonApplicabilityModelResponseSchema>;
export const ComparisonApplicabilityFixtureSchema = z.object({
  kind: z.literal('comparison-applicability-offline-fixture'), binding: ComparisonApplicabilityBindingSchema,
  response: ComparisonApplicabilityModelResponseSchema,
}).strict();
export type ComparisonApplicabilityFixture = z.infer<typeof ComparisonApplicabilityFixtureSchema>;
