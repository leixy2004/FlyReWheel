import { z } from 'zod';
import { digestOf } from '../core/identity.js';
import { MatchedDiagnosisSchema, MatchedModelRequestSchema, ProposalSchema, ReviewSchema, SdkNativeMatchedRequestSchema,
  type MatchedModelRequest, type SdkNativeMatchedRequest } from '../core/matched-revision-model.js';
import { CodexWorkspaceLimits, type WorkspaceLimits } from '../workspace/codex-runner.js';
import { MATCHED_CODEX_CAPABILITIES, type MatchedCodexExecution } from '../workspace/matched-codex-policy.js';
import { CodexWorkspaceWorkerError, runCodexWorkspaceWorker, type CodexWorkerDependencies } from './codex-workspace-worker.js';

export { MATCHED_CODEX_CAPABILITIES, preflightMatchedCodexControls } from '../workspace/matched-codex-policy.js';

interface MatchedWorkerContext { workingDirectory: string; limits: WorkspaceLimits }
async function dispatch(request: MatchedModelRequest | SdkNativeMatchedRequest, context: MatchedWorkerContext,
  dependencies: CodexWorkerDependencies, execution: MatchedCodexExecution, signal?: AbortSignal) {
  request = execution.kind === 'authored-sdk-native-no-model' ? SdkNativeMatchedRequestSchema.parse(request)
    : MatchedModelRequestSchema.parse(request);
  const diagnosis = request.stage === 'diagnosis', proposal = request.stage === 'proposal';
  const schema = diagnosis ? MatchedDiagnosisSchema : proposal ? ProposalSchema : ReviewSchema;
  if (digestOf(request.outputSchema) !== digestOf(z.toJSONSchema(schema))) throw new Error('Matched request must use the fixed stage output schema');
  const input = { workingDirectory: context.workingDirectory, model: request.model, prompt: request.prompt,
    ...(request.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: request.modelReasoningEffort }),
    outputContract: diagnosis ? 'matched-diagnosis-v1' as const : proposal ? 'matched-proposal-v1' as const : 'matched-review-v1' as const,
    toolPolicy: 'selected-evidence-no-tools-v1' as const, historyPolicy: 'all-local-refs-v1' as const,
    matchedExecution: execution, limits: CodexWorkspaceLimits.parse(context.limits) };
  // Each dispatch uses the existing supervised SDK worker and a fresh thread.
  return diagnosis ? runCodexWorkspaceWorker(input, MatchedDiagnosisSchema, dependencies, signal)
    : proposal ? runCodexWorkspaceWorker(input, ProposalSchema, dependencies, signal)
    : runCodexWorkspaceWorker(input, ReviewSchema, dependencies, signal);
}

const authoredNativeTransports = new WeakSet<object>();
export function isAuthoredCodexNativeMatchedTransport(value: unknown): value is AuthoredCodexNativeMatchedTransport {
  return typeof value === 'object' && value !== null && authoredNativeTransports.has(value);
}
export type AuthoredCodexNativeMatchedTransport = ReturnType<typeof createAuthoredCodexNativeMatchedTransport>;

/** Native-profile mechanics only. No callback/JSON admission, credentials,
 * provider gateway or real-runtime fallback. Limits are supplied per call by
 * the configuration-bound ledger and still enforced by the existing worker. */
export function createAuthoredCodexNativeMatchedTransport(options: {
  workingDirectory: string; fixtureRoot: string; codexPathOverride: string;
}) {
  let cleanupBlocked = false;
  const transport = {
    kind: 'authored-test-no-model' as const, id: 'authored-codex-sdk-native-matched-v1', capabilities: MATCHED_CODEX_CAPABILITIES,
    async execute(request: SdkNativeMatchedRequest, limits: WorkspaceLimits, signal: AbortSignal) {
      const started = performance.now();
      let invokedAt: number | null = null, cleanupAt: number | null = null, answerBytes: number | null = null;
      const rawUsage = { input_tokens: null as number | null, cached_input_tokens: null as number | null,
        cache_write_input_tokens: null as number | null, output_tokens: null as number | null, reasoning_output_tokens: null as number | null };
      let value: unknown = null, usage: z.infer<typeof import('../workspace/worker-protocol.js').WorkspaceWorkerUsage> | null = null;
      let processEvidence: import('./codex-workspace-worker.js').ProcessEvidence | null = null, sessionId: string | null = null;
      let error: string | null = null, cleanupVerified = false;
      try {
        if (cleanupBlocked) throw new Error('Earlier authored worker cleanup is unverified');
        const result = await dispatch(request, { workingDirectory: options.workingDirectory, limits }, {
          codexPathOverride: options.codexPathOverride,
          boundary: { kind: 'authored-test-no-isolation', fixtureRoot: options.fixtureRoot },
          observe(event) {
            if (event.kind === 'sdk_invocation') invokedAt = performance.now();
            else if (event.kind === 'cleanup_started') cleanupAt = performance.now();
            else if (event.kind === 'answer') answerBytes = event.bytes;
          },
        }, { kind: 'authored-sdk-native-no-model' }, signal);
        value = result.value; usage = result.usage; processEvidence = result.processEvidence; sessionId = result.sessionId;
        cleanupVerified = result.processEvidence.processGroupStopped;
      } catch (caught) {
        error = caught instanceof Error ? caught.message.slice(0, 2000) : 'Authored native worker failed';
        if (caught instanceof CodexWorkspaceWorkerError) {
          usage = caught.usage; processEvidence = caught.processEvidence;
          cleanupVerified = caught.processEvidence?.processGroupStopped === true && caught.retainedRuntimePath === null;
        }
        // A failure in the worker's final cleanup can escape as a plain Error.
        // Once invoked, absent stop evidence must fence this whole transport,
        // including subsequent arms, regardless of the exception's class.
        if (invokedAt !== null && !cleanupVerified) cleanupBlocked = true;
      }
      const finished = performance.now();
      if (processEvidence?.reportedUsage) Object.assign(rawUsage, processEvidence.reportedUsage);
      return { status: error === null ? 'completed' as const : 'failed' as const, output: value, error, usage, rawUsage, sessionId, processEvidence, cleanupVerified,
        observations: { sdkInvocations: invokedAt === null ? 0 : 1, answerBytes,
          setupMs: Math.ceil((invokedAt ?? finished) - started),
          executionMs: invokedAt === null ? null : Math.ceil((cleanupAt ?? finished) - invokedAt),
          cleanupMs: cleanupAt === null ? null : Math.ceil(finished - cleanupAt) } };
    },
  };
  authoredNativeTransports.add(transport);
  return Object.freeze(transport);
}

