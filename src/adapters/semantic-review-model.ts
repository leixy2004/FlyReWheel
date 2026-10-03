import { IdSchema } from '../core/model.js';
import { digestOf } from '../core/identity.js';
import { captureChangeSnapshot } from '../change-snapshot.js';
import { verifyRepositoryContext } from '../repository-context.js';
import { reviewRepositoryContextDigests } from '../semantic-review-context.js';
import { buildExecutedSemanticReview, validateSemanticReview } from '../semantic-review.js';
import { ReviewConfigSchema, type SemanticReview } from '../core/semantic-review.js';
import { SemanticReviewExecutionReceiptSchema } from '../core/semantic-review-execution.js';
import { SemanticReviewWorkspaceWorkerResult } from '../workspace/worker-protocol.js';
import { createCodexWorkspaceRunner, CodexWorkspaceLimits, type CodexWorkspaceBackend, type CodexWorkspaceResult, type WorkspaceLimits } from '../workspace/codex-runner.js';
import { bytesDigest, freeze, hasCompletedWorkspaceProcess, workspaceRuntimeResultBinding } from '../workspace/execution-receipt.js';
import { SemanticReviewModelConfigSchema, buildSemanticReviewModelInput, buildSemanticReviewWorkspaceRequest, validateSemanticReviewExecution,
  type SemanticReviewModelConfig, type SemanticReviewModelInput } from '../semantic-review-execution.js';
export { buildSemanticReviewModelInput, buildSemanticReviewWorkspaceRequest, validateSemanticReviewExecution } from '../semantic-review-execution.js';
export type { SemanticReviewModelConfig, SemanticReviewModelInput } from '../semantic-review-execution.js';

declare const trustedReview: unique symbol;
export type TrustedSemanticReview = { readonly [trustedReview]: true };
const acceptedReviews = new WeakMap<object, SemanticReview>();
/** No JSON importer or public mint function. The capability is process-local. */
export function readTrustedSemanticReview(capability: TrustedSemanticReview): SemanticReview {
  const review = capability && acceptedReviews.get(capability);
  if (!review) throw new Error('Executed semantic review requires a trusted runtime capability, not JSON');
  return review;
}
/** Trusted application dependency, never a JSON field or automatic live fallback. */
export interface SemanticReviewWorkspaceRuntime { id: string; backend: CodexWorkspaceBackend; limits: WorkspaceLimits }
export type SemanticReviewWorkspaceOutcome =
  | { execution: 'not_run'; modelExecution: 'not_run'; reason: 'disabled' | 'runtime_unavailable' | 'cancelled'; review: null }
  | { execution: 'failed'; modelExecution: 'not_run' | 'completed' | 'unknown'; stage: 'input' | 'runtime' | 'output';
      error: string; review: null; runtimeResult: CodexWorkspaceResult | null }
  | { execution: 'succeeded'; modelExecution: 'not_run' | 'completed'; origin: 'authored-test' | 'model';
      review: SemanticReview; persistence: TrustedSemanticReview };

/** Wait for supervised execution AND cleanup before applying any model judgment.
 * Authored SDK fixtures exercise this same path but never become model/human data. */
