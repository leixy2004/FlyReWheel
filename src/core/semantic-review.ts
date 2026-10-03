import { z } from 'zod';
import { DigestSchema, IdSchema, VerdictSchema } from './model.js';
import { digestOf } from './identity.js';
import { deriveVerdict } from './evaluation.js';
import { SemanticReviewExecutionReceiptSchema } from './semantic-review-execution.js';

const Text = z.string().min(1).max(16_384).refine(value => !!value.trim(), 'Expected nonblank text');
const Path = z.string().min(1).max(4096);
const unique = (items: readonly string[]) => new Set(items).size === items.length;
export const REVIEW_LIMITS = { assets: 16, scannerCalls: 256, scannerBytes: 8_388_608, occurrences: 1000, candidatesPerScan: 100, jsonBytes: 4_000_000 } as const;

export * from './semantic-review-evidence.js';
import { AnchorTargetJudgmentSchema, FixtureJudgmentSchema, ReviewEvidenceSchema, SnapshotAnchorSchema } from './semantic-review-evidence.js';
import type { SnapshotAnchor } from './semantic-review-evidence.js';
import { ContextReviewEvidenceSchema, RepositoryContextDigestSetSchema, ReviewRepositoryContextsSchema } from './semantic-review-context.js';
export const LegacyReviewFixtureSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('semantic-review-offline-fixtures'), ruleDigest: DigestSchema, snapshotDigest: DigestSchema,
  evidence: z.array(ReviewEvidenceSchema).max(1000).refine(values => unique(values.map(v => v.id)), 'Duplicate evidence IDs'),
  judgments: z.array(FixtureJudgmentSchema).max(500).refine(values => unique(values.map(v => v.targetId)), 'Duplicate fixture targets'),
}).strict();
export type LegacyReviewFixture = z.infer<typeof LegacyReviewFixtureSchema>;
export const AnchorReviewFixtureSchema = LegacyReviewFixtureSchema.extend({
  schemaVersion: z.literal(2),
  judgments: z.array(AnchorTargetJudgmentSchema).max(500).refine(values => unique(values.map(v => v.targetId)), 'Duplicate fixture targets'),
}).strict();
export type AnchorReviewFixture = z.infer<typeof AnchorReviewFixtureSchema>;
export const ContextReviewFixtureSchema = AnchorReviewFixtureSchema.extend({
  schemaVersion: z.literal(3), repositoryContextDigests: RepositoryContextDigestSetSchema,
  evidence: z.array(ContextReviewEvidenceSchema).max(1000).refine(values => unique(values.map(v => v.id)), 'Duplicate evidence IDs'),
}).strict();
export type ContextReviewFixture = z.infer<typeof ContextReviewFixtureSchema>;
export const ReviewFixtureSchema = z.discriminatedUnion('schemaVersion', [LegacyReviewFixtureSchema, AnchorReviewFixtureSchema, ContextReviewFixtureSchema]);
export type ReviewFixture = z.infer<typeof ReviewFixtureSchema>;
export const ReviewConfigSchema = z.object({
  runtime: z.enum(['semantic-snapshot-review-v1', 'semantic-snapshot-review-v2', 'semantic-snapshot-review-v3']), scanner: z.literal('ast-grep@0.45.3'),
  mode: z.enum(['structural_only', 'offline_fixture', 'workspace_execution']), fixtureDigest: DigestSchema.nullable(), attempt: Text,
  executionDigest: DigestSchema.optional(), repositoryContextDigests: RepositoryContextDigestSetSchema.optional(),
}).strict().refine(v => (v.mode === 'offline_fixture') === (v.fixtureDigest !== null), 'Fixture mode requires an exact fixture digest')
  .refine(v => (v.mode === 'workspace_execution') === (v.executionDigest !== undefined), 'Workspace mode requires an exact execution digest')
  .refine(v => (v.runtime === 'semantic-snapshot-review-v3') === (v.repositoryContextDigests !== undefined), 'Context-aware runtime requires an exact context selection');
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export const ReviewScanSchema = z.object({
  assetId: IdSchema, engine: z.enum(['ast-grep', 'semgrep', 'opengrep']),
  state: z.enum(['scanned', 'unsupported_engine', 'unsupported_language', 'language_mismatch', 'execution_error', 'budget_exceeded']),
  candidateCount: z.number().int().min(0).max(100).nullable(), reason: Text.nullable(),
}).strict().refine(v => v.state === 'scanned' ? v.candidateCount !== null && v.reason === null : v.candidateCount === null && v.reason !== null, 'Scan state and coverage disagree');
export const ReviewTargetSchema = z.object({
  id: DigestSchema, changeIndex: z.number().int().min(0).max(499), path: Path, sourceDigest: DigestSchema.nullable(),
  disposition: z.enum(['captured', 'out_of_scope', 'unsupported_scope', 'deleted', 'excluded']), reason: Text.nullable(),
  scans: z.array(ReviewScanSchema).max(REVIEW_LIMITS.assets),
  semantic: z.object({ state: z.enum(['not_run', 'unknown', 'safe', 'violation']), reasoning: Text, missingContext: z.array(Text) }).strict(),
}).strict();
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
export const ReviewOccurrenceSchema = z.object({
  id: DigestSchema, targetId: DigestSchema, assetId: IdSchema, candidateId: DigestSchema,
  engine: z.literal('ast-grep'), language: Text, anchor: SnapshotAnchorSchema,
}).strict();
export type ReviewOccurrence = z.infer<typeof ReviewOccurrenceSchema>;
export const ReviewFindingSchema = z.object({
  id: z.string().regex(/^review_finding_[a-f0-9]{64}$/), reviewId: z.string().regex(/^review_[a-f0-9]{64}$/),
  ruleDigest: DigestSchema, snapshotDigest: DigestSchema, ruleId: IdSchema, ruleVersion: IdSchema, targetId: DigestSchema,
  anchor: SnapshotAnchorSchema, occurrenceIds: z.array(DigestSchema).max(REVIEW_LIMITS.occurrences).refine(unique),
  status: z.enum(['not_verified', 'unknown', 'safe', 'violation']), origin: z.enum(['structural', 'fixture', 'model', 'evidence_gate']),
  reasoning: Text, evidenceRefs: z.array(DigestSchema).max(1000).refine(unique),
  introduction: z.literal('unverified'), notificationEligibility: z.literal('unverified'),
}).strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export const SemanticReviewSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('semantic-snapshot-review'), id: z.string().regex(/^review_[a-f0-9]{64}$/),
  ruleDigest: DigestSchema, snapshotDigest: DigestSchema, config: ReviewConfigSchema, fixtures: ReviewFixtureSchema.nullable(),
  executionReceipt: SemanticReviewExecutionReceiptSchema.optional(),
  repositoryContexts: ReviewRepositoryContextsSchema.optional(),
  coverage: z.object({
    scope: z.literal('changed-entries-only'), snapshotVerification: z.literal('package-integrity-only'),
    repositoryContext: z.literal('incomplete'), introduction: z.literal('unverified'),
    targets: z.array(ReviewTargetSchema).max(500),
  }).strict(),
  occurrences: z.array(ReviewOccurrenceSchema).max(REVIEW_LIMITS.occurrences), findings: z.array(ReviewFindingSchema).max(2000),
  notification: z.literal('not_performed'),
}).strict();
export type SemanticReview = z.infer<typeof SemanticReviewSchema>;
export function semanticReviewId(ruleDigest: string, snapshotDigest: string, config: ReviewConfig): string {
  return `review_${digestOf({ ruleDigest, snapshotDigest, config })}`;
}
export function reviewTargetId(ruleDigest: string, snapshotDigest: string, changeIndex: number, path: string, sourceDigest: string | null): string {
  return digestOf({ ruleDigest, snapshotDigest, changeIndex, side: 'after', path, sourceDigest });
}
export function reviewFindingId(reviewId: string, anchor: SnapshotAnchor): string { return `review_finding_${digestOf({ reviewId, anchor })}`; }

