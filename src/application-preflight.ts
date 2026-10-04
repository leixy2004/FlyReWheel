import { ApplicationJobSchema, applicationJobDigest, applicationJobId, applicationJobSummary,
  type ApplicationJobInput } from './application-job-contract.js';
import { PrMiningRequestInputSchema, type PrMiningRequestInput } from './core/pr-mining.js';
import { derivePrMiningRequest } from './pr-mining.js';
import type { QualEvoStore } from './storage/store.js';
import { validateReviewRepositoryContexts } from './semantic-review-context.js';
import { inspectWorkerBootstrap, type WorkerBootstrapDependencies } from './worker-bootstrap.js';

/** Persists the existing domain request, not a second queue or an execution claim.
 * The returned normalized job is passed unchanged to application-jobs enqueue. */
export async function prepareMiningApplicationJob(store: QualEvoStore, raw: PrMiningRequestInput,
  selection: { workspaceId: string; candidateCreatedAt: string; attempt?: string }) {
  const input = PrMiningRequestInputSchema.parse(raw);
  const selected = ApplicationJobSchema.options[0].pick({ workspaceId: true, candidateCreatedAt: true, attempt: true }).parse(selection);
  const evidence = await store.getGithubPrEvidence(input.evidenceDigest);
  const derived = derivePrMiningRequest(input, evidence);
  const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'pr-mining', requestDigest: derived.request.digest, ...selected });
  if (Date.parse(selected.candidateCreatedAt) < Date.parse(input.createdAt)) throw new Error('CANDIDATE_PREDATES_REQUEST');
  const request = await store.createPrMiningRequest(input);
  return { request, job, jobDigest: applicationJobDigest(job), jobId: applicationJobId(job),
    requestPersistence: 'stored' as const, jobPersistence: 'not_enqueued' as const, execution: 'not_run' as const,
    nextAction: 'Use application-jobs preflight and recovery, then explicitly enqueue this job in the same PostgreSQL domain database.' };
}

/** No resolver/backend invocation, queue access, claims, lease reconciliation or model call.
 * Inspect revision evidence without reserving training sources; execution revalidates and reserves.
 * Opening the caller's store can still run the existing database migrations. */
export async function preflightApplicationJob(store: QualEvoStore, raw: ApplicationJobInput,
  options: { bootstrapConfig?: unknown; bootstrapDependencies?: WorkerBootstrapDependencies } = {}) {
  const job = ApplicationJobSchema.parse(raw);
  const issues: { code: string; nextAction: string }[] = [];
  let workspace: { repository: string; expectedSha: string; baseSha: string; headSha: string; workspaceId: string } | null = null;
  try {
    let snapshot;
    if (job.kind === 'pr-mining') {
      const request = await store.getPrMiningRequest(job.requestDigest);
      if (Date.parse(job.candidateCreatedAt) < Date.parse(request.request.input.createdAt)) {
        issues.push({ code: 'candidate_predates_request', nextAction: 'Choose an explicit candidate timestamp at or after the frozen request timestamp.' });
      }
      snapshot = (await store.getGithubPrEvidence(request.request.input.evidenceDigest)).evidence.snapshot;
    } else if (job.kind === 'semantic-review') {
      const rule = await store.getRuleVersion(job.ruleDigest);
      if (rule.rule.schemaVersion !== 2) issues.push({ code: 'semantic_v2_required', nextAction: 'Select a semantic-v2 rule; legacy replay bundles are a separate execution contract.' });
      const stored = await store.getChangeSnapshot(job.snapshotDigest);
      snapshot = stored.snapshot;
      if (job.repositoryContextDigests !== undefined) validateReviewRepositoryContexts(
        await Promise.all(job.repositoryContextDigests.map(digest => store.getRepositoryContext(digest))), stored);
      if (job.governancePlanDigest) await store.requireCurrentGovernedReviewJob(job);
    } else {
      const graph = await store.getRevisionGenerationEvidence(job.requestDigest);
      if (Date.parse(job.candidateCreatedAt) < Date.parse(graph.request.request.createdAt)) {
        issues.push({ code: 'candidate_predates_request', nextAction: 'Choose an explicit candidate timestamp at or after the frozen revision request timestamp.' });
      }
      snapshot = graph.snapshots.find(value => value.digest === job.snapshotDigest)?.snapshot;
      if (!snapshot) issues.push({ code: 'revision_snapshot_not_selected', nextAction: 'Select a snapshot from this revision request’s frozen feedback graph.' });
    }
    if (snapshot) workspace = { workspaceId: job.workspaceId, repository: snapshot.repository.id,
      expectedSha: job.kind === 'pr-mining' ? snapshot.mergeBase : snapshot.head, baseSha: snapshot.mergeBase, headSha: snapshot.head };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    issues.push({ code: code === 'NOT_FOUND' ? 'domain_record_missing' : code === 'STALE_GOVERNANCE_PLAN' ? 'stale_governance_plan' : 'domain_contract_rejected',
      nextAction: code === 'NOT_FOUND' ? 'Import the exact evidence/rule/snapshot and request into this same database; queue jobs carry identities, not their dependency graph.'
        : code === 'STALE_GOVERNANCE_PLAN' ? 'Create a fresh governed plan after reviewing the current governance selection.'
          : 'Inspect the referenced domain records and their exact identity/context/governance bindings; no job was claimed.' });
  }
  const bootstrap = inspectWorkerBootstrap(options.bootstrapConfig, options.bootstrapDependencies);
  issues.push(...bootstrap.issues);
  return { job, jobDigest: applicationJobDigest(job), jobId: applicationJobId(job),
    status: issues.length ? 'blocked' as const : 'ready-for-enqueue' as const, issues, workspace,
    bootstrap, execution: 'not_run' as const, modelExecution: 'not_run' as const,
    workspaceVerification: 'not_run' as const, jobStateChecked: false,
    nextAction: 'Inspect recovery state before enqueue. Configuration presence is not deployment authorization; execution still verifies workspace and lifecycle authority.' };
}

