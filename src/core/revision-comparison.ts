import { z } from 'zod';
import { DigestSchema, IdSchema, VerdictSchema } from './model.js';
import { SemanticReviewSchema, SnapshotAnchorSchema } from './semantic-review.js';
import { ComparisonApplicabilityFixtureSchema, ComparisonApplicabilityBindingSchema } from './comparison-applicability-model.js';
import { ComparisonApplicabilityExecutionReceiptSchema } from './comparison-applicability-execution.js';
import { RepositoryContextDigestSetSchema } from './semantic-review-context.js';

const Text = z.string().min(1).max(16_384).refine(value => !!value.trim(), 'Expected nonblank text');
const unique = (values: string[]) => new Set(values).size === values.length;
const ReviewId = SemanticReviewSchema.shape.id;
export const COMPARISON_LIMITS = { pairs: 16, cases: 200, inputBytes: 16_000_000, resultBytes: 2_000_000 } as const;
export const ComparisonApplicabilityAdjudicationSchema = z.union([
  ComparisonApplicabilityFixtureSchema,
  z.object({ kind: z.literal('comparison-applicability-workspace-execution'), binding: ComparisonApplicabilityBindingSchema, receipt: ComparisonApplicabilityExecutionReceiptSchema }).strict(),
]);
export type ComparisonApplicabilityAdjudication = z.infer<typeof ComparisonApplicabilityAdjudicationSchema>;
export const ComparisonApplicabilityPolicySchema = z.object({
  policyVersion: z.literal('selected-finding-applicability-v1'),
  adjudications: z.array(ComparisonApplicabilityAdjudicationSchema).max(100)
    .refine(values => unique(values.map(value => value.binding.feedbackId)), 'Duplicate applicability feedback claims'),
}).strict();
/** Immutable input selection plus explicitly declared applicability evidence, never a caller report. */
export const RevisionComparisonInputSchema = z.object({
  id: IdSchema, requestDigest: DigestSchema, candidateRuleDigest: DigestSchema,
  applicability: ComparisonApplicabilityPolicySchema.optional(),
  reviewPairs: z.array(z.object({ baseReviewId: ReviewId, candidateReviewId: ReviewId }).strict()).min(1).max(COMPARISON_LIMITS.pairs)
    .refine(values => unique(values.map(v => v.baseReviewId)) && unique(values.map(v => v.candidateReviewId)), 'Duplicate review pair members'),
  caseBindings: z.array(z.object({ caseId: IdSchema, baseReviewId: ReviewId }).strict()).max(COMPARISON_LIMITS.cases)
    .refine(values => unique(values.map(v => v.caseId)), 'Duplicate case binding'),
}).strict();
export type RevisionComparisonInput = z.infer<typeof RevisionComparisonInputSchema>;
export const ComparisonObservationSchema = z.object({
  state: z.enum(['violation', 'safe', 'unknown', 'unscored', 'not_applicable']),
  reason: z.enum(['explicit_semantic_judgment', 'missing_pair', 'missing_case_binding', 'target_not_captured', 'no_assets', 'incomplete_scans', 'zero_hits', 'semantic_not_run', 'semantic_unknown', 'anchor_unscored', 'explicit_not_applicable', 'applicability_unknown', 'scope_still_applicable']),
}).strict();
export type ComparisonObservation = z.infer<typeof ComparisonObservationSchema>;
export const ComparisonOutcomeSchema = z.enum(['preserved', 'corrected', 'regressed', 'still_failing', 'inconclusive']);
export type ComparisonOutcome = z.infer<typeof ComparisonOutcomeSchema>;
const Role = z.enum(['positive', 'negative', 'fixed']);
const State = z.enum(['violation', 'safe', 'unknown']);
const CoverageCount = z.object({ captured: z.number().int().nonnegative(), out_of_scope: z.number().int().nonnegative(),
  unsupported_scope: z.number().int().nonnegative(), deleted: z.number().int().nonnegative(), excluded: z.number().int().nonnegative() }).strict();
