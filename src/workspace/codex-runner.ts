import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digestOf } from '../core/identity.js';
import { EvaluationWorkspaceBindingSchema, WorkspaceHistoryPolicySchema, validateHistoryBinding, type EvaluationWorkspaceBinding } from './history-policy.js';
import { verifyEvaluationWorkspace } from './evaluation-checkout.js';
import { acquireWorkspaceExecutionLease, type WorkspaceRecord } from './index.js';

const Id = z.string().max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const CodexWorkspaceLimits = z.object({
  maxInputBytes: z.number().int().min(1).max(2_097_152),
  maxOutputBytes: z.number().int().min(256).max(8_388_608),
  maxArtifactBytes: z.number().int().min(1).max(16_777_216),
  maxArtifacts: z.number().int().min(0).max(100),
  timeoutMs: z.number().int().min(1).max(300_000),
  cleanupTimeoutMs: z.number().int().min(1).max(30_000),
}).strict();
export const CodexWorkspaceRequestSchema = z.object({
  workspace: z.object({ repoPath: z.string().refine(isAbsolute), runId: Id, attemptId: Id }).strict(),
  expectedSha: z.string().regex(/^[a-f0-9]{40}$/),
  model: z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/),
  toolPolicy: z.enum(['full-repo-shell-v1', 'selected-evidence-no-tools-v1']),
  historyPolicy: WorkspaceHistoryPolicySchema,
  evaluation: EvaluationWorkspaceBindingSchema.optional(),
  outputContract: z.enum(['pr-mining-v1', 'semantic-review-v1', 'semantic-review-v2', 'semantic-review-v3', 'rule-revision-v1', 'rule-revision-v2', 'rule-revision-v3', 'comparison-applicability-v1']).optional(),
  prompt: z.string().min(1).max(2_097_152),
  limits: CodexWorkspaceLimits,
}).strict().superRefine((request, ctx) => {
  try { validateHistoryBinding(request, request.expectedSha); }
  catch { ctx.addIssue({ code: 'custom', message: 'Evaluation request requires its matching export binding and checkout SHA' }); }
});
export type CodexWorkspaceRequest = z.infer<typeof CodexWorkspaceRequestSchema>;
export type WorkspaceLimits = z.infer<typeof CodexWorkspaceLimits>;

export interface RuntimeObservation {
  expectedSha: string;
  headSha: string;
  clean: boolean;
  identityValid: boolean;
  historyPolicy: z.infer<typeof WorkspaceHistoryPolicySchema>;
  evaluation?: EvaluationWorkspaceBinding;
}
export interface CollectedArtifact { name: string; bytes: Uint8Array }
export interface SandboxStopReceipt { stopped: boolean; verified: boolean }
export interface SandboxDestroyReceipt { destroyed: boolean; verified: boolean }

/** Trusted backend implementation, never deserialized from a job request.
 * reserve() must be synchronous and side-effect-free: ownership exists before setup begins.
 * prepare/execute must enforce request byte/time/resource limits BEFORE buffering.
 * stop must stop and fence pending setup, the SDK, CLI, and every repository descendant.
 * collect must enforce limits while reading, reject links/traversal, and return copied bytes.
 */
export interface CodexWorkspaceRuntime {
  prepare(signal: AbortSignal): Promise<RuntimeObservation>;
  execute(signal: AbortSignal): Promise<unknown>;
  stop(): Promise<SandboxStopReceipt>;
  collect(limits: Pick<WorkspaceLimits, 'maxArtifactBytes' | 'maxArtifacts'>): Promise<CollectedArtifact[]>;
  destroy(): Promise<SandboxDestroyReceipt>;
}
export interface CodexWorkspaceBackend {
  kind: 'isolated-runtime' | 'authored-test-no-isolation';
  reserve(request: Readonly<CodexWorkspaceRequest>, workspace: Readonly<WorkspaceRecord>): CodexWorkspaceRuntime;
}
export interface CodexWorkspaceResult {
  execution: 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  requestDigest: string;
  backend: CodexWorkspaceBackend['kind'];
  output: unknown | null;
  artifacts: { name: string; bytes: Uint8Array; sha256: string }[];
  lifecycle: string[];
  errors: string[];
  cleanup: 'verified' | 'retained-for-recovery';
  leasePath: string;
}

