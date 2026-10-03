import { z } from 'zod';
import { DigestSchema, IdSchema } from './core/model.js';
import { digestOf } from './core/identity.js';
import { PrMiningExecutionReceiptSchema } from './core/pr-mining-execution.js';
import { RepositoryContextDigestSetSchema } from './core/semantic-review-context.js';

/** Queue inputs select frozen domain records and a trusted logical workspace.
 * No path, model, backend, executable, credential, or imported result is accepted. */
export const ApplicationLogicalIdSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const common = { schemaVersion: z.literal(1), workspaceId: ApplicationLogicalIdSchema,
  evaluationExportId: ApplicationLogicalIdSchema.optional(),
  attempt: ApplicationLogicalIdSchema.default('initial') };
const candidateCreatedAt = z.string().max(40).datetime({ offset: true });
export const ApplicationJobSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('pr-mining'), requestDigest: DigestSchema, candidateCreatedAt }).strict(),
  z.object({ ...common, kind: z.literal('semantic-review'), ruleDigest: DigestSchema, snapshotDigest: DigestSchema,
    repositoryContextDigests: RepositoryContextDigestSetSchema.optional(), governancePlanDigest: DigestSchema.optional() }).strict(),
  z.object({ ...common, kind: z.literal('revision-generation'), requestDigest: DigestSchema,
    snapshotDigest: DigestSchema, candidateCreatedAt }).strict(),
]);
export type ApplicationJob = z.infer<typeof ApplicationJobSchema>;
export type ApplicationJobInput = z.input<typeof ApplicationJobSchema>;
export function applicationJobDigest(input: ApplicationJobInput): string { return digestOf(ApplicationJobSchema.parse(input)); }
export function applicationJobId(input: ApplicationJobInput): string {
  const digest = applicationJobDigest(input);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export const ApplicationJobResultSchema = z.object({
  status: z.enum(['completed', 'blocked', 'failed']),
  modelExecution: z.enum(['not_run', 'completed', 'unknown']),
  cleanup: z.enum(['not_started', 'verified', 'retained-for-recovery']),
  reason: z.enum(['runtime_unavailable', 'disabled', 'workspace_resolver_unavailable', 'cancelled',
    'timed_out', 'input_rejected', 'runtime_failed', 'output_rejected', 'persistence_failed', 'cleanup_not_verified',
    'interrupted_execution_requires_recovery', 'stale_governance_plan', 'governance_plan_rejected']).optional(),
  outcome: z.object({ kind: z.enum(['pr-mining-candidate', 'semantic-review', 'revision-candidate',
    'revision-no-mutation', 'mining-insufficient-evidence']), id: IdSchema, digest: DigestSchema.optional() }).strict().optional(),
  // Mining has no separate no-candidate domain table; preserve its verified receipt here.
  receipt: PrMiningExecutionReceiptSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'completed' && (!value.outcome || value.reason || value.cleanup !== 'verified'))
    ctx.addIssue({ code: 'custom', message: 'Completed application jobs require an outcome and verified cleanup' });
  if (value.status !== 'completed' && (!value.reason || value.outcome || value.receipt))
    ctx.addIssue({ code: 'custom', message: 'Uncompleted application jobs require a reason and cannot claim domain outcomes' });
  if ((value.outcome?.kind === 'mining-insufficient-evidence') !== !!value.receipt)
    ctx.addIssue({ code: 'custom', message: 'Only a mining no-candidate outcome requires its verified receipt' });
});
export type ApplicationJobResult = z.infer<typeof ApplicationJobResultSchema>;
export const ApplicationJobRecordSchema = z.object({ jobDigest: DigestSchema, job: ApplicationJobSchema,
  state: z.enum(['running', 'retryable', 'finished']), result: ApplicationJobResultSchema.nullable(),
  attempts: z.number().int().positive() }).strict();
export type ApplicationJobRecord = z.infer<typeof ApplicationJobRecordSchema>;
/** Public queue/status output never exposes workspace paths or raw backend errors. */
export function applicationJobSummary(result: ApplicationJobResult) {
  const { receipt: _receipt, ...summary } = ApplicationJobResultSchema.parse(result);
  return summary;
}

/** Presentation metadata only; absent plan references retain the original job identity. */
export function applicationJobGovernance(job: ApplicationJob) {
  if (job.kind !== 'semantic-review') return {};
  return job.governancePlanDigest
    ? { reviewSelection: 'local-governed' as const, governancePlanDigest: job.governancePlanDigest }
    : { reviewSelection: 'explicit-digest-replay-not-governance-governed' as const };
}
