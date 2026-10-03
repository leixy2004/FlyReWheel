import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvaluationWorkspaceBindingSchema, type EvaluationWorkspaceBinding } from './workspace/history-policy.js';
import { digestOf } from './core/identity.js';
import type { QualEvoStore } from './storage/store.js';
import { ApplicationJobSchema, applicationJobDigest, applicationJobSummary,
  type ApplicationJob, type ApplicationJobInput, type ApplicationJobResult } from './application-job-contract.js';
import { createPrMiningWorkspaceModelAdapter, type PrMiningModelConfig, type PrMiningWorkspaceRuntime, type TrustedPrMiningNoCandidate } from './adapters/pr-mining-model.js';
import { createSemanticReviewWorkspaceModelAdapter } from './adapters/semantic-review-model.js';
import { validateReviewRepositoryContexts } from './semantic-review-context.js';
import { createRevisionWorkspaceModelAdapter } from './adapters/revision-model.js';
import { CodexWorkspaceRequestSchema, type CodexWorkspaceRequest } from './workspace/codex-runner.js';

export interface ApplicationWorkspaceSelection {
  workspaceId: string; jobDigest: string; kind: ApplicationJob['kind']; repository: string;
  expectedSha: string; baseSha: string; headSha: string; evaluationExportId?: string;
}
export type ApplicationWorkspaceResolution = CodexWorkspaceRequest['workspace']
  | { workspace: CodexWorkspaceRequest['workspace']; evaluation?: EvaluationWorkspaceBinding };
const ApplicationWorkspaceResolutionSchema = z.union([CodexWorkspaceRequestSchema.shape.workspace,
  z.object({ workspace: CodexWorkspaceRequestSchema.shape.workspace, evaluation: EvaluationWorkspaceBindingSchema.optional() }).strict()]);
export interface ApplicationDispatcherDependencies {
  store: QualEvoStore;
  /** Trusted bootstrap code supplies these dependencies. Nothing loads from queue JSON. */
  runtime?: PrMiningWorkspaceRuntime;
  config?: PrMiningModelConfig;
  /** Read-only lookup of an already prepared/authorized workspace. Must honor
   * cancellation. A selected export must return its exact binding beside the workspace;
   * old resolvers may still return the bare workspace identity. No job path is accepted. */
  resolveWorkspace?: (selection: Readonly<ApplicationWorkspaceSelection>, signal: AbortSignal) => Promise<ApplicationWorkspaceResolution>;
}
export class ApplicationJobRetryError extends Error {
  constructor(readonly result: ApplicationJobResult) { super(`Application job requires retry: ${result.reason}`); this.name = 'ApplicationJobRetryError'; }
}
export class ApplicationJobBusyError extends Error {
  constructor() { super('Application job already has an active execution lease'); this.name = 'ApplicationJobBusyError'; }
}

/** Invalid/stale inputs are terminal. Database transport/deadlock failures remain cleanup-safe retries. */
function governanceRejection(error: unknown): 'stale_governance_plan' | 'governance_plan_rejected' | undefined {
  if (error instanceof z.ZodError) return 'governance_plan_rejected';
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'STALE_GOVERNANCE_PLAN') return 'stale_governance_plan';
  if (typeof code === 'string' && (code.startsWith('GOVERNANCE_')
    || ['NOT_FOUND', 'INTEGRITY_FAILURE', 'UNSUPPORTED_RULE_SCHEMA', 'INVALID_GOVERNANCE_TRANSITION', 'STALE_GOVERNANCE_HEAD'].includes(code)))
    return 'governance_plan_rejected';
  return undefined;
}

/** Queue acknowledgement is separate from the atomic domain+outcome commit.
 * Re-delivery returns the persisted outcome before resolving any workspace.
 * Inference is at-least-once across a crash before commit, never exactly-once. */
