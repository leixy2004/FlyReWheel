import type { QualEvoStore } from './storage/store.js';
import type { RevisionModelContext } from './core/revision-model.js';
import { createRevisionWorkspaceModelAdapter, type RevisionModelConfig, type RevisionWorkspaceRuntime } from './adapters/revision-model.js';

/** Application entry point: load only frozen selected inputs with source-split
 * checks, generate through trusted runtime, and atomically save accepted output.
 * Comparison and local decision remain explicit existing store APIs. */
export async function generateRuleRevision(store: QualEvoStore, input: {
  requestDigest: string; candidateId: string; candidateCreatedAt: string; context: RevisionModelContext;
}, config: RevisionModelConfig, runtime?: RevisionWorkspaceRuntime, signal?: AbortSignal) {
  const adapter = createRevisionWorkspaceModelAdapter(config, runtime);
  // Do not resolve private evidence when execution is disabled/unavailable/cancelled.
  if (!config.enabled || !runtime || signal?.aborted) return {
    execution: 'not_run' as const, modelExecution: 'not_run' as const,
    reason: !config.enabled ? 'disabled' as const : !runtime ? 'runtime_unavailable' as const : 'cancelled' as const, candidate: null,
  };
  const graph = await store.prepareRevisionGeneration(input.requestDigest);
  const outcome = await adapter.generate({ ...graph, candidateId: input.candidateId, candidateCreatedAt: input.candidateCreatedAt, context: input.context }, signal);
  if (outcome.execution !== 'succeeded') return outcome;
  if (outcome.status === 'no_rule_change') return { ...outcome, savedOutcome: await store.saveRevisionModelOutcome(outcome.outcomePersistence) };
  if (outcome.status !== 'candidate_requires_review') return outcome;
  return { ...outcome, saved: await store.saveRevisionModelCandidate(outcome.persistence) };
}