class RunTimeout extends Error {}
class RunCancelled extends Error {}
async function bounded<T>(operation: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RunTimeout('Operation exceeded its time bound')), ms);
      abort = () => reject(new RunCancelled('Workspace run cancelled'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** No live backend is configured by default, and there is no fixture fallback. */
export function createCodexWorkspaceRunner(backend?: CodexWorkspaceBackend) {
  return {
    async run(raw: CodexWorkspaceRequest, signal?: AbortSignal): Promise<CodexWorkspaceResult> {
      const request = CodexWorkspaceRequestSchema.parse(raw);
      validateHistoryBinding(request, request.expectedSha);
      if ((request.outputContract === 'rule-revision-v1' || request.outputContract === 'rule-revision-v2' || request.outputContract === 'rule-revision-v3' || request.outputContract === 'comparison-applicability-v1') !== (request.toolPolicy === 'selected-evidence-no-tools-v1')) throw new Error('Revision and comparison applicability output require the fixed selected-evidence/no-tools policy');
      const serialized = JSON.stringify(request);
      if (Buffer.byteLength(serialized) > request.limits.maxInputBytes) throw new Error('Workspace request exceeds maxInputBytes');
      if (!backend) throw new Error('Production Codex workspace backend is not configured: provision isolated SDK/CLI execution and a credential-isolated gateway; local fixture fallback is forbidden');
      if (signal?.aborted) throw new RunCancelled('Workspace run cancelled before acquiring a lease');
      const lease = await acquireWorkspaceExecutionLease(request.workspace, request.expectedSha);
      const result: CodexWorkspaceResult = {
        execution: 'failed', requestDigest: createHash('sha256').update(serialized).digest('hex'), backend: backend.kind,
        output: null, artifacts: [], lifecycle: ['lease-acquired', 'host-workspace-verified'], errors: [], cleanup: 'retained-for-recovery', leasePath: lease.leasePath,
      };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      let runtime: CodexWorkspaceRuntime | undefined;
      try {
        // Sandcastle 0.12.0 otherwise reads this file and falls back to ambient env.
        // Never read its contents, forward env, or invoke repository hooks.
        for (const directory of [lease.record.repoPath, lease.record.worktreePath]) {
          await lstat(join(directory, '.sandcastle', '.env')).then(() => {
            throw new Error('Sandcastle .env forwarding is forbidden for workspace execution');
          }, error => { if (error.code !== 'ENOENT') throw error; });
        }
        if (digestOf(request.evaluation ?? null) !== digestOf(lease.record.evaluation?.binding ?? null)) throw new Error('Workspace request/export binding mismatch');
        await verifyEvaluationWorkspace(lease.record);
        if (controller.signal.aborted) throw new RunCancelled('Workspace run cancelled before runtime reservation');
        runtime = backend.reserve(request, lease.record);
        result.lifecycle.push('runtime-reserved');
        const deadline = Date.now() + request.limits.timeoutMs;
        const observation = await bounded(runtime.prepare(controller.signal), Math.max(1, deadline - Date.now()), controller.signal);
        if (observation.expectedSha !== request.expectedSha || observation.headSha !== request.expectedSha
          || !observation.clean || !observation.identityValid || observation.historyPolicy !== request.historyPolicy
          || digestOf(observation.evaluation ?? null) !== digestOf(request.evaluation ?? null)) {
          throw new Error('Runtime checkout failed exact-SHA, identity, cleanliness or history-policy verification');
        }
        result.lifecycle.push('runtime-workspace-verified', 'worker-started');
        const output = await bounded(runtime.execute(controller.signal), Math.max(1, deadline - Date.now()), controller.signal);
        // Acceptance guard supplements the backend's pre-buffer byte enforcement.
        const outputJson = JSON.stringify(output);
        if (outputJson === undefined || Buffer.byteLength(outputJson) > request.limits.maxOutputBytes) throw new Error('Worker output exceeds its acceptance bound');
        result.output = output;
        result.execution = 'succeeded';
        result.lifecycle.push('worker-completed');
      } catch (error) {
        result.execution = error instanceof RunTimeout ? 'timed-out' : error instanceof RunCancelled ? 'cancelled' : 'failed';
        result.errors.push(error instanceof Error ? error.message.slice(0, 2000) : 'Workspace execution failed');
      } finally {
        controller.abort(); // A request to stop is NOT proof that anything stopped.
        signal?.removeEventListener('abort', abort);
        if (!runtime) {
          await lease.release();
          result.cleanup = 'verified';
          result.lifecycle.push('no-runtime-started', 'lease-released');
        } else {
          try {
            const stopped = await bounded(runtime.stop(), request.limits.cleanupTimeoutMs);
            if (!stopped.stopped || !stopped.verified) throw new Error('Runtime stop unverified; retain runtime and lease for recovery');
            result.lifecycle.push('stop-verified');
            const artifacts = await bounded(runtime.collect(request.limits), request.limits.cleanupTimeoutMs);
            let bytes = 0;
            const names = new Set<string>();
            if (artifacts.length > request.limits.maxArtifacts) throw new Error('Artifact count exceeds configured limit');
            result.artifacts = artifacts.map(artifact => {
              if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(artifact.name) || names.has(artifact.name)
                || !(artifact.bytes instanceof Uint8Array)) throw new Error('Invalid or duplicate artifact');
              names.add(artifact.name);
              bytes += artifact.bytes.byteLength;
              if (bytes > request.limits.maxArtifactBytes) throw new Error('Artifact bytes exceed configured limit');
              const copy = Uint8Array.from(artifact.bytes);
              return { name: artifact.name, bytes: copy, sha256: createHash('sha256').update(copy).digest('hex') };
            });
            result.lifecycle.push('evidence-collected');
            const destroyed = await bounded(runtime.destroy(), request.limits.cleanupTimeoutMs);
            if (!destroyed.destroyed || !destroyed.verified) throw new Error('Runtime destruction unverified; retain lease for recovery');
            result.lifecycle.push('destroy-verified');
            await lease.release();
            result.lifecycle.push('lease-released');
            result.cleanup = 'verified';
          } catch (error) {
            if (result.execution === 'succeeded') result.execution = 'failed';
            result.errors.push(error instanceof Error ? error.message.slice(0, 2000) : 'Runtime cleanup failed');
          }
        }
      }
      return result;
    },
  };
}
