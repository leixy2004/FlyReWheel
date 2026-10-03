import { z } from 'zod';
import { DigestSchema } from './core/model.js';
import { HistoryPlanPackageSchema } from './github-pr-history.js';
import { GithubHttpFailureDiagnosticSchema } from './github-pr-diagnostics.js';

export const HistoryItemSchema = z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['pending', 'capturing', 'captured', 'failed']),
  attempts: z.number().int().nonnegative().max(1_000_000),
  lastAttemptAt: z.string().datetime().nullable(),
  failure: z.enum(['capture-failed', 'rate-limited', 'forbidden-or-rate-limited', 'out-of-filter', 'interrupted', 'request-budget', 'deadline', 'evidence-budget']).nullable(),
  failureDiagnostic: GithubHttpFailureDiagnosticSchema.optional(),
  evidenceDigest: DigestSchema.nullable(), snapshotDigest: DigestSchema.nullable(),
  miningRequestDigests: z.array(DigestSchema).max(20),
}).strict().superRefine((item, ctx) => {
  const invalid = () => ctx.addIssue({ code: 'custom', message: 'Inconsistent PR history progress' });
  if ((item.status === 'captured') !== (item.evidenceDigest !== null && item.snapshotDigest !== null)) invalid();
  if (item.status !== 'captured' && (item.evidenceDigest !== null || item.snapshotDigest !== null || item.miningRequestDigests.length > 0)) invalid();
  if ((item.status === 'failed') !== (item.failure !== null)) invalid();
  if (item.failureDiagnostic !== undefined && item.status !== 'failed') invalid();
  if ((item.attempts === 0) !== (item.lastAttemptAt === null) || (item.status === 'pending') !== (item.attempts === 0)) invalid();
  if (new Set(item.miningRequestDigests).size !== item.miningRequestDigests.length || item.miningRequestDigests.some((value, index) => index > 0 && item.miningRequestDigests[index - 1] >= value)) invalid();
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;
export const HistoryBatchSchema = z.object({
  digest: DigestSchema, plan: HistoryPlanPackageSchema.shape.plan,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  items: z.array(HistoryItemSchema).max(25),
  receipt: z.object({ kind: z.literal('package-integrity-only') }).strict(),
}).strict().superRefine((batch, ctx) => {
  if (batch.items.filter(item => item.status === 'capturing').length > 1) ctx.addIssue({ code: 'custom', message: 'Only one serial capture may be active' });
  if (!HistoryPlanPackageSchema.safeParse({ digest: batch.digest, plan: batch.plan, receipt: batch.receipt }).success || batch.items.length !== batch.plan.pulls.length || batch.items.some((item, index) => item.number !== batch.plan.pulls[index].number)) ctx.addIssue({ code: 'custom', message: 'History batch plan/progress mismatch' });
});
export type HistoryBatch = z.infer<typeof HistoryBatchSchema>;
export function initialHistoryItems(numbers: number[]): HistoryItem[] {
  return numbers.map(number => ({ number, status: 'pending', attempts: 0, lastAttemptAt: null, failure: null, evidenceDigest: null, snapshotDigest: null, miningRequestDigests: [] }));
}