export function createApplicationJobDispatcher(dependencies: ApplicationDispatcherDependencies) {
  const { store, resolveWorkspace, runtime, config } = dependencies;
  return async (input: ApplicationJobInput, signal: AbortSignal) => {
    const job = ApplicationJobSchema.parse(input), jobDigest = applicationJobDigest(job), owner = randomUUID();
    const claim = await store.claimApplicationJob(job, owner);
    if (claim.state === 'finished') return applicationJobSummary(claim.record.result!);
    if (claim.state === 'busy') throw new ApplicationJobBusyError();
    const finish = async (result: ApplicationJobResult, persist?: (scoped: QualEvoStore) => Promise<void>, noCandidate?: TrustedPrMiningNoCandidate) => {
      if (result.status === 'completed' && signal.aborted)
        return retry({ status: 'failed', modelExecution: result.modelExecution, cleanup: 'verified', reason: 'cancelled' });
      return applicationJobSummary((await store.completeApplicationJob(job, owner, result, persist, result.status === 'completed' ? signal : undefined, noCandidate)).result!);
    };
    const retry = async (result: ApplicationJobResult): Promise<never> => {
      await store.failApplicationJob(job, owner, result);
      throw new ApplicationJobRetryError(result);
    };
    if (!runtime || !config || !config.enabled || !resolveWorkspace) {
      return finish({ status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started',
        reason: !runtime || !config ? 'runtime_unavailable' : !config.enabled ? 'disabled' : 'workspace_resolver_unavailable' });
    }
    if (signal.aborted) return retry({ status: 'failed', modelExecution: 'not_run', cleanup: 'not_started', reason: 'cancelled' });
    let last: ApplicationJobResult = { status: 'failed', modelExecution: 'not_run', cleanup: 'not_started', reason: 'input_rejected' };
    const workspaceFor = async (snapshot: { repository: { id: string }; mergeBase: string; head: string }, expectedSha: string) => {
      signal.throwIfAborted();
      const selected = await resolveWorkspace(Object.freeze({ workspaceId: job.workspaceId, jobDigest, kind: job.kind,
        repository: snapshot.repository.id, expectedSha, baseSha: snapshot.mergeBase, headSha: snapshot.head,
        ...(job.evaluationExportId === undefined ? {} : { evaluationExportId: job.evaluationExportId }) }), signal);
      signal.throwIfAborted();
      const resolved = ApplicationWorkspaceResolutionSchema.parse(selected);
      const context = 'workspace' in resolved ? resolved : { workspace: resolved };
      if (job.evaluationExportId !== context.evaluation?.exportId
        || (context.evaluation !== undefined && (context.evaluation.repositoryId !== snapshot.repository.id
          || context.evaluation.checkoutSha !== expectedSha))) {
        throw new Error('Workspace resolver evaluation binding does not match the exact requested export/repository/checkout');
      }
      return { workspace: context.workspace, ...(context.evaluation === undefined ? {} : { evaluation: context.evaluation }) };
    };
    const failed = async (outcome: { execution: 'not_run' | 'failed'; modelExecution: ApplicationJobResult['modelExecution'];
      stage?: 'input' | 'runtime' | 'output'; runtimeResult?: { cleanup: 'verified' | 'retained-for-recovery'; execution: 'succeeded' | 'failed' | 'cancelled' | 'timed-out' } | null }) => {
      const cleanup = outcome.runtimeResult?.cleanup ?? 'not_started';
      const result: ApplicationJobResult = { status: cleanup === 'retained-for-recovery' ? 'blocked' : 'failed',
        modelExecution: outcome.modelExecution, cleanup,
        reason: cleanup === 'retained-for-recovery' ? 'cleanup_not_verified' : signal.aborted || outcome.runtimeResult?.execution === 'cancelled' ? 'cancelled'
          : outcome.runtimeResult?.execution === 'timed-out' ? 'timed_out'
          : outcome.stage === 'output' ? 'output_rejected' : outcome.stage === 'input' ? 'input_rejected' : 'runtime_failed' };
      if (result.status === 'blocked') return finish(result);
      return retry(result);
    };
    try {
      const candidateId = `application-${jobDigest}`;
      if (job.kind === 'pr-mining') {
        const request = await store.getPrMiningRequest(job.requestDigest);
        if (Date.parse(job.candidateCreatedAt) < Date.parse(request.request.input.createdAt))
          throw new Error('Mining candidate timestamp predates its frozen request');
        const evidence = await store.getGithubPrEvidence(request.request.input.evidenceDigest);
        const snapshot = evidence.evidence.snapshot;
        // Mining uses the captured before tree; the resolver cannot choose a different SHA.
        const workspace = await workspaceFor(snapshot, snapshot.mergeBase);
        const outcome = await createPrMiningWorkspaceModelAdapter(config, runtime).generate({ request, evidence, candidateId,
          candidateCreatedAt: job.candidateCreatedAt, context: { kind: 'full-repository', repository: snapshot.repository.id,
            checkout: 'before', ...workspace } }, signal);
        if (outcome.execution !== 'succeeded') return failed(outcome);
        last = { status: 'failed', modelExecution: outcome.modelExecution, cleanup: 'verified', reason: 'persistence_failed' };
        if (outcome.status === 'insufficient_evidence') return await finish({ status: 'completed', modelExecution: outcome.modelExecution, cleanup: 'verified',
          outcome: { kind: 'mining-insufficient-evidence', id: candidateId, digest: digestOf(outcome.executionReceipt) }, receipt: outcome.executionReceipt }, undefined, outcome.outcomePersistence);
        return await finish({ status: 'completed', modelExecution: outcome.modelExecution, cleanup: 'verified',
          outcome: { kind: 'pr-mining-candidate', id: outcome.candidate.id, digest: digestOf(outcome.candidate) } },
        async scoped => { await scoped.savePrMiningModelCandidate(outcome.persistence); });
      }
      if (job.kind === 'semantic-review') {
        if (job.governancePlanDigest) {
          try { await store.requireCurrentGovernedReviewJob(job); }
          catch (error) {
            const reason = governanceRejection(error);
            if (!reason) throw error;
            return finish({ status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason });
          }
        }
        const rule = await store.getRuleVersion(job.ruleDigest), snapshot = await store.getChangeSnapshot(job.snapshotDigest);
        const repositoryContexts = job.repositoryContextDigests === undefined ? undefined
          : await Promise.all(job.repositoryContextDigests.map(digest => store.getRepositoryContext(digest)));
        if (repositoryContexts !== undefined) validateReviewRepositoryContexts(repositoryContexts, snapshot);
        const workspace = await workspaceFor(snapshot.snapshot, snapshot.snapshot.head);
        if (job.governancePlanDigest) {
          try { await store.admitGovernedReviewJob(job, owner); }
          catch (error) {
            const reason = governanceRejection(error);
            if (!reason) throw error;
            return finish({ status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason });
          }
          signal.throwIfAborted();
        }
        const outcome = await createSemanticReviewWorkspaceModelAdapter(config, runtime).review({ rule, snapshot,
          ...(repositoryContexts === undefined ? {} : { repositoryContexts }),
          attempt: candidateId, context: { kind: 'full-repository', repository: snapshot.snapshot.repository.id, checkout: 'after', ...workspace } }, signal);
        if (outcome.execution !== 'succeeded') return failed(outcome);
        last = { status: 'failed', modelExecution: outcome.modelExecution, cleanup: 'verified', reason: 'persistence_failed' };
        return await finish({ status: 'completed', modelExecution: outcome.modelExecution, cleanup: 'verified',
          outcome: { kind: 'semantic-review', id: outcome.review.id, digest: digestOf(outcome.review) } },
        async scoped => { await scoped.saveSemanticReviewModelResult(outcome.persistence); });
      }
      const graph = await store.prepareRevisionGeneration(job.requestDigest);
      const snapshot = graph.snapshots.find(value => value.digest === job.snapshotDigest);
      if (!snapshot) throw new Error('Revision workspace snapshot is not selected frozen feedback');
      const workspace = await workspaceFor(snapshot.snapshot, snapshot.snapshot.head);
      const outcome = await createRevisionWorkspaceModelAdapter(config, runtime).generate({ ...graph, candidateId,
        candidateCreatedAt: job.candidateCreatedAt, context: { kind: 'selected-evidence-no-tools', ...workspace, snapshotDigest: job.snapshotDigest } }, signal);
      if (outcome.execution !== 'succeeded') return failed(outcome);
      last = { status: 'failed', modelExecution: outcome.modelExecution, cleanup: 'verified', reason: 'persistence_failed' };
      if (outcome.status === 'no_rule_change') return await finish({ status: 'completed', modelExecution: outcome.modelExecution, cleanup: 'verified',
        outcome: { kind: 'revision-no-mutation', id: outcome.outcome.id, digest: digestOf(outcome.outcome) } },
      async scoped => { await scoped.saveRevisionModelOutcome(outcome.outcomePersistence); });
      return await finish({ status: 'completed', modelExecution: outcome.modelExecution, cleanup: 'verified',
        outcome: { kind: 'revision-candidate', id: outcome.candidate.id, digest: digestOf(outcome.candidate) } },
      async scoped => { await scoped.saveRevisionModelCandidate(outcome.persistence); });
    } catch (error) {
      if (error instanceof ApplicationJobRetryError) throw error;
      // Failed persistence rolls back both domain records and the outcome; the next
      // delivery can rerun inference. A completed commit with lost response is found first.
      const record = await store.getApplicationJob(jobDigest);
      if (record?.state === 'finished') return applicationJobSummary(record.result!);
      return retry({ ...last, ...(signal.aborted ? { reason: 'cancelled' as const } : {}) });
    }
  };
}
