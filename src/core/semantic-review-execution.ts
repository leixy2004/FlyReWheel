import { z } from 'zod';
import { DigestSchema, IdSchema } from './model.js';
import { digestOf } from './identity.js';
import { RepositoryContextDigestSetSchema } from './semantic-review-context.js';
import { SemanticReviewModelContextSchema, SemanticReviewModelLimitsSchema } from './semantic-review-model.js';
import { CodexWorkspaceLimits, CodexWorkspaceRequestSchema } from '../workspace/codex-runner.js';
import { SemanticReviewWorkspaceWorkerResult } from '../workspace/worker-protocol.js';
import { hasCompletedWorkspaceProcess } from '../workspace/execution-receipt.js';

/** Application provenance, not provider, backend or semantic-truth attestation. */
export const SemanticReviewExecutionReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('semantic-review-workspace-execution'),
  // Omitted only on old receipts, whose original prompt must rederive unchanged.
  judgmentContract: z.enum(['target-and-anchors-v2', 'per-anchor-v3', 'per-anchor-context-v4']).optional(),
  ruleDigest: DigestSchema, snapshotDigest: DigestSchema, expectedSha: CodexWorkspaceRequestSchema.shape.expectedSha,
  generationDigest: DigestSchema, promptDigest: DigestSchema, responseDigest: DigestSchema,
  workspaceRequestDigest: DigestSchema, runtimeResultDigest: DigestSchema,
  model: CodexWorkspaceRequestSchema.shape.model, modelIdentity: z.literal('requested-configuration-not-provider-attested'), runtimeId: IdSchema,
  context: SemanticReviewModelContextSchema, generationLimits: SemanticReviewModelLimitsSchema, workspaceLimits: CodexWorkspaceLimits,
  snapshotCheck: z.literal('exact-local-git-recapture-matched'),
  repositoryContextDigests: RepositoryContextDigestSetSchema.optional(),
  repositoryContextCheck: z.literal('exact-local-git-recapture-matched').optional(),
  execution: z.literal('completed'), modelExecution: z.enum(['completed', 'not_run']),
  cleanup: z.literal('verified'), completedAt: z.string().datetime({ offset: true }),
  lifecycle: z.array(z.string().min(1).max(100)).max(32),
  artifacts: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    sha256: DigestSchema, byteLength: z.number().int().nonnegative().max(16_777_216) }).strict()).max(100),
  workerResult: SemanticReviewWorkspaceWorkerResult,
  trust: z.literal('trusted-runtime-receipt-not-cryptographic-attestation'),
}).strict().superRefine((receipt, ctx) => {
  const contextAware = receipt.judgmentContract === 'per-anchor-context-v4';
  const expectedContract = contextAware ? 'semantic-review-v3' : receipt.judgmentContract === 'per-anchor-v3' ? 'semantic-review-v2' : 'semantic-review-v1';
  if (receipt.workerResult.outputContract !== expectedContract) {
    ctx.addIssue({ code: 'custom', message: 'Review receipt judgment/output contract mismatch' });
  }

  if (contextAware ? !receipt.repositoryContextDigests || !receipt.repositoryContextCheck
    : receipt.repositoryContextDigests !== undefined || receipt.repositoryContextCheck !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'Review receipt repository context fields require the context-aware contract and its local Git check' });
  }
  if (receipt.workerResult.outputContract === 'semantic-review-v3' && receipt.repositoryContextDigests !== undefined
    && digestOf(receipt.repositoryContextDigests) !== digestOf(receipt.workerResult.value.repositoryContextDigests)) {
    ctx.addIssue({ code: 'custom', message: 'Review receipt repository context selection disagrees with worker response' });
  }

  if (receipt.modelExecution !== (receipt.workerResult.boundary === 'authored-test-no-isolation' ? 'not_run' : 'completed')) {
    ctx.addIssue({ code: 'custom', message: 'Execution receipt must preserve authored fixture/model boundary' });
  }
  if (!hasCompletedWorkspaceProcess(receipt.workerResult, receipt.workspaceLimits.maxOutputBytes)) {
    ctx.addIssue({ code: 'custom', message: 'Completed review worker requires bounded successful supervision and process stop evidence' });
  }
});
export type SemanticReviewExecutionReceipt = z.infer<typeof SemanticReviewExecutionReceiptSchema>;
