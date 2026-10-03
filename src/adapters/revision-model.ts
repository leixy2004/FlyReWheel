import { IdSchema } from '../core/model.js';
import { recaptureEvaluationSnapshot } from '../evaluation-workspace-input.js';
import { verifyRepositoryContext } from '../repository-context.js';
import { digestOf } from '../core/identity.js';
import { RevisionCandidateInputSchema, RevisionExecutionReceiptSchema, type RevisionCandidateInput, type RevisionExecutionReceipt, RevisionNoMutationInputSchema, type RevisionNoMutationInput } from '../core/revision-generation.js';
import { buildRevisionModelInput, buildRevisionWorkspaceRequest, revisionCandidateRule, validateExecutedRevisionCandidate,
  validateRevisionModelResponse, validateExecutedRevisionNoMutation, RevisionModelConfigSchema, type RevisionModelConfig, type RevisionModelInput } from '../revision-generation.js';
import { CodexWorkspaceLimits, createCodexWorkspaceRunner, type CodexWorkspaceBackend, type CodexWorkspaceResult, type WorkspaceLimits } from '../workspace/codex-runner.js';
import { RevisionWorkspaceWorkerResult } from '../workspace/worker-protocol.js';
import { bytesDigest, freeze, hasCompletedWorkspaceProcess, validateWorkspaceExecutionBounds, workspaceRuntimeResultBinding } from '../workspace/execution-receipt.js';

export type { RevisionModelConfig, RevisionModelInput } from '../revision-generation.js';
export { buildRevisionModelInput, buildRevisionWorkspaceRequest, validateExecutedRevisionCandidate } from '../revision-generation.js';
export interface RevisionWorkspaceRuntime { id: string; backend: CodexWorkspaceBackend; limits: WorkspaceLimits }
declare const trustedRevision: unique symbol;
export type TrustedRevisionCandidate = { readonly [trustedRevision]: true };
const accepted = new WeakMap<object, RevisionCandidateInput>();
export function readTrustedRevisionCandidate(capability: TrustedRevisionCandidate): RevisionCandidateInput {
  const input = capability && accepted.get(capability);
  if (!input) throw new Error('Generated revision requires a trusted runtime capability, not JSON');
  return input;
}
declare const trustedNoMutation: unique symbol;
export type TrustedRevisionNoMutation = { readonly [trustedNoMutation]: true };
const nonMutations = new WeakMap<object, RevisionNoMutationInput>();
export function readTrustedRevisionNoMutation(capability: TrustedRevisionNoMutation): RevisionNoMutationInput {
  const input = capability && nonMutations.get(capability);
  if (!input) throw new Error('Revision outcome requires a trusted runtime capability, not JSON');
  return input;
}
/** Same trusted dependency and lifecycle as mining/review. No default backend,
 * credential setup, fixture fallback, activation or JSON execution authority. */