/** Operational requests never silently lose their frozen controls. With the
 * pinned SDK this always fails preflight, before runtime verification or spawn.
 * Packet/tokenizer, cost/isolation and study readiness remain separate blockers. */
export async function runMatchedCodexRequest(request: MatchedModelRequest, context: MatchedWorkerContext,
  dependencies: CodexWorkerDependencies, signal?: AbortSignal) {
  return dispatch(request, context, dependencies, { kind: 'enforce-frozen-controls',
    sampler: request.sampler, maxOutputTokens: request.maxOutputTokens }, signal);
}

/** Import-only authored test seam. No CLI flag, env switch, credential handling,
 * gateway, default executable or production fallback. The caller supplies an
 * author-controlled script inside its fixture root, not the real Codex binary. */
export function createAuthoredCodexMatchedTransport(options: MatchedWorkerContext & {
  fixtureRoot: string; codexPathOverride: string;
}) {
  const context = { workingDirectory: options.workingDirectory, limits: CodexWorkspaceLimits.parse(options.limits) };
  const dependencies: CodexWorkerDependencies = { codexPathOverride: options.codexPathOverride,
    boundary: { kind: 'authored-test-no-isolation', fixtureRoot: options.fixtureRoot } };
  let cleanupBlocked = false;
  return {
    kind: 'authored-test-no-model' as const, id: 'authored-codex-sdk-matched-v1', capabilities: MATCHED_CODEX_CAPABILITIES,
    abortSettlementMs: context.limits.cleanupTimeoutMs + 2500,
    async execute(request: MatchedModelRequest, signal: AbortSignal) {
      const base = { adapter: 'authored-codex-sdk' as const, sdkVersion: '0.159.2' as const,
        controls: 'not-enforced-authored-script' as const, modelCalls: 0 as const };
      try {
        if (cleanupBlocked) return { status: 'failed' as const, output: null, error: 'Earlier authored worker cleanup is unverified', usage: null,
          transportEvidence: { ...base, sessionId: null, processEvidence: null, rawUsage: null, cleanup: 'unverified' as const } };
        const result = await dispatch(request, context, dependencies, { kind: 'authored-script-controls-not-enforced' }, signal);
        return { status: 'completed' as const, output: result.value, error: null,
          usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
            cachedInputTokens: result.usage.cached_input_tokens, costMicros: 0 },
          transportEvidence: { ...base, sessionId: result.sessionId, processEvidence: result.processEvidence,
            rawUsage: result.usage, cleanup: 'verified' as const } };
      } catch (error) {
        const worker = error instanceof CodexWorkspaceWorkerError ? error : null, usage = worker?.usage;
        const cleanupVerified = worker?.processEvidence?.processGroupStopped === true && worker.retainedRuntimePath === null;
        if (worker && !cleanupVerified) cleanupBlocked = true;
        return { status: 'failed' as const, output: null,
          error: error instanceof Error ? error.message.slice(0, 2000) : 'Authored matched worker failed',
          usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
            cachedInputTokens: usage.cached_input_tokens, costMicros: 0 } : null,
          transportEvidence: { ...base, sessionId: null, processEvidence: worker?.processEvidence ?? null,
            rawUsage: usage ?? null, cleanup: worker ? cleanupVerified ? 'verified' as const
              : 'unverified' as const : 'not_started' as const } };
      }
    },
  };
}
