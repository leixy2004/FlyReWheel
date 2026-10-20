import { z } from 'zod';
import { LocalReviewFeedbackSchema } from './core/semantic-review.js';
import type { QualEvoStore } from './storage/store.js';

const fields = LocalReviewFeedbackSchema.shape;
/** Caller-authored fields only; review/rule identities must come from stored evidence. */
const Selection = z.object({
  id: fields.id, findingId: fields.findingId, source: fields.source, actor: fields.actor,
  kind: fields.kind, label: fields.label, reason: fields.reason, createdAt: fields.createdAt,
}).strict();

/** Prepare existing feedback JSON without appending feedback or triggering any downstream action. */
export async function prepareReviewFeedback(store: Pick<QualEvoStore, 'getReviewFinding'>, input: unknown) {
  const selected = Selection.parse(input);
  const { finding } = await store.getReviewFinding(selected.findingId);
  return LocalReviewFeedbackSchema.parse({ ...selected,
    reviewId: finding.reviewId, ruleDigest: finding.ruleDigest, ruleVersion: finding.ruleVersion });
}
