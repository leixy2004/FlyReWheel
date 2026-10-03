import { z } from 'zod';
import { DigestSchema, IdSchema } from './model.js';
import { PrMiningModelContextSchema, PrMiningModelLimitsSchema } from './pr-mining-model.js';
import { CodexWorkspaceLimits } from '../workspace/codex-runner.js';
import { PrMiningWorkspaceWorkerResult } from '../workspace/worker-protocol.js';

import { hasCompletedWorkspaceProcess as hasCompletedMiningProcess } from '../workspace/execution-receipt.js';
export { hasCompletedWorkspaceProcess as hasCompletedMiningProcess } from '../workspace/execution-receipt.js';

/** Application execution receipts bind accepted bytes and lifecycle observations.
 * They are NOT cryptographic attestation of the backend, model identity or truth.
 * Only the trusted runtime API may mint persistence authority for new receipts.
 */
export const PrMiningExecutionReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('pr-mining-workspace-execution'),
  requestDigest: DigestSchema, generationDigest: DigestSchema, promptDigest: DigestSchema,
  responseDigest: DigestSchema, workspaceRequestDigest: DigestSchema, runtimeResultDigest: DigestSchema,
  model: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/), modelIdentity: z.literal('requested-configuration-not-provider-attested'), runtimeId: IdSchema,
  context: PrMiningModelContextSchema.options[1],
  generationLimits: PrMiningModelLimitsSchema, workspaceLimits: CodexWorkspaceLimits,
  execution: z.literal('completed'), modelExecution: z.enum(['completed', 'not_run']),
  cleanup: z.literal('verified'), completedAt: z.string().datetime({ offset: true }),
  lifecycle: z.array(z.string().min(1).max(100)).max(32),
  artifacts: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    sha256: DigestSchema, byteLength: z.number().int().nonnegative().max(16_777_216) }).strict()).max(100),
  workerResult: PrMiningWorkspaceWorkerResult,
  trust: z.literal('trusted-runtime-receipt-not-cryptographic-attestation'),
}).strict().superRefine((receipt, ctx) => {
  const modelExecution = receipt.workerResult.boundary === 'authored-test-no-isolation' ? 'not_run' : 'completed';
  if (receipt.modelExecution !== modelExecution) ctx.addIssue({ code: 'custom', message: 'Execution receipt must preserve authored fixture/model boundary' });
  if (!hasCompletedMiningProcess(receipt.workerResult, receipt.workspaceLimits.maxOutputBytes)) {
    ctx.addIssue({ code: 'custom', message: 'Completed mining worker requires completed supervision, successful exit, bounded bytes and process stop evidence' });
  }
});
export type PrMiningExecutionReceipt = z.infer<typeof PrMiningExecutionReceiptSchema>;