export const RevisionComparisonSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('rule-revision-comparison'), input: RevisionComparisonInputSchema,
  // Absence and explicit v2 preserve immutable reports under their original scorer.
  scorer: z.enum(['explicit-semantic-v2', 'per-anchor-semantic-v3', 'per-anchor-context-v4', 'scope-applicability-v5']).optional(),
  baseRuleDigest: DigestSchema, ruleId: IdSchema, baseVersion: IdSchema, candidateVersion: IdSchema,
  reviewBindings: z.array(z.object({ baseReviewId: ReviewId, candidateReviewId: ReviewId, snapshotDigest: DigestSchema, baseReviewDigest: DigestSchema, candidateReviewDigest: DigestSchema, repositoryContextDigests: RepositoryContextDigestSetSchema.optional() }).strict()).max(COMPARISON_LIMITS.pairs),
  problemCaseBindings: z.array(z.object({ caseId: IdSchema, digest: DigestSchema }).strict()).max(COMPARISON_LIMITS.cases),
  cases: z.array(z.object({
    caseId: IdSchema, caseDigest: DigestSchema, baseRole: Role.nullable(), candidateRole: Role.nullable(), expected: State,
    repository: z.string(), commit: z.string(), path: z.string(), sourceDigest: DigestSchema,
    baseReviewId: ReviewId.nullable(), snapshotDigest: DigestSchema.nullable(),
    base: ComparisonObservationSchema, candidate: ComparisonObservationSchema, outcome: ComparisonOutcomeSchema,
  }).strict()).max(COMPARISON_LIMITS.cases),
  feedback: z.array(z.object({
    feedbackId: IdSchema, feedbackDigest: DigestSchema, findingId: z.string(), anchor: SnapshotAnchorSchema, baseReviewId: ReviewId, baseReviewDigest: DigestSchema,
    source: z.enum(['fixture', 'local-human-declared']), label: VerdictSchema.nullable(), expected: State,
    repositoryContextDigests: RepositoryContextDigestSetSchema.optional(),
    base: ComparisonObservationSchema, candidate: ComparisonObservationSchema, outcome: ComparisonOutcomeSchema,
  }).strict()).max(100),
  summary: z.object({
    status: z.enum(['compatible', 'regressed', 'inconclusive']),
    preserved: z.number().int().nonnegative(), corrected: z.number().int().nonnegative(),
    regressed: z.number().int().nonnegative(), stillFailing: z.number().int().nonnegative(), inconclusive: z.number().int().nonnegative(),
  }).strict(),
  coverage: z.object({ base: CoverageCount, candidate: CoverageCount, lostPositiveObligations: z.number().int().nonnegative() }).strict().optional(),
  synthesis: z.literal('not_run'), activation: z.literal('not_performed'),
  trust: z.object({ semanticEvidence: z.enum(['offline-fixture-declarations', 'includes-workspace-execution-receipts']), identity: z.literal('caller-declared-unverified'),
    snapshot: z.literal('package-integrity-only'), scope: z.literal('declared-cases-and-selected-feedback-only'), certification: z.literal('none') }).strict(),
}).strict().superRefine((value, ctx) => {
  if ((value.scorer === 'scope-applicability-v5') !== (value.input.applicability !== undefined && value.coverage !== undefined)) ctx.addIssue({ code: 'custom', message: 'Applicability policy and coverage require the v5 scorer' });
  if (value.scorer !== 'scope-applicability-v5' && (value.input.applicability !== undefined || value.coverage !== undefined || [...value.cases, ...value.feedback].some(row => row.base.state === 'not_applicable' || row.candidate.state === 'not_applicable'))) ctx.addIssue({ code: 'custom', message: 'Legacy comparisons cannot carry applicability semantics' });
  const contextBindings = [...value.reviewBindings, ...value.feedback].filter(binding => binding.repositoryContextDigests !== undefined);
  if (value.scorer !== 'scope-applicability-v5' && (value.scorer === 'per-anchor-context-v4') !== (contextBindings.length > 0)) ctx.addIssue({ code: 'custom', message: 'Context comparison scorer and explicit repository context bindings must agree' });
});
export type RevisionComparison = z.infer<typeof RevisionComparisonSchema>;
export type StoredRevisionComparison = { digest: string; comparison: RevisionComparison };
export const RevisionDecisionInputSchema = z.object({
  id: IdSchema, comparisonDigest: DigestSchema, choice: z.enum(['accept', 'reject', 'defer']),
  actor: Text, source: z.enum(['fixture', 'local-human-declared']), reason: Text, createdAt: z.string().datetime({ offset: true }),
}).strict();
export type RevisionDecisionInput = z.infer<typeof RevisionDecisionInputSchema>;
export const RevisionDecisionSchema = RevisionDecisionInputSchema.extend({
  schemaVersion: z.literal(1), kind: z.literal('local-rule-revision-decision'), requestDigest: DigestSchema,
  candidateRuleDigest: DigestSchema, comparisonStatus: RevisionComparisonSchema.shape.summary.shape.status,
  identityVerification: z.literal('caller-declared-unverified'), activation: z.literal('not_performed'), certification: z.literal('none'),
}).strict();
export type RevisionDecision = z.infer<typeof RevisionDecisionSchema>;
export type StoredRevisionDecision = { digest: string; decision: RevisionDecision };