/** A local declaration is not authenticated identity. Fixture labels never become human verdicts. */
export const LocalReviewFeedbackSchema = z.object({
  id: IdSchema, findingId: z.string().regex(/^review_finding_[a-f0-9]{64}$/), reviewId: z.string().regex(/^review_[a-f0-9]{64}$/),
  ruleDigest: DigestSchema, ruleVersion: IdSchema, source: z.enum(['fixture', 'local-human-declared']), actor: Text,
  kind: z.enum(['label', 'resolve', 'merge', 'note']), label: VerdictSchema.nullable(), reason: Text,
  createdAt: z.string().datetime({ offset: true }),
}).strict().refine(v => (v.kind === 'label') === (v.label !== null), 'Only label events carry a label; label events require a label');
export type LocalReviewFeedback = z.infer<typeof LocalReviewFeedbackSchema>;
export function deriveLocalReviewVerdict(input: readonly LocalReviewFeedback[]) {
  return deriveVerdict(input.map(value => LocalReviewFeedbackSchema.parse(value)).filter(v => v.source === 'local-human-declared').map(v => ({
    id: v.id, findingId: v.findingId, bundleDigest: v.ruleDigest, ruleVersion: v.ruleVersion,
    actor: v.actor, source: 'human' as const, kind: v.kind, label: v.label, reason: v.reason, createdAt: v.createdAt,
  })));
}
export const RevisionRequestInputSchema = z.object({
  id: IdSchema, baseRuleDigest: DigestSchema, requestedRuleVersion: IdSchema,
  feedbackIds: z.array(IdSchema).min(1).max(100).refine(unique, 'Duplicate feedback IDs'),
  requestedChange: Text, actor: Text, source: z.enum(['fixture', 'local-human-declared']), createdAt: z.string().datetime({ offset: true }),
}).strict();
export type RevisionRequestInput = z.infer<typeof RevisionRequestInputSchema>;
export const RevisionRequestSchema = RevisionRequestInputSchema.extend({
  schemaVersion: z.literal(1), kind: z.literal('rule-revision-request'), status: z.literal('pending'),
  feedbackBindings: z.array(z.object({ id: IdSchema, digest: DigestSchema }).strict()).min(1).max(100),
  synthesis: z.literal('not_run'),
}).strict();
export type RevisionRequest = z.infer<typeof RevisionRequestSchema>;
export type StoredRevisionRequest = { digest: string; request: RevisionRequest };