/** Explicit durable status/recovery lookup: existing getApplicationJob may reconcile
 * an expired claim. Never resets an outcome, steals a lease or starts execution. */
export async function inspectApplicationOperation(store: QualEvoStore, raw: ApplicationJobInput) {
  const job = ApplicationJobSchema.parse(raw), jobDigest = applicationJobDigest(job);
  const record = await store.getApplicationJob(jobDigest);
  let action: string, nextAction: string;
  if (!record) {
    action = 'preflight_then_enqueue'; nextAction = 'Check domain and deployment prerequisites, then explicitly enqueue in the same PostgreSQL database. A local PGlite store is not the production queue.';
  } else if (record.state === 'running') {
    action = 'wait_for_owner'; nextAction = 'An owner holds this attempt. Inspect its secured operational logs; do not steal the claim or create a duplicate attempt.';
  } else if (record.state === 'retryable') {
    action = 'inspect_then_reenqueue_same_job'; nextAction = 'The stored attempt is retryable. Confirm the recorded cleanup result and fix the reported cause before explicitly re-enqueueing the identical job; no automatic retry is initiated here.';
  } else if (record.result?.status === 'completed') {
    action = 'inspect_existing_outcome'; nextAction = 'Inspect the recorded domain outcome. Re-delivery returns this outcome; it does not rerun generation or imply a candidate was produced.';
  } else if (record.result?.cleanup === 'retained-for-recovery' || record.result?.modelExecution === 'unknown') {
    action = 'recover_retained_runtime'; nextAction = 'Preserve evidence and use the deployment authority to reconcile/stop/collect/destroy the retained runtime. Review possible prior model activity before authorizing any new attempt. This command cannot perform that recovery.';
  } else {
    action = 'fix_prerequisites_then_explicit_new_attempt'; nextAction = 'This finished result is immutable. Fix its reported prerequisites, inspect prior execution and cleanup, then deliberately choose a new attempt identity if authorized. Re-enqueueing the old job will return the same result.';
  }
  return { job, jobDigest, jobId: applicationJobId(job), state: record?.state ?? 'not_started', attempts: record?.attempts ?? 0,
    result: record?.result ? applicationJobSummary(record.result) : null,
    reconciliation: 'expired-claims-may-be-terminally-blocked' as const,
    recovery: { action, automaticRetryAllowed: false, nextAction }, execution: 'not_started_by_this_command' as const };
}
