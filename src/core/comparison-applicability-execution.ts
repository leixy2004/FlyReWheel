import { z } from 'zod';
import { DigestSchema, IdSchema } from './model.js';
import { digestOf } from './identity.js';
import { ComparisonApplicabilityBindingSchema } from './comparison-applicability-model.js';
import { SemanticReviewModelContextSchema, SemanticReviewModelLimitsSchema } from './semantic-review-model.js';
import { CodexWorkspaceLimits, CodexWorkspaceRequestSchema } from '../workspace/codex-runner.js';
import { ComparisonApplicabilityWorkspaceWorkerResult } from '../workspace/worker-protocol.js';
import { hasCompletedWorkspaceProcess } from '../workspace/execution-receipt.js';

/** Application provenance only; neither semantic truth nor provider attestation. */
export const ComparisonApplicabilityExecutionReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('comparison-applicability-workspace-execution'),
  binding: ComparisonApplicabilityBindingSchema, inputDigest: DigestSchema,
  expectedSha: CodexWorkspaceRequestSchema.shape.expectedSha,
  generationDigest: DigestSchema, promptDigest: DigestSchema, responseDigest: DigestSchema,
  workspaceRequestDigest: DigestSchema, runtimeResultDigest: DigestSchema,
  model: CodexWorkspaceRequestSchema.shape.model, modelIdentity: z.literal('requested-configuration-not-provider-attested'), runtimeId: IdSchema,
  context: SemanticReviewModelContextSchema, generationLimits: SemanticReviewModelLimitsSchema, workspaceLimits: CodexWorkspaceLimits,
  toolPolicy: z.literal('selected-evidence-no-tools-v1'),
  snapshotCheck: z.literal('exact-local-git-recapture-matched'),
  repositoryContextCheck: z.literal('exact-local-git-recapture-matched'),
  execution: z.literal('completed'), modelExecution: z.enum(['completed', 'not_run']),
  cleanup: z.literal('verified'), completedAt: z.string().datetime({ offset: true }),
  lifecycle: z.array(z.string().min(1).max(100)).max(32),
  artifacts: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    sha256: DigestSchema, byteLength: z.number().int().nonnegative().max(16_777_216) }).strict()).max(100),
  workerResult: ComparisonApplicabilityWorkspaceWorkerResult,
  trust: z.literal('trusted-runtime-receipt-not-cryptographic-attestation'),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.workerResult.value.bindingDigest !== digestOf(receipt.binding)
    || receipt.expectedSha !== receipt.binding.head || receipt.context.repository !== receipt.binding.repository) {
    ctx.addIssue({ code: 'custom', message: 'Comparison applicability receipt binding mismatch' });
  }
  if (receipt.modelExecution !== (receipt.workerResult.boundary === 'authored-test-no-isolation' ? 'not_run' : 'completed')) {
    ctx.addIssue({ code: 'custom', message: 'Execution receipt must preserve authored fixture/model boundary' });
  }
  if (!hasCompletedWorkspaceProcess(receipt.workerResult, receipt.workspaceLimits.maxOutputBytes)) {
    ctx.addIssue({ code: 'custom', message: 'Completed applicability worker requires bounded successful supervision and process stop evidence' });
  }
});
export type ComparisonApplicabilityExecutionReceipt = z.infer<typeof ComparisonApplicabilityExecutionReceiptSchema>;
