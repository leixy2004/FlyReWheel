import { IdSchema } from '../core/model.js';
import { digestOf } from '../core/identity.js';
import type { ComparisonApplicabilityBinding } from '../core/comparison-applicability-model.js';
import { ComparisonApplicabilityExecutionReceiptSchema, type ComparisonApplicabilityExecutionReceipt } from '../core/comparison-applicability-execution.js';
import { captureChangeSnapshot } from '../change-snapshot.js';
import { verifyRepositoryContext } from '../repository-context.js';
import { ComparisonApplicabilityModelConfigSchema, buildComparisonApplicabilityModelInput,
  buildComparisonApplicabilityWorkspaceRequest, validateComparisonApplicabilityExecution,
  type ComparisonApplicabilityModelConfig, type ComparisonApplicabilityModelInput } from '../comparison-applicability-execution.js';
import { ComparisonApplicabilityWorkspaceWorkerResult } from '../workspace/worker-protocol.js';
import { CodexWorkspaceLimits, createCodexWorkspaceRunner, type CodexWorkspaceBackend,
  type CodexWorkspaceResult, type WorkspaceLimits } from '../workspace/codex-runner.js';
import { bytesDigest, freeze, hasCompletedWorkspaceProcess, workspaceRuntimeResultBinding } from '../workspace/execution-receipt.js';

export { buildComparisonApplicabilityModelInput, buildComparisonApplicabilityWorkspaceRequest,
  validateComparisonApplicabilityExecution } from '../comparison-applicability-execution.js';
export type { ComparisonApplicabilityModelConfig, ComparisonApplicabilityModelInput } from '../comparison-applicability-execution.js';
export interface ExecutedComparisonApplicability {
  kind: 'comparison-applicability-workspace-execution'; binding: ComparisonApplicabilityBinding; receipt: ComparisonApplicabilityExecutionReceipt;
}
declare const trustedApplicability: unique symbol;
export type TrustedComparisonApplicability = { readonly [trustedApplicability]: true };
const accepted = new WeakMap<object, ExecutedComparisonApplicability>();
/** Process-local capability; JSON imports cannot mint runtime authority. */
export function readTrustedComparisonApplicability(capability: TrustedComparisonApplicability): ExecutedComparisonApplicability {
  const adjudication = capability && accepted.get(capability);
  if (!adjudication) throw new Error('Executed comparison applicability requires a trusted runtime capability, not JSON');
  return adjudication;
}
export interface ComparisonApplicabilityWorkspaceRuntime { id: string; backend: CodexWorkspaceBackend; limits: WorkspaceLimits }
export type ComparisonApplicabilityWorkspaceOutcome =
  | { execution: 'not_run'; modelExecution: 'not_run'; reason: 'disabled' | 'runtime_unavailable' | 'cancelled'; adjudication: null }
  | { execution: 'failed'; modelExecution: 'not_run' | 'completed' | 'unknown'; stage: 'input' | 'runtime' | 'output';
      error: string; adjudication: null; runtimeResult: CodexWorkspaceResult | null }
  | { execution: 'succeeded'; modelExecution: 'not_run' | 'completed'; origin: 'authored-test' | 'model';
      adjudication: ExecutedComparisonApplicability; persistence: TrustedComparisonApplicability };

