import { z } from 'zod';

export const WorkspaceHistoryPolicySchema = z.enum(['all-local-refs-v1', 'exact-allowed-head-closure-v1']);
export const EvaluationWorkspaceBindingSchema = z.object({
  schemaVersion: z.literal(1),
  exportId: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/), recordDigest: z.string().regex(/^[a-f0-9]{64}$/),
  repositoryId: z.string().min(1).max(300), checkoutSha: z.string().regex(/^[a-f0-9]{40}$/),
  allowedHeads: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).max(64),
  inventory: z.object({ count: z.number().int().positive().max(100_000),
    expandedBytes: z.number().int().positive().max(256_000_000), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict().superRefine((binding, ctx) => {
  if (!binding.allowedHeads.includes(binding.checkoutSha)
    || [...new Set(binding.allowedHeads)].sort().join() !== binding.allowedHeads.join()) {
    ctx.addIssue({ code: 'custom', message: 'Evaluation heads must be unique, sorted and include checkout SHA' });
  }
});
export type EvaluationWorkspaceBinding = z.infer<typeof EvaluationWorkspaceBindingSchema>;

/** Keep optional fields absent for legacy identities. This is closure, not historical visibility. */
export function validateHistoryBinding(input: { historyPolicy: string; evaluation?: EvaluationWorkspaceBinding }, expectedSha?: string) {
  if ((input.historyPolicy === 'exact-allowed-head-closure-v1') !== !!input.evaluation
    || (input.evaluation && expectedSha !== undefined && input.evaluation.checkoutSha !== expectedSha)) {
    throw new Error('Evaluation history policy requires matching export binding and checkout SHA');
  }
}