export function createSemanticReviewWorkspaceModelAdapter(rawConfig: SemanticReviewModelConfig, runtime?: SemanticReviewWorkspaceRuntime) {
  const config = SemanticReviewModelConfigSchema.parse(rawConfig);
  const runtimeId = runtime ? IdSchema.parse(runtime.id) : undefined;
  const limits = runtime ? CodexWorkspaceLimits.parse(runtime.limits) : undefined;
  const backend = runtime ? { kind: runtime.backend.kind, reserve: runtime.backend.reserve.bind(runtime.backend) } : undefined;
  const runner = createCodexWorkspaceRunner(backend);
  return { async review(raw: SemanticReviewModelInput, signal?: AbortSignal): Promise<SemanticReviewWorkspaceOutcome> {
    if (!config.enabled) return { execution: 'not_run', modelExecution: 'not_run', reason: 'disabled', review: null };
    if (!runtime) return { execution: 'not_run', modelExecution: 'not_run', reason: 'runtime_unavailable', review: null };
    if (signal?.aborted) return { execution: 'not_run', modelExecution: 'not_run', reason: 'cancelled', review: null };
    let stage: 'input' | 'runtime' | 'output' = 'input', runtimeResult: CodexWorkspaceResult | null = null;
    try {
      const prepared = buildSemanticReviewModelInput(raw, config), request = buildSemanticReviewWorkspaceRequest(prepared, limits!);
      const attempt = ReviewConfigSchema.shape.attempt.parse(raw.attempt ?? 'initial');
      const frozen = prepared.snapshot.snapshot;
      // Reuse bounded, network-free object capture. An imported internally valid
      // package cannot borrow the authority of an unrelated valid workspace SHA.
      const recaptured = await captureChangeSnapshot({ repositoryPath: prepared.context.workspace.repoPath,
        repositoryId: frozen.repository.id, baseTip: frozen.baseTip, head: frozen.head, limits: frozen.limits,
        ...(frozen.prMetadata ? { prMetadata: frozen.prMetadata } : {}) });
      if (recaptured.digest !== prepared.snapshot.digest) throw new Error('Review snapshot does not match exact local Git recapture');
      if (signal?.aborted) throw new Error('Review cancelled during local snapshot verification; no runtime was started');
      for (const repositoryContext of prepared.repositoryContexts ?? []) {
        await verifyRepositoryContext(repositoryContext, prepared.context.workspace.repoPath);
        if (signal?.aborted) throw new Error('Review cancelled during local repository context verification; no runtime was started');
      }
      stage = 'runtime';
      runtimeResult = await runner.run(request, signal);
      if (runtimeResult.execution !== 'succeeded' || runtimeResult.cleanup !== 'verified' || runtimeResult.errors.length) {
        throw new Error('Review workspace execution or verified cleanup did not complete; inspect runtimeResult for recovery');
      }
      if (signal?.aborted) throw new Error('Review workspace cancelled; cleanup completed without judgment acceptance');
      stage = 'output';
      const workerResult = SemanticReviewWorkspaceWorkerResult.parse(runtimeResult.output);
      if (workerResult.outputContract !== request.outputContract) throw new Error('Review worker output contract does not match requested judgment contract');
      if (workerResult.boundary !== backend!.kind) throw new Error('Review worker/runtime boundary mismatch');
      const modelExecution = backend!.kind === 'authored-test-no-isolation' ? 'not_run' as const : 'completed' as const;
      const baseReceipt = { schemaVersion: 1 as const, kind: 'semantic-review-workspace-execution' as const,
        judgmentContract: prepared.judgmentContract,
        ...(prepared.repositoryContexts ? { repositoryContextDigests: reviewRepositoryContextDigests(prepared.repositoryContexts),
          repositoryContextCheck: 'exact-local-git-recapture-matched' as const } : {}),
        ruleDigest: prepared.rule.digest, snapshotDigest: prepared.snapshot.digest, expectedSha: frozen.head,
        generationDigest: digestOf(prepared.generation), promptDigest: bytesDigest(prepared.generation.prompt),
        responseDigest: digestOf(workerResult.value), workspaceRequestDigest: runtimeResult.requestDigest,
        model: config.model, modelIdentity: 'requested-configuration-not-provider-attested' as const, runtimeId: runtimeId!,
        context: prepared.context, generationLimits: prepared.generation.limits, workspaceLimits: limits!,
        snapshotCheck: 'exact-local-git-recapture-matched' as const, execution: 'completed' as const, modelExecution,
        cleanup: 'verified' as const, completedAt: new Date().toISOString(), lifecycle: runtimeResult.lifecycle,
        artifacts: runtimeResult.artifacts.map(({ name, bytes, sha256 }) => ({ name, sha256, byteLength: bytes.byteLength })), workerResult,
        trust: 'trusted-runtime-receipt-not-cryptographic-attestation' as const };
      const executionReceipt = SemanticReviewExecutionReceiptSchema.parse({ ...baseReceipt,
        runtimeResultDigest: digestOf(workspaceRuntimeResultBinding(baseReceipt)) });
      validateSemanticReviewExecution(executionReceipt, prepared.rule, prepared.snapshot, prepared.repositoryContexts);
      const review = freeze(buildExecutedSemanticReview({ rule: prepared.rule, snapshot: prepared.snapshot, executionReceipt, attempt,
        ...(prepared.repositoryContexts ? { repositoryContexts: prepared.repositoryContexts } : {}) }));
      validateSemanticReview(review, prepared.rule, prepared.snapshot);
      const persistence = Object.freeze({}) as TrustedSemanticReview;
      acceptedReviews.set(persistence, review);
      return freeze({ execution: 'succeeded', modelExecution, origin: modelExecution === 'not_run' ? 'authored-test' : 'model', review, persistence });
    } catch (error) {
      const output = SemanticReviewWorkspaceWorkerResult.safeParse(runtimeResult?.output);
      const completed = output.success && output.data.boundary === backend!.kind && hasCompletedWorkspaceProcess(output.data, limits!.maxOutputBytes);
      const modelExecution = backend!.kind === 'authored-test-no-isolation' ? 'not_run'
        : completed ? 'completed' : runtimeResult?.lifecycle.includes('worker-started') ? 'unknown' : 'not_run';
      return { execution: 'failed', modelExecution, stage, error: error instanceof Error ? error.message.slice(0, 2000) : 'Semantic workspace review failed', review: null, runtimeResult };
    }
  } };
}