/** No implicit backend/auth/fixture fallback. Accept only after verified cleanup. */
export function createComparisonApplicabilityWorkspaceModelAdapter(rawConfig: ComparisonApplicabilityModelConfig,
  runtime?: ComparisonApplicabilityWorkspaceRuntime) {
  const config = ComparisonApplicabilityModelConfigSchema.parse(rawConfig), runtimeId = runtime ? IdSchema.parse(runtime.id) : undefined;
  const limits = runtime ? CodexWorkspaceLimits.parse(runtime.limits) : undefined;
  const backend = runtime ? { kind: runtime.backend.kind, reserve: runtime.backend.reserve.bind(runtime.backend) } : undefined;
  const runner = createCodexWorkspaceRunner(backend);
  return { async adjudicate(raw: ComparisonApplicabilityModelInput, signal?: AbortSignal): Promise<ComparisonApplicabilityWorkspaceOutcome> {
    if (!config.enabled) return { execution: 'not_run', modelExecution: 'not_run', reason: 'disabled', adjudication: null };
    if (!runtime) return { execution: 'not_run', modelExecution: 'not_run', reason: 'runtime_unavailable', adjudication: null };
    if (signal?.aborted) return { execution: 'not_run', modelExecution: 'not_run', reason: 'cancelled', adjudication: null };
    let stage: 'input' | 'runtime' | 'output' = 'input', runtimeResult: CodexWorkspaceResult | null = null;
    try {
      // Preserve the request-time comparison graph across asynchronous recapture/execution.
      const comparison = freeze(structuredClone(raw.comparison));
      const prepared = buildComparisonApplicabilityModelInput({ comparison, context: raw.context }, config);
      const request = buildComparisonApplicabilityWorkspaceRequest(prepared, limits!);
      const frozen = prepared.input.snapshot.snapshot;
      const recaptured = await captureChangeSnapshot({ repositoryPath: prepared.context.workspace.repoPath,
        repositoryId: frozen.repository.id, baseTip: frozen.baseTip, head: frozen.head, limits: frozen.limits,
        ...(frozen.prMetadata ? { prMetadata: frozen.prMetadata } : {}) });
      if (recaptured.digest !== prepared.input.snapshot.digest) throw new Error('Applicability snapshot does not match exact local Git recapture');
      if (signal?.aborted) throw new Error('Applicability cancelled during local snapshot verification; no runtime was started');
      for (const repositoryContext of prepared.input.repositoryContexts) {
        await verifyRepositoryContext(repositoryContext, prepared.context.workspace.repoPath);
        if (signal?.aborted) throw new Error('Applicability cancelled during local repository context verification; no runtime was started');
      }
      stage = 'runtime'; runtimeResult = await runner.run(request, signal);
      if (runtimeResult.execution !== 'succeeded' || runtimeResult.cleanup !== 'verified' || runtimeResult.errors.length) {
        throw new Error('Applicability workspace execution or verified cleanup did not complete; inspect runtimeResult for recovery');
      }
      if (signal?.aborted) throw new Error('Applicability workspace cancelled; cleanup completed without judgment acceptance');
      stage = 'output';
      const workerResult = ComparisonApplicabilityWorkspaceWorkerResult.parse(runtimeResult.output);
      if (workerResult.outputContract !== request.outputContract) throw new Error('Applicability worker output contract mismatch');
      if (workerResult.boundary !== backend!.kind) throw new Error('Applicability worker/runtime boundary mismatch');
      const modelExecution = backend!.kind === 'authored-test-no-isolation' ? 'not_run' as const : 'completed' as const;
      const baseReceipt = { schemaVersion: 1 as const, kind: 'comparison-applicability-workspace-execution' as const,
        binding: prepared.input.binding, inputDigest: digestOf(prepared.input), expectedSha: frozen.head,
        generationDigest: digestOf(prepared.generation), promptDigest: bytesDigest(prepared.generation.prompt),
        responseDigest: digestOf(workerResult.value), workspaceRequestDigest: runtimeResult.requestDigest,
        model: config.model, modelIdentity: 'requested-configuration-not-provider-attested' as const, runtimeId: runtimeId!,
        context: prepared.context, generationLimits: prepared.generation.limits, workspaceLimits: limits!,
        toolPolicy: 'selected-evidence-no-tools-v1' as const, snapshotCheck: 'exact-local-git-recapture-matched' as const,
        repositoryContextCheck: 'exact-local-git-recapture-matched' as const,
        execution: 'completed' as const, modelExecution, cleanup: 'verified' as const,
        completedAt: new Date().toISOString(), lifecycle: runtimeResult.lifecycle,
        artifacts: runtimeResult.artifacts.map(({ name, bytes, sha256 }) => ({ name, sha256, byteLength: bytes.byteLength })), workerResult,
        trust: 'trusted-runtime-receipt-not-cryptographic-attestation' as const };
      const receipt = ComparisonApplicabilityExecutionReceiptSchema.parse({ ...baseReceipt,
        runtimeResultDigest: digestOf(workspaceRuntimeResultBinding(baseReceipt)) });
      validateComparisonApplicabilityExecution(receipt, comparison);
      const adjudication = freeze({ kind: 'comparison-applicability-workspace-execution' as const, binding: prepared.input.binding, receipt });
      const persistence = Object.freeze({}) as TrustedComparisonApplicability;
      accepted.set(persistence, adjudication);
      return freeze({ execution: 'succeeded', modelExecution, origin: modelExecution === 'not_run' ? 'authored-test' : 'model', adjudication, persistence });
    } catch (error) {
      const parsed = ComparisonApplicabilityWorkspaceWorkerResult.safeParse(runtimeResult?.output);
      const completed = parsed.success && parsed.data.boundary === backend!.kind && hasCompletedWorkspaceProcess(parsed.data, limits!.maxOutputBytes);
      const modelExecution = backend!.kind === 'authored-test-no-isolation' ? 'not_run'
        : completed ? 'completed' : runtimeResult?.lifecycle.includes('worker-started') ? 'unknown' : 'not_run';
      return { execution: 'failed', modelExecution, stage,
        error: error instanceof Error ? error.message.slice(0, 2000) : 'Comparison applicability workspace failed', adjudication: null, runtimeResult };
    }
  } };
}
