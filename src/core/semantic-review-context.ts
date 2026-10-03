import { z } from 'zod';
import { DigestSchema } from './model.js';
import { digestOf } from './identity.js';
import { RepositoryContextSchema, RepositoryContextEvidenceSchema } from '../repository-context.js';
import { ReviewEvidenceSchema } from './semantic-review-evidence.js';

/** A frozen selection, not an instruction to discover or capture more files. */
export const REVIEW_CONTEXT_LIMITS = { packages: 8, selectedPaths: 128, capturedBytes: 1_048_576, jsonBytes: 2_000_000 } as const;
export const RepositoryContextDigestSetSchema = z.array(DigestSchema).min(1).max(REVIEW_CONTEXT_LIMITS.packages)
  .refine(values => values.every((value, i) => i === 0 || values[i - 1] < value), 'Repository context digests must be unique and canonically sorted');
export const StoredReviewRepositoryContextSchema = z.object({ digest: DigestSchema, context: RepositoryContextSchema }).strict()
  .refine(value => digestOf(value.context) === value.digest, 'Repository context digest mismatch');
export const ReviewRepositoryContextsSchema = z.array(StoredReviewRepositoryContextSchema).min(1).max(REVIEW_CONTEXT_LIMITS.packages);
/** Only the new contract accepts this union. Historical evidence stays unchanged. */
export const ContextReviewEvidenceSchema = z.union([ReviewEvidenceSchema, RepositoryContextEvidenceSchema]);
export type ContextReviewEvidence = z.infer<typeof ContextReviewEvidenceSchema>;
