import { z } from 'zod';
import { DigestSchema } from './core/model.js';
import { digestOf } from './core/identity.js';
import { ReviewFindingSchema } from './core/semantic-review.js';
import { RepositoryContextDigestSetSchema } from './core/semantic-review-context.js';
import { ApplicationLogicalIdSchema, ApplicationJobSchema, applicationJobDigest, applicationJobSummary, type ApplicationJob } from './application-job-contract.js';
import { createApplicationJobDispatcher, type ApplicationDispatcherDependencies } from './application-dispatcher.js';
import type { QualEvoStore } from './storage/store.js';

/** A new explicit product action; never an amendment to a frozen revision experiment. */
export const ReviewContinuationInputSchema = z.object({
  id: ApplicationLogicalIdSchema, outcomeDigest: DigestSchema, findingId: ReviewFindingSchema.shape.id,
  repositoryContextDigests: RepositoryContextDigestSetSchema,
  workspaceId: ApplicationLogicalIdSchema, attempt: ApplicationLogicalIdSchema.default('initial'),
}).strict();
export type ReviewContinuationInput = z.input<typeof ReviewContinuationInputSchema>;
export const ReviewContinuationSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('explicit-review-continuation'), input: ReviewContinuationInputSchema,
  requestDigest: DigestSchema, ruleDigest: DigestSchema, snapshotDigest: DigestSchema,
  sourceReviewId: ReviewFindingSchema.shape.reviewId,
  reviewSelection: z.literal('explicit-digest-replay-not-governance-governed'),
  scope: z.literal('full-snapshot-review-single-anchor-followup'),
  originalRecords: z.literal('unchanged'), experimentAttribution: z.literal('separate-product-action'),
}).strict();
export type StoredReviewContinuation = { digest: string; continuation: z.infer<typeof ReviewContinuationSchema> };
export function reviewContinuationJob(stored: StoredReviewContinuation): Extract<ApplicationJob, { kind: 'semantic-review' }> {
  const plan = ReviewContinuationSchema.parse(stored.continuation);
  if (digestOf(plan) !== stored.digest) throw new Error('Review continuation digest mismatch');
  return ApplicationJobSchema.options[1].parse({ schemaVersion: 1, kind: 'semantic-review',
    ruleDigest: plan.ruleDigest, snapshotDigest: plan.snapshotDigest, continuationDigest: stored.digest,
    repositoryContextDigests: plan.input.repositoryContextDigests, workspaceId: plan.input.workspaceId, attempt: plan.input.attempt });
}
export async function runReviewContinuation(dependencies: ApplicationDispatcherDependencies, digest: string, signal: AbortSignal) {
  const stored = await dependencies.store.getReviewContinuation(digest);
  await createApplicationJobDispatcher(dependencies)(reviewContinuationJob(stored), signal);
  return reviewContinuationStatus(dependencies.store, digest);
}
export async function reviewContinuationStatus(store: QualEvoStore, digest: string) {
  const stored = await store.getReviewContinuation(digest), job = reviewContinuationJob(stored);
  const jobDigest = applicationJobDigest(job), record = await store.getApplicationJob(jobDigest);
  let assessment: 'not_run' | 'not_adjudicated' | 'unknown' | 'safe' | 'violation' = 'not_run';
  let reviewId: string | null = null, findingId: string | null = null;
  if (record?.result?.status === 'completed') {
    const outcome = record.result.outcome!;
    const review = await store.getSemanticReview(outcome.id);
    if (outcome.kind !== 'semantic-review' || digestOf(review) !== outcome.digest
      || review.ruleDigest !== job.ruleDigest || review.snapshotDigest !== job.snapshotDigest
      || review.config.attempt !== `application-${jobDigest}`
      || digestOf(review.config.repositoryContextDigests) !== digestOf(job.repositoryContextDigests)) {
      throw new Error('Review continuation result binding mismatch');
    }
    const original = (await store.getReviewFinding(stored.continuation.input.findingId)).finding;
    const exact = review.findings.find(finding => digestOf(finding.anchor) === digestOf(original.anchor));
    reviewId = review.id; findingId = exact?.id ?? null;
    // Silence and structural occurrences never establish repair or an anchor-safe result.
    assessment = !exact || exact.status === 'not_verified' ? 'not_adjudicated' : exact.status;
  }
  return { ...stored, jobDigest, state: record?.result?.status ?? record?.state ?? 'not_started',
    attempts: record?.attempts ?? 0, result: record?.result ? applicationJobSummary(record.result) : null,
    reviewId, findingId, assessment, assessmentMeaning: 'new-review-declaration-not-repair-certification',
    activation: 'not_performed', notification: 'not_performed', certification: 'none' };
}