export function createRevisionWorkspaceModelAdapter(rawConfig: RevisionModelConfig, runtime?: RevisionWorkspaceRuntime) {
  const config = RevisionModelConfigSchema.parse(rawConfig), runtimeId = runtime ? IdSchema.parse(runtime.id) : undefined;
  const limits = runtime ? CodexWorkspaceLimits.parse(runtime.limits) : undefined;
  const backend = runtime ? { kind: runtime.backend.kind, reserve: runtime.backend.reserve.bind(runtime.backend) } : undefined;
  const runner = createCodexWorkspaceRunner(backend);
  return { async generate(raw: RevisionModelInput, signal?: AbortSignal) {
    if (!config.enabled) return { execution: 'not_run' as const, modelExecution: 'not_run' as const, reason: 'disabled' as const, candidate: null };
    if (!runtime) return { execution: 'not_run' as const, modelExecution: 'not_run' as const, reason: 'runtime_unavailable' as const, candidate: null };
    if (signal?.aborted) return { execution: 'not_run' as const, modelExecution: 'not_run' as const, reason: 'cancelled' as const, candidate: null };
    let stage: 'input' | 'runtime' | 'output' = 'input', runtimeResult: CodexWorkspaceResult | null = null;
    try {
      const prepared = buildRevisionModelInput(raw, config), request = buildRevisionWorkspaceRequest(prepared, limits!);
      if (prepared.context.evaluation !== undefined) {
        for (const snapshot of prepared.graph.snapshots) {
          await recaptureEvaluationSnapshot(snapshot, prepared.context.workspace.repoPath);
          signal?.throwIfAborted();
        }
        for (const { review } of prepared.graph.feedback) for (const context of review.repositoryContexts ?? []) {
          await verifyRepositoryContext(context, prepared.context.workspace.repoPath);
          signal?.throwIfAborted();
        }
      }
      stage = 'runtime'; runtimeResult = await runner.run(request, signal);
      if (runtimeResult.execution !== 'succeeded' || runtimeResult.cleanup !== 'verified' || runtimeResult.errors.length) throw new Error('Revision workspace execution or verified cleanup did not complete; inspect runtimeResult for recovery');
      if (signal?.aborted) throw new Error('Revision workspace cancelled; cleanup completed without candidate acceptance');
      stage = 'output';
      const workerResult = RevisionWorkspaceWorkerResult.parse(runtimeResult.output);
      if (workerResult.outputContract !== prepared.outputContract) throw new Error('Revision worker policy contract mismatch');
      if (workerResult.boundary !== backend!.kind) throw new Error('Revision worker/runtime boundary mismatch');
      const { result } = validateRevisionModelResponse(prepared, workerResult.value);
      const modelExecution = backend!.kind === 'authored-test-no-isolation' ? 'not_run' as const : 'completed' as const;
      const baseReceipt = { schemaVersion: 1 as const, kind: 'rule-revision-workspace-execution' as const,
        requestDigest: prepared.graph.request.digest, baseRuleDigest: prepared.graph.baseRule.digest, inputDigest: digestOf(prepared.graph),
        generationDigest: digestOf(prepared.generation), promptDigest: bytesDigest(prepared.generation.prompt), responseDigest: digestOf(workerResult.value),
        workspaceRequestDigest: runtimeResult.requestDigest, model: prepared.generation.model,
        modelIdentity: 'requested-configuration-not-provider-attested' as const, runtimeId: runtimeId!, context: prepared.context,
        generationLimits: prepared.generation.limits, workspaceLimits: limits!, execution: 'completed' as const, modelExecution,
        cleanup: 'verified' as const, completedAt: new Date().toISOString(), lifecycle: runtimeResult.lifecycle,
        artifacts: runtimeResult.artifacts.map(({ name, bytes, sha256 }) => ({ name, sha256, byteLength: bytes.byteLength })), workerResult,
        trust: 'trusted-runtime-receipt-not-cryptographic-attestation' as const };
      const executionReceipt = RevisionExecutionReceiptSchema.parse({ ...baseReceipt,
        runtimeResultDigest: digestOf(workspaceRuntimeResultBinding(baseReceipt)) });
      if (runtimeResult.requestDigest !== bytesDigest(JSON.stringify(request))) throw new Error('Revision workspace request binding mismatch');
      validateWorkspaceExecutionBounds(executionReceipt, limits!);
      const common = { execution: 'succeeded' as const, modelExecution,
        origin: modelExecution === 'not_run' ? 'authored-test' as const : 'model' as const, executionReceipt,
        evidenceRefs: result.evidenceRefs, diagnoses: result.diagnoses };
      if (result.status === 'insufficient_evidence') throw new Error('Legacy revision contract is read-only');
      if (result.status === 'no_rule_change') {
        const outcomeInput = freeze(RevisionNoMutationInputSchema.parse({ id: prepared.candidateId,
          requestDigest: prepared.graph.request.digest, candidateCreatedAt: prepared.candidateCreatedAt, executionReceipt }));
        const outcome = validateExecutedRevisionNoMutation(outcomeInput, prepared.graph);
        const outcomePersistence = Object.freeze({}) as TrustedRevisionNoMutation;
        nonMutations.set(outcomePersistence, outcomeInput);
        return freeze({ ...common, status: result.status, result, candidate: null, outcome, outcomePersistence });
      }
      const candidateInput = freeze(RevisionCandidateInputSchema.parse({ id: prepared.candidateId, requestDigest: prepared.graph.request.digest,
        rule: revisionCandidateRule(prepared, result, `${modelExecution === 'completed' ? 'model' : 'authored-test'}:${runtimeId}`), executionReceipt }));
      const candidate = validateExecutedRevisionCandidate(candidateInput, prepared.graph);
      const persistence = Object.freeze({}) as TrustedRevisionCandidate;
      accepted.set(persistence, candidateInput);
      return freeze({ ...common, status: 'candidate_requires_review' as const, candidateInput, candidate, persistence });
    } catch (error) {
      const parsed = RevisionWorkspaceWorkerResult.safeParse(runtimeResult?.output);
      const completed = parsed.success && parsed.data.boundary === backend!.kind && hasCompletedWorkspaceProcess(parsed.data, limits!.maxOutputBytes);
      const modelExecution = backend!.kind === 'authored-test-no-isolation' ? 'not_run' as const
        : completed ? 'completed' as const : runtimeResult?.lifecycle.includes('worker-started') ? 'unknown' as const : 'not_run' as const;
      return { execution: 'failed' as const, modelExecution, stage, error: error instanceof Error ? error.message.slice(0, 2000) : 'Revision adapter failed', candidate: null, runtimeResult };
    }
  } };
}
export type RevisionWorkspaceModelOutcome = Awaited<ReturnType<ReturnType<typeof createRevisionWorkspaceModelAdapter>['generate']>>;
