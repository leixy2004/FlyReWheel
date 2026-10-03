import { createHash } from 'node:crypto';
import { digestOf } from '../core/identity.js';
import type { WorkspaceLimits } from './codex-runner.js';
import type { z } from 'zod';
import type { WorkspaceWorkerProcessEvidence } from './worker-protocol.js';

/** Shared acceptance checks for supervised application output, never attestation. */
export const bytesDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const COMPLETED_WORKSPACE_LIFECYCLE = ['lease-acquired', 'host-workspace-verified', 'runtime-reserved', 'runtime-workspace-verified',
  'worker-started', 'worker-completed', 'stop-verified', 'evidence-collected', 'destroy-verified', 'lease-released'];
export function hasCompletedWorkspaceProcess(worker: { processEvidence: z.infer<typeof WorkspaceWorkerProcessEvidence> }, maxOutputBytes: number): boolean {
  const process = worker.processEvidence;
  return process.reason === 'completed' && process.processGroupStopped && process.exitCode === 0
    && process.stdoutBytes + process.stderrBytes <= maxOutputBytes
    && process.forwardedBytes <= maxOutputBytes
    && process.forwardedBytes <= process.stdoutBytes + process.stderrBytes;
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function boundedJson(value: unknown, limit: number, name: string): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > limit) throw new Error(`${name} exceeds configured byte limit`);
  return json;
}
type ExecutionBinding = {
  workspaceRequestDigest: string; workerResult: { boundary: string }; cleanup: 'verified'; lifecycle: string[];
  artifacts: { name: string; sha256: string; byteLength: number }[];
};
export function workspaceRuntimeResultBinding(receipt: ExecutionBinding) {
  return { execution: 'succeeded', requestDigest: receipt.workspaceRequestDigest, backend: receipt.workerResult.boundary,
    output: receipt.workerResult, artifacts: receipt.artifacts, lifecycle: receipt.lifecycle, errors: [], cleanup: receipt.cleanup };
}
export function validateWorkspaceExecutionBounds(receipt: ExecutionBinding, limits: WorkspaceLimits): void {
  boundedJson(receipt.workerResult, limits.maxOutputBytes, 'Workspace worker result');
  if (digestOf(receipt.lifecycle) !== digestOf(COMPLETED_WORKSPACE_LIFECYCLE)) throw new Error('Workspace execution lifecycle binding mismatch');
  if (receipt.artifacts.length > limits.maxArtifacts
    || new Set(receipt.artifacts.map(item => item.name)).size !== receipt.artifacts.length
    || receipt.artifacts.reduce((total, item) => total + item.byteLength, 0) > limits.maxArtifactBytes) {
    throw new Error('Workspace execution artifact bounds mismatch');
  }
}
