import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import { DigestSchema, IdSchema } from './core/model.js';
import { digestOf } from './core/identity.js';
import { LocalSemanticSelectionInputSchema, LocalSemanticSelectionSchema, type LocalSemanticSelection } from './core/semantic-governance.js';
import { RepositoryContextDigestSetSchema } from './core/semantic-review-context.js';
import { ApplicationLogicalIdSchema, ApplicationJobSchema, applicationJobDigest, applicationJobId,
  applicationJobSummary, type ApplicationJob } from './application-job-contract.js';
import { createApplicationJobDispatcher, type ApplicationDispatcherDependencies } from './application-dispatcher.js';
import { enqueueApplication } from './jobs.js';
import type { QualEvoStore } from './storage/store.js';

export const GOVERNED_REVIEW_LIMITS = { jobs: 20, bytes: 2_000_000 } as const;
/** Paths select applicable rules. Each job reviews its exact full snapshot under that rule's scope. */
export const GovernedReviewPlanInputSchema = LocalSemanticSelectionInputSchema.extend({
  id: ApplicationLogicalIdSchema, snapshotDigest: DigestSchema, workspaceId: ApplicationLogicalIdSchema,
  attempt: ApplicationLogicalIdSchema.default('initial'), evaluationExportId: ApplicationLogicalIdSchema.optional(),
  repositoryContextDigests: RepositoryContextDigestSetSchema.optional(),
}).strict();
export type GovernedReviewPlanInput = z.input<typeof GovernedReviewPlanInputSchema>;
const HeadSchema = z.object({ ruleId: IdSchema, headDigest: DigestSchema }).strict();
export const GovernedReviewPlanSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('local-governed-semantic-review-plan'),
  input: GovernedReviewPlanInputSchema,
  selection: LocalSemanticSelectionSchema, selectionDigest: DigestSchema,
  governanceHeads: z.array(HeadSchema).max(100),
  admissionPolicy: z.literal('recheck-full-registry-before-each-execution'),
  afterAdmission: z.literal('historical-selection-not-revoked-by-later-governance'),
  reviewScope: z.literal('full-snapshot-filtered-by-each-rule-scope'),
  productionActivation: z.literal('not_performed'), notification: z.literal('not_performed'), certification: z.literal('none'),
}).strict();
export type GovernedReviewPlan = z.infer<typeof GovernedReviewPlanSchema>;
export type StoredGovernedReviewPlan = { digest: string; plan: GovernedReviewPlan };
export const GovernedReviewAdmissionSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('local-governed-review-admission'),
  jobDigest: DigestSchema, planDigest: DigestSchema, selectionDigest: DigestSchema,
  attempt: z.number().int().positive(), semantics: z.literal('head-check-committed-before-execution-not-continuous-authorization'),
}).strict();
export type GovernedReviewAdmission = z.infer<typeof GovernedReviewAdmissionSchema>;
export function normalizeGovernedReviewInput(input: GovernedReviewPlanInput) {
  const value = GovernedReviewPlanInputSchema.parse(input);
  return { ...value, paths: [...value.paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))) };
}
export function governanceSelectionHeads(selection: LocalSemanticSelection) {
  const heads = new Map<string, string>();
  for (const entry of [...selection.selected, ...selection.excluded]) {
    const previous = heads.get(entry.ruleId);
    if (previous !== undefined && previous !== entry.headDigest) throw new Error('Inconsistent governance heads');
    heads.set(entry.ruleId, entry.headDigest);
  }
  return [...heads].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([ruleId, headDigest]) => ({ ruleId, headDigest }));
}
export function deriveGovernedReviewPlan(input: GovernedReviewPlanInput, selection: LocalSemanticSelection): GovernedReviewPlan {
  const normalized = normalizeGovernedReviewInput(input);
  if (selection.selected.length > GOVERNED_REVIEW_LIMITS.jobs) throw new Error('Governed review exceeds 20 jobs; narrow the explicit path selection');
  if (selection.repository !== normalized.repository || digestOf(selection.paths) !== digestOf(normalized.paths)) throw new Error('Plan selection query mismatch');
  const plan = GovernedReviewPlanSchema.parse({ schemaVersion: 1, kind: 'local-governed-semantic-review-plan', input: normalized,
    selection, selectionDigest: digestOf(selection), governanceHeads: governanceSelectionHeads(selection),
    admissionPolicy: 'recheck-full-registry-before-each-execution', afterAdmission: 'historical-selection-not-revoked-by-later-governance',
    reviewScope: 'full-snapshot-filtered-by-each-rule-scope', productionActivation: 'not_performed', notification: 'not_performed', certification: 'none' });
  if (Buffer.byteLength(JSON.stringify(plan)) > GOVERNED_REVIEW_LIMITS.bytes) throw new Error('Governed review plan exceeds 2MB; no partial plan was saved');
  return plan;
}
export function governedReviewJobs(stored: StoredGovernedReviewPlan): Extract<ApplicationJob, { kind: 'semantic-review' }>[] {
  const plan = GovernedReviewPlanSchema.parse(stored.plan);
  if (digestOf(plan) !== stored.digest || digestOf(deriveGovernedReviewPlan(plan.input, plan.selection)) !== stored.digest) throw new Error('Governed review plan integrity mismatch');
  return plan.selection.selected.map(entry => ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'semantic-review',
    ruleDigest: entry.ruleDigest, snapshotDigest: plan.input.snapshotDigest, governancePlanDigest: stored.digest,
    workspaceId: plan.input.workspaceId, attempt: plan.input.attempt,
    ...(plan.input.repositoryContextDigests === undefined ? {} : { repositoryContextDigests: plan.input.repositoryContextDigests }),
    ...(plan.input.evaluationExportId === undefined ? {} : { evaluationExportId: plan.input.evaluationExportId }),
  }) as Extract<ApplicationJob, { kind: 'semantic-review' }>);
}
/** Trusted dependencies only. Serial, bounded fan-out; retry resumes durable job identities. */
export async function runGovernedReviewPlan(dependencies: ApplicationDispatcherDependencies, digest: string, signal: AbortSignal) {
  const stored = await dependencies.store.getGovernedReviewPlan(digest), dispatch = createApplicationJobDispatcher(dependencies);
  for (const job of governedReviewJobs(stored)) { signal.throwIfAborted(); await dispatch(job, signal); }
  return governedReviewStatus(dependencies.store, digest);
}
/** Partial enqueue is recoverable by retrying this exact plan; execution rechecks heads again. */
export async function enqueueGovernedReviewPlan(store: QualEvoStore, boss: PgBoss, digest: string) {
  const stored = await store.requireCurrentGovernedReviewPlan(digest), jobs = [];
  for (const job of governedReviewJobs(stored)) {
    const id = await enqueueApplication(boss, job);
    jobs.push({ jobDigest: applicationJobDigest(job), jobId: applicationJobId(job), enqueued: id !== null });
  }
  return { planDigest: digest, reviewSelection: 'local-governed', execution: 'not_run', jobs };
}
export async function governedReviewStatus(store: QualEvoStore, digest: string) {
  const stored = await store.getGovernedReviewPlan(digest);
  const current = await store.isGovernedReviewPlanCurrent(digest), jobs = [];
  for (const job of governedReviewJobs(stored)) {
    const jobDigest = applicationJobDigest(job), record = await store.getApplicationJob(jobDigest);
    const admission = record ? await store.getGovernedReviewAdmission(job, record.attempts) : null;
    jobs.push({ jobDigest, jobId: applicationJobId(job), ruleDigest: job.ruleDigest, state: record?.state ?? 'not_started',
      attempts: record?.attempts ?? 0, admission, result: record?.result ? applicationJobSummary(record.result) : null });
  }
  return { planDigest: digest, reviewSelection: 'local-governed', currentGovernance: current ? 'matches-plan' : 'stale-plan',
    state: jobs.length === 0 ? 'no_eligible_rules' : jobs.every(job => job.state === 'finished') ? 'finished' : 'pending',
    selectedRules: stored.plan.selection.selected.length, excluded: stored.plan.selection.excluded,
    admissionPolicy: stored.plan.admissionPolicy, afterAdmission: stored.plan.afterAdmission, jobs,
    trust: stored.plan.selection.trust, notification: 'not_performed', certification: 'none' };
}
