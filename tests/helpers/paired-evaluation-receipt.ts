import { digestOf } from '../../src/core/identity.js';
import type { EvaluationArm } from '../../src/core/paired-evaluation.js';
import type { StoredChangeSnapshot } from '../../src/change-snapshot.js';
import type { EvaluationWorkspaceBinding } from '../../src/workspace/history-policy.js';
import type { SemanticReviewExecutionReceipt } from '../../src/core/semantic-review-execution.js';
import { buildSemanticReviewModelInput, buildSemanticReviewWorkspaceRequest } from '../../src/semantic-review-execution.js';
import { buildExecutedSemanticReview } from '../../src/semantic-review.js';
import { bytesDigest, workspaceRuntimeResultBinding, COMPLETED_WORKSPACE_LIFECYCLE } from '../../src/workspace/execution-receipt.js';

/** Authored adversarial import only. No files, provider, model, scanner or workspace run.
 * The imported receipt's runtime/model claims are deliberately unauthenticated test data. */
export function authoredImportedReceiptReview(unit: EvaluationArm['units'][number], snapshot: StoredChangeSnapshot,
  options: { evaluation?: EvaluationWorkspaceBinding; model?: string; inputTokens?: number; outputTokens?: number; boundary?: 'isolated-runtime' | 'authored-test-no-isolation' } = {}) {
  const fixtures = unit.review?.value.fixtures;
  if (!fixtures || fixtures.schemaVersion !== 2) throw new Error('Authored import helper requires per-anchor offline fixtures');
  const model = options.model ?? 'synthetic-audit-model';
  const context = { kind: 'full-repository' as const, repository: snapshot.snapshot.repository.id, checkout: 'after' as const,
    workspace: { repoPath: '/synthetic/no-files-read', runId: 'audit', attemptId: 'authored-import' },
    ...(options.evaluation === undefined ? {} : { evaluation: options.evaluation }) };
  const generationLimits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, timeoutMs: 3000 };
  const workspaceLimits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
  const prepared = buildSemanticReviewModelInput({ rule: unit.rule, snapshot, context }, { model, limits: generationLimits });
  const request = buildSemanticReviewWorkspaceRequest(prepared, workspaceLimits);
  const value = { ruleDigest: unit.rule.digest, snapshotDigest: snapshot.digest, evidence: fixtures.evidence, judgments: fixtures.judgments };
  const boundary = options.boundary ?? 'isolated-runtime';
  const workerResult: SemanticReviewExecutionReceipt['workerResult'] = {
    protocolVersion: 2, outputContract: 'semantic-review-v2', value,
    usage: { input_tokens: options.inputTokens ?? 100, output_tokens: options.outputTokens ?? 10,
      cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 },
    sessionId: 'authored-unverified-import', boundary,
    processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true },
  };
  const baseReceipt: Omit<SemanticReviewExecutionReceipt, 'runtimeResultDigest'> = {
    schemaVersion: 1, kind: 'semantic-review-workspace-execution', judgmentContract: 'per-anchor-v3',
    ruleDigest: unit.rule.digest, snapshotDigest: snapshot.digest, expectedSha: snapshot.snapshot.head,
    generationDigest: digestOf(prepared.generation), promptDigest: bytesDigest(prepared.generation.prompt), responseDigest: digestOf(value),
    workspaceRequestDigest: bytesDigest(JSON.stringify(request)), model, modelIdentity: 'requested-configuration-not-provider-attested', runtimeId: 'authored-import',
    context, generationLimits, workspaceLimits, snapshotCheck: 'exact-local-git-recapture-matched', execution: 'completed',
    modelExecution: boundary === 'isolated-runtime' ? 'completed' : 'not_run', cleanup: 'verified', completedAt: '2026-10-02T00:00:00Z',
    lifecycle: [...COMPLETED_WORKSPACE_LIFECYCLE], artifacts: [], workerResult, trust: 'trusted-runtime-receipt-not-cryptographic-attestation',
  };
  const executionReceipt = { ...baseReceipt, runtimeResultDigest: digestOf(workspaceRuntimeResultBinding(baseReceipt)) };
  const review = buildExecutedSemanticReview({ rule: unit.rule, snapshot, executionReceipt, attempt: 'authored-import' });
  return { digest: digestOf(review), value: review };
}
