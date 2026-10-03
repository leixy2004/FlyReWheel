import { readTrustedComparisonApplicability, type TrustedComparisonApplicability } from '../adapters/comparison-applicability-model.js';
import { GovernedReviewPlanSchema, GovernedReviewAdmissionSchema, GOVERNED_REVIEW_LIMITS, deriveGovernedReviewPlan,
  normalizeGovernedReviewInput, governedReviewJobs, type GovernedReviewPlan, type GovernedReviewPlanInput,
  type StoredGovernedReviewPlan, type GovernedReviewAdmission } from '../governed-semantic-review.js';
import { validateReviewRepositoryContexts } from '../semantic-review-context.js';
import { SemanticGovernanceStore } from './semantic-governance.js';
import type { SemanticGovernanceCommand, LocalSemanticSelectionInput } from '../core/semantic-governance.js';
import { validateHistoryPlan, matchesHistoryFilter } from '../github-pr-history.js';
import { HistoryBatchSchema, HistoryItemSchema, initialHistoryItems, type HistoryBatch, type HistoryItem } from '../github-pr-history-state.js';
import type { SemanticRuleVersion } from '../core/semantic-rule.js';
import { migrateDatabase } from './migrations.js';
import { z } from 'zod';
import {
  ruleVersionDigest, digestOf, deriveVerdict, evaluateEvidence,
  RuleBundleSchema, RuleVersionSchema, ProblemCaseSchema, RunIdentitySchema, FindingSchema, FeedbackSchema, DigestSchema, IdSchema,
  EvaluationManifestSchema, EvaluationResultSchema, PromotionProposalSchema,
  type RuleBundle, type StoredRuleBundle, type RuleVersion, type StoredRuleVersion, type ProblemCase, type RunIdentity, type StoredRun,
  type Finding, type Feedback, type Verdict, type EvaluationManifest, type EvaluationResult,
  type EvaluationEvidence, type EvaluationReport, type PromotionProposal,
} from '../core/index.js';
import { openPGliteDatabase, openPostgresDatabase, type Database, type Queryable } from './database.js';
import { validateRepositoryContext, type RepositoryContext, type StoredRepositoryContext } from '../repository-context.js';
import { GitShaSchema } from '../git-object-evidence.js';
import { validateChangeSnapshot, type ChangeSnapshot, type StoredChangeSnapshot } from '../change-snapshot.js';
import { validateGithubPrEvidence, type GithubPrEvidence, type StoredGithubPrEvidence } from '../github-pr-evidence.js';
import {
  SemanticReviewSchema, LocalReviewFeedbackSchema, RevisionRequestInputSchema, RevisionRequestSchema, deriveLocalReviewVerdict,
  type SemanticReview, type ReviewFixture, type ReviewFinding, type LocalReviewFeedback,
  type RevisionRequestInput, type StoredRevisionRequest,
} from '../core/semantic-review.js';
import { buildSemanticReview, validateSemanticReview } from '../semantic-review.js';
import { RepositoryContextDigestSetSchema } from '../core/semantic-review-context.js';
import { readTrustedSemanticReview, type TrustedSemanticReview } from '../adapters/semantic-review-model.js';
import { COMPARISON_LIMITS, RevisionComparisonInputSchema, RevisionComparisonSchema, RevisionDecisionInputSchema, RevisionDecisionSchema,
  type RevisionComparisonInput, type StoredRevisionComparison, type RevisionDecisionInput, type StoredRevisionDecision } from '../core/revision-comparison.js';
import { comparisonInputBudget, deriveRevisionComparison, type ComparisonFeedback, type ComparisonPair, type RevisionComparisonScorer } from '../revision-comparison.js';
import { PrMiningRequestInputSchema, PrMiningRequestSchema, PrMiningCandidateInputSchema, PrMiningCandidateSchema,
  type PrMiningRequestInput, type StoredPrMiningRequest, type PrMiningCandidateInput, type PrMiningCandidate, type StoredPrMiningCandidate } from '../core/pr-mining.js';
import { buildPrMiningModelInput, buildPrMiningWorkspaceRequest, readTrustedPrMiningCandidate, readTrustedPrMiningNoCandidate, validateExecutedPrMiningCandidate, type TrustedPrMiningCandidate, type TrustedPrMiningNoCandidate } from '../adapters/pr-mining-model.js';
import { PrMiningModelResponseSchema } from '../core/pr-mining-model.js';
import { bytesDigest, validateWorkspaceExecutionBounds, workspaceRuntimeResultBinding } from '../workspace/execution-receipt.js';
import { derivePrMiningRequest, derivePrMiningCandidate, miningBudget } from '../pr-mining.js';

import { RevisionCandidateSchema, RevisionNoMutationOutcomeSchema, type StoredRevisionCandidate, type StoredRevisionNoMutationOutcome } from '../core/revision-generation.js';
import { REVISION_GENERATION_LIMITS } from '../core/revision-model.js';
import { revisionConsumedSourceDigests, revisionInputBudget, revisionRecordBudget, validateRevisionGenerationEvidence, validateExecutedRevisionCandidate, validateExecutedRevisionNoMutation, type RevisionGenerationEvidence } from '../revision-generation.js';
import { readTrustedRevisionCandidate, readTrustedRevisionNoMutation, type TrustedRevisionCandidate, type TrustedRevisionNoMutation } from '../adapters/revision-model.js';
import {
  ApplicationJobSchema, ApplicationJobResultSchema, ApplicationJobRecordSchema, applicationJobDigest,
  type ApplicationJob, type ApplicationJobResult, type ApplicationJobRecord,
} from '../application-job-contract.js';

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError'; }
}
function fail(code: string, message: string): never { throw new DomainError(code, message); }
export type FindingRecord = { finding: Finding; feedback: Feedback[]; verdict: Verdict };
export type ReviewFindingRecord = {
  finding: ReviewFinding; feedback: LocalReviewFeedback[]; verdict: Verdict; identityVerification: 'caller-declared-unverified';
};
type SemanticReviewRow = { id: string; rule_digest: string; snapshot_digest: string; payload_digest: string; payload: unknown };
type ReviewFindingRow = { id: string; review_id: string; rule_digest: string; snapshot_digest: string; rule_id: string; rule_version: string; payload_digest: string; payload: unknown };
type ReviewFeedbackRow = { id: string; finding_id: string; review_id: string; rule_digest: string; rule_version: string; payload_digest: string; payload: unknown };
type RevisionComparisonRow = { digest: string; id: string; request_digest: string; candidate_rule_digest: string; payload: unknown };
type RevisionDecisionRow = { digest: string; id: string; comparison_digest: string; payload: unknown };
type RevisionRequestRow = { digest: string; id: string; base_rule_digest: string; payload: unknown };
type ApplicationJobRow = {
  job_digest: string; job_payload: unknown; job_payload_digest: string;
  state: string; owner: string | null; lease_expires_at: unknown; lease_valid: boolean;
  attempts: number; result: unknown; result_digest: string | null;
};
export type ApplicationJobClaim = { state: 'claimed'; owner: string } | { state: 'busy' } | { state: 'finished'; record: ApplicationJobRecord };
const ApplicationJobOwnerSchema = z.uuid().transform(value => value.toLowerCase());
// Exceeds the bounded 300-second execution plus all bounded cleanup steps.
const APPLICATION_JOB_LEASE_SECONDS = 15 * 60;
export type StoredEvaluation = { manifest: EvaluationManifest; results: EvaluationResult[] };
export type StoredProposal = { proposal: PromotionProposal; report: EvaluationReport };
export type Promotion = { proposalId: string; actor: string; bundleDigest: string; previousDigest: string | null };
type RuleVersionRow = { digest: string; rule_id: string; version: string; payload: RuleVersion };
export const ArtifactLinkSchema = z.object({
  evaluationId: IdSchema,
  kind: z.enum(['input', 'result']),
  ref: z.object({
    digest: DigestSchema,
    key: z.string(),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict().refine(value => value.key === `sha256/${value.digest}`, 'Artifact key must match its SHA-256 digest'),
}).strict();
export type ArtifactLink = z.infer<typeof ArtifactLinkSchema>;


async function one<T extends Record<string, unknown>>(tx: Queryable, sql: string, values: unknown[]): Promise<T | undefined> {
  return (await tx.query<T>(sql, values)).rows[0];
}

/** Page options only affect discovery; every returned record still uses its exact getter validator. */
export const RevisionCatalogPageSchema = z.object({
  requestDigest: DigestSchema.optional(), id: IdSchema.optional(), after: DigestSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
export const RevisionCandidatePageSchema = RevisionCatalogPageSchema.extend({ ruleDigest: DigestSchema.optional() }).strict();
export const RevisionComparisonPageSchema = RevisionCatalogPageSchema.omit({ id: true }).extend({ candidateRuleDigest: DigestSchema.optional() }).strict();
type RevisionCatalogPage = z.input<typeof RevisionCatalogPageSchema>;
type RevisionCandidatePage = z.input<typeof RevisionCandidatePageSchema>;
type RevisionComparisonPage = z.input<typeof RevisionComparisonPageSchema>;

/** Domain persistence only: no scheduler, provider publication, or model execution. */
export class QualEvoStore {
  private constructor(private readonly db: Database, private readonly applicationJobScope = false) {}
  static async openPGlite(path?: string): Promise<QualEvoStore> { return QualEvoStore.initialize(await openPGliteDatabase(path)); }
  static async openPostgres(connectionString: string): Promise<QualEvoStore> { return QualEvoStore.initialize(await openPostgresDatabase(connectionString)); }
  static async initialize(db: Database): Promise<QualEvoStore> {
    try {
      await migrateDatabase(db);
      return new QualEvoStore(db);
    } catch (error) { try { await db.close(); } catch { /* Preserve the migration failure. */ } throw error; }
  }
  async close(): Promise<void> { await this.db.close(); }

  private async readApplicationJob(tx: Queryable, digest: string, lock = false): Promise<{ row: ApplicationJobRow; record: ApplicationJobRecord } | null> {
    DigestSchema.parse(digest);
    const row = await one<ApplicationJobRow>(tx,
      `SELECT *, COALESCE(lease_expires_at > clock_timestamp(), false) AS lease_valid FROM qe_application_jobs WHERE job_digest=$1${lock ? ' FOR UPDATE' : ''}`, [digest]);
    if (!row) return null;
    const parsed = ApplicationJobRecordSchema.safeParse({ jobDigest: row.job_digest, job: row.job_payload, state: row.state, result: row.result, attempts: row.attempts });
    if (!parsed.success) fail('INTEGRITY_FAILURE', 'Stored application job record is invalid');
    const record = parsed.data;
    if (row.job_digest !== digest || applicationJobDigest(record.job) !== digest
      || row.job_payload_digest !== digestOf(row.job_payload) || row.job_payload_digest !== digestOf(record.job)
      || (record.result === null ? row.result_digest !== null
        : row.result_digest !== digestOf(row.result) || row.result_digest !== digestOf(record.result))) {
      fail('INTEGRITY_FAILURE', 'Stored application job identity or result digest mismatch');
    }
    if (record.state === 'running') {
      if (!ApplicationJobOwnerSchema.safeParse(row.owner).success || row.lease_expires_at === null || record.result !== null) {
        fail('INTEGRITY_FAILURE', 'Stored application job claim is invalid');
      }
    } else if (row.owner !== null || row.lease_expires_at !== null || record.result === null) {
      fail('INTEGRITY_FAILURE', 'Stored application job outcome is invalid');
    }
    if (record.state === 'retryable' && (record.result?.status !== 'failed'
      || !['verified', 'not_started'].includes(record.result.cleanup))) {
      fail('INTEGRITY_FAILURE', 'Stored application job retry is not cleanup-safe');
    }
    if (record.state === 'finished' && record.result) {
      if (record.result.status === 'completed' && record.job.kind === 'semantic-review' && record.job.governancePlanDigest
        && !await this.readGovernedReviewAdmission(tx, record.job, record.attempts))
        fail('INTEGRITY_FAILURE', 'Governed review completion requires the exact admitted execution attempt');
      await this.validateApplicationJobOutcome(tx, record.job, record.result);
    }
    return { row, record };
  }
  private async validateApplicationJobOutcome(tx: Queryable, job: ApplicationJob, result: ApplicationJobResult): Promise<void> {
    if (result.status !== 'completed') return;
    const outcome = result.outcome, expectedId = `application-${applicationJobDigest(job)}`;
    if (!outcome?.digest) fail('INTEGRITY_FAILURE', 'Completed application job requires an exact domain outcome digest');
    const mismatch = () => fail('INTEGRITY_FAILURE', 'Application job outcome does not bind its exact execution input');
    if (job.kind === 'semantic-review') {
      if (outcome.kind !== 'semantic-review') mismatch();
      const review = await this.readSemanticReview(tx, outcome.id);
      if (digestOf(review) !== outcome.digest || review.ruleDigest !== job.ruleDigest || review.snapshotDigest !== job.snapshotDigest
        || digestOf(review.config.repositoryContextDigests ?? []) !== digestOf(job.repositoryContextDigests ?? [])
        || review.config.attempt !== expectedId || review.config.mode !== 'workspace_execution'
        || review.executionReceipt?.modelExecution !== result.modelExecution || review.executionReceipt.context.checkout !== 'after'
        || review.executionReceipt.context.evaluation?.exportId !== job.evaluationExportId) mismatch();
      return;
    }
    if (outcome.id !== expectedId) mismatch();
    if (job.kind === 'pr-mining') {
      if (outcome.kind === 'pr-mining-candidate') {
        const { candidate } = await this.readPrMiningCandidate(tx, outcome.digest);
        if (candidate.schemaVersion !== 2) return mismatch();
        if (candidate.id !== outcome.id || candidate.requestDigest !== job.requestDigest) mismatch();
        const rule = await this.readSemanticRuleVersion(tx, candidate.ruleDigest);
        if (candidate.executionReceipt.modelExecution !== result.modelExecution || candidate.executionReceipt.context.checkout !== 'before'
          || rule.rule.provenance.createdAt !== job.candidateCreatedAt
          || candidate.executionReceipt.context.evaluation?.exportId !== job.evaluationExportId) mismatch();
        return;
      }
      if (outcome.kind !== 'mining-insufficient-evidence' || !result.receipt) mismatch();
      const receipt = result.receipt!;
      if (digestOf(receipt) !== outcome.digest || receipt.requestDigest !== job.requestDigest
        || receipt.modelExecution !== result.modelExecution || receipt.context.checkout !== 'before'
        || receipt.context.evaluation?.exportId !== job.evaluationExportId) mismatch();
      const request = await this.readPrMiningRequest(tx, job.requestDigest);
      const evidence = await this.readGithubPrEvidence(tx, request.request.input.evidenceDigest);
      const prepared = buildPrMiningModelInput({ request, evidence, candidateId: expectedId,
        candidateCreatedAt: job.candidateCreatedAt, context: receipt.context }, { model: receipt.model, limits: receipt.generationLimits });
      const workspaceRequest = buildPrMiningWorkspaceRequest(prepared, receipt.workspaceLimits);
      if (receipt.generationDigest !== digestOf(prepared.generation) || receipt.promptDigest !== bytesDigest(prepared.generation.prompt)
        || receipt.workspaceRequestDigest !== bytesDigest(JSON.stringify(workspaceRequest))
        || receipt.responseDigest !== digestOf(receipt.workerResult.value)
        || receipt.runtimeResultDigest !== digestOf(workspaceRuntimeResultBinding(receipt))) mismatch();
      validateWorkspaceExecutionBounds(receipt, receipt.workspaceLimits);
      const response = PrMiningModelResponseSchema.parse(receipt.workerResult.value).result;
      if (response.status !== 'insufficient_evidence' || new Set(response.evidenceRefs).size !== response.evidenceRefs.length
        || response.evidenceRefs.some(ref => !prepared.evidenceRefs.includes(ref))) mismatch();
      return;
    }
    if (outcome.kind === 'revision-candidate') {
      const { candidate } = await this.readRevisionCandidate(tx, outcome.digest);
      const rule = await this.readSemanticRuleVersion(tx, candidate.ruleDigest);
      if (candidate.id !== outcome.id || candidate.requestDigest !== job.requestDigest
        || candidate.executionReceipt.context.snapshotDigest !== job.snapshotDigest
        || candidate.executionReceipt.modelExecution !== result.modelExecution || rule.rule.provenance.createdAt !== job.candidateCreatedAt
        || candidate.executionReceipt.context.evaluation?.exportId !== job.evaluationExportId) mismatch();
      return;
    }
    if (outcome.kind !== 'revision-no-mutation') mismatch();
    const { outcome: saved } = await this.readRevisionOutcome(tx, outcome.digest);
    if (saved.id !== outcome.id || saved.requestDigest !== job.requestDigest || saved.candidateCreatedAt !== job.candidateCreatedAt
      || saved.executionReceipt.context.snapshotDigest !== job.snapshotDigest || saved.executionReceipt.modelExecution !== result.modelExecution
      || saved.executionReceipt.context.evaluation?.exportId !== job.evaluationExportId) mismatch();
  }
  /** Expiry reconciliation never allocates or restarts a runtime. It is independent
   * of broker retry exhaustion, so interrupted executions cannot look running forever. */
  async reconcileExpiredApplicationJobs(limit = 100, jobDigest?: string): Promise<number> {
    this.checkApplicationJobScope();
    z.number().int().min(1).max(100).parse(limit);
    if (jobDigest !== undefined) DigestSchema.parse(jobDigest);
    return this.db.transaction(async tx => {
      const rows = (await tx.query<{ job_digest: string }>(`SELECT job_digest FROM qe_application_jobs
        WHERE state='running' AND lease_expires_at <= clock_timestamp() AND ($1::text IS NULL OR job_digest=$1)
        ORDER BY job_digest LIMIT $2 FOR UPDATE SKIP LOCKED`, [jobDigest ?? null, limit])).rows;
      for (const row of rows) {
        const current = await this.readApplicationJob(tx, row.job_digest);
        if (!current || current.record.state !== 'running' || current.row.lease_valid) continue;
        const result = ApplicationJobResultSchema.parse({ status: 'blocked', modelExecution: 'unknown',
          reason: 'interrupted_execution_requires_recovery', cleanup: 'retained-for-recovery' });
        await tx.query(`UPDATE qe_application_jobs SET state='finished',owner=NULL,lease_expires_at=NULL,result=$3::jsonb,result_digest=$4
          WHERE job_digest=$1 AND owner=$2 AND state='running' AND lease_expires_at <= clock_timestamp()`,
        [row.job_digest, current.row.owner, JSON.stringify(result), digestOf(result)]);
      }
      return rows.length;
    });
  }
  /** Durable status lookup also reconciles an expired claim; never starts execution. */
  async getApplicationJob(jobDigest: string): Promise<ApplicationJobRecord | null> {
    await this.reconcileExpiredApplicationJobs(1, jobDigest);
    return this.db.transaction(async tx => (await this.readApplicationJob(tx, jobDigest))?.record ?? null);
  }
  private checkApplicationJobPayload(job: ApplicationJob, row: ApplicationJobRow): void {
    if (digestOf(job) !== row.job_payload_digest) fail('IMMUTABLE_CONFLICT', 'Application job identity already has different normalized content');
  }
  private checkApplicationJobScope(): void {
    if (this.applicationJobScope) fail('APPLICATION_JOB_SCOPE_INVALID', 'Application job persistence cannot mutate job claims or outcomes');
  }
  /** Claim once; an interrupted lease is terminally blocked, never silently stolen. */
  async claimApplicationJob(raw: ApplicationJob, rawOwner: string): Promise<ApplicationJobClaim> {
    this.checkApplicationJobScope();
    const job = ApplicationJobSchema.parse(raw), owner = ApplicationJobOwnerSchema.parse(rawOwner), digest = applicationJobDigest(job);
    return this.db.transaction(async tx => {
      const inserted = await tx.query(`INSERT INTO qe_application_jobs(job_digest,job_payload,job_payload_digest,state,owner,lease_expires_at,attempts)
        VALUES($1,$2::jsonb,$3,'running',$4,clock_timestamp() + $5 * interval '1 second',1) ON CONFLICT DO NOTHING RETURNING job_digest`,
      [digest, JSON.stringify(job), digestOf(job), owner, APPLICATION_JOB_LEASE_SECONDS]);
      const current = await this.readApplicationJob(tx, digest, true);
      if (!current) fail('INTEGRITY_FAILURE', 'Application job claim disappeared');
      this.checkApplicationJobPayload(job, current.row);
      if (current.record.state === 'finished') return { state: 'finished', record: current.record };
      if (current.record.state === 'running') {
        if (!current.row.lease_valid) {
          const result = ApplicationJobResultSchema.parse({ status: 'blocked', modelExecution: 'unknown', reason: 'interrupted_execution_requires_recovery', cleanup: 'retained-for-recovery' });
          const expired = await tx.query(`UPDATE qe_application_jobs SET state='finished',owner=NULL,lease_expires_at=NULL,result=$2::jsonb,result_digest=$3
            WHERE job_digest=$1 AND state='running' AND owner=$4 AND lease_expires_at <= clock_timestamp() RETURNING job_digest`,
          [digest, JSON.stringify(result), digestOf(result), current.row.owner]);
          if (!expired.rows.length) fail('APPLICATION_JOB_CONFLICT', 'Application job expiration changed before recording its blocked outcome');
          return { state: 'finished', record: (await this.readApplicationJob(tx, digest))!.record };
        }
        return inserted.rows.length ? { state: 'claimed', owner } : { state: 'busy' };
      }
      const claimed = await tx.query(`UPDATE qe_application_jobs SET state='running',owner=$2,lease_expires_at=clock_timestamp() + $3 * interval '1 second',
        attempts=attempts+1,result=NULL,result_digest=NULL WHERE job_digest=$1 AND state='retryable' RETURNING job_digest`,
      [digest, owner, APPLICATION_JOB_LEASE_SECONDS]);
      if (!claimed.rows.length) fail('APPLICATION_JOB_CONFLICT', 'Application job claim changed');
      return { state: 'claimed', owner };
    });
  }
  private checkApplicationJobOwner(current: { row: ApplicationJobRow; record: ApplicationJobRecord }, owner: string): void {
    if (current.record.state !== 'running' || current.row.owner !== owner || !current.row.lease_valid) {
      fail('APPLICATION_JOB_FENCED', 'Application job claim is no longer owned by this execution');
    }
  }
  /** Reuses every domain save method in the caller's fenced transaction. */
  private async persistApplicationJobDomain(tx: Queryable, persist: (store: QualEvoStore) => Promise<void>): Promise<void> {
    let active = true;
    const assertActive = () => { if (!active) fail('APPLICATION_JOB_SCOPE_CLOSED', 'Application job persistence scope has ended'); };
    const scoped: Database = {
      query: (sql, values) => { assertActive(); return tx.query(sql, values); },
      transaction: fn => { assertActive(); return fn(scoped); },
      migrationTransaction: async () => { fail('APPLICATION_JOB_SCOPE_INVALID', 'Migrations cannot run inside application job persistence'); },
      exec: async () => { fail('APPLICATION_JOB_SCOPE_INVALID', 'Raw execution is not available in application job persistence'); },
      close: async () => { fail('APPLICATION_JOB_SCOPE_INVALID', 'Application job persistence cannot close its parent transaction'); },
    };
    try { await persist(new QualEvoStore(scoped, true)); }
    finally { active = false; }
  }
  /** Model work is already finished. Domain evidence and its outcome commit atomically. */
  async completeApplicationJob(raw: ApplicationJob, rawOwner: string, rawResult: ApplicationJobResult,
    persist?: (scopedStore: QualEvoStore) => Promise<void>, signal?: AbortSignal, noCandidate?: TrustedPrMiningNoCandidate): Promise<ApplicationJobRecord> {
    this.checkApplicationJobScope();
    const job = ApplicationJobSchema.parse(raw), owner = ApplicationJobOwnerSchema.parse(rawOwner);
    const result = ApplicationJobResultSchema.parse(rawResult), digest = applicationJobDigest(job), resultDigest = digestOf(result);
    return this.db.transaction(async tx => {
      const current = await this.readApplicationJob(tx, digest, true);
      if (!current) fail('NOT_FOUND', 'Application job must be claimed before completion');
      this.checkApplicationJobPayload(job, current.row);
      if (current.record.state === 'finished') {
        if (current.row.result_digest !== resultDigest) fail('IMMUTABLE_CONFLICT', 'Application job already has a different terminal outcome');
        return current.record;
      }
      this.checkApplicationJobOwner(current, owner);
      signal?.throwIfAborted();
      if (result.receipt) {
        if (!noCandidate) fail('APPLICATION_JOB_CAPABILITY_REQUIRED', 'Mining no-candidate execution requires its exact trusted runtime capability');
        const input = readTrustedPrMiningNoCandidate(noCandidate);
        if (job.kind !== 'pr-mining' || input.id !== `application-${digest}` || input.requestDigest !== job.requestDigest
          || input.candidateCreatedAt !== job.candidateCreatedAt || digestOf(input.executionReceipt) !== digestOf(result.receipt))
          fail('APPLICATION_JOB_CAPABILITY_REQUIRED', 'Mining no-candidate execution requires its exact trusted runtime capability');
      }
      if (persist && result.status !== 'completed') fail('APPLICATION_JOB_OUTCOME_INVALID', 'Only completed application jobs may persist domain evidence');
      if (persist) await this.persistApplicationJobDomain(tx, persist);
      signal?.throwIfAborted();
      const updated = await tx.query(`UPDATE qe_application_jobs SET state='finished',owner=NULL,lease_expires_at=NULL,result=$3::jsonb,result_digest=$4
        WHERE job_digest=$1 AND state='running' AND owner=$2 AND lease_expires_at > clock_timestamp() RETURNING job_digest`,
      [digest, owner, JSON.stringify(result), resultDigest]);
      if (!updated.rows.length) fail('APPLICATION_JOB_FENCED', 'Application job claim expired before committing its outcome');
      const finished = (await this.readApplicationJob(tx, digest))!.record;
      signal?.throwIfAborted();
      return finished;
    });
  }
  /** Only an explicitly cleanup-safe failure permits another attempt of this job. */
  async failApplicationJob(raw: ApplicationJob, rawOwner: string, rawResult: ApplicationJobResult): Promise<void> {
    this.checkApplicationJobScope();
    const job = ApplicationJobSchema.parse(raw), owner = ApplicationJobOwnerSchema.parse(rawOwner), result = ApplicationJobResultSchema.parse(rawResult);
    if (result.status !== 'failed' || !['verified', 'not_started'].includes(result.cleanup)) {
      fail('APPLICATION_JOB_RETRY_UNSAFE', 'Application job retries require a failure with verified cleanup or no runtime start');
    }
    const digest = applicationJobDigest(job);
    await this.db.transaction(async tx => {
      const current = await this.readApplicationJob(tx, digest, true);
      if (!current) fail('NOT_FOUND', 'Application job must be claimed before failure');
      this.checkApplicationJobPayload(job, current.row);
      this.checkApplicationJobOwner(current, owner);
      const updated = await tx.query(`UPDATE qe_application_jobs SET state='retryable',owner=NULL,lease_expires_at=NULL,result=$3::jsonb,result_digest=$4
        WHERE job_digest=$1 AND state='running' AND owner=$2 AND lease_expires_at > clock_timestamp() RETURNING job_digest`,
      [digest, owner, JSON.stringify(result), digestOf(result)]);
      if (!updated.rows.length) fail('APPLICATION_JOB_FENCED', 'Application job claim expired before recording its failure');
    });
  }

  /** Atomic content-only persistence. Import does not authenticate a producer's Git/provider claims. */
  /** Selected context bytes are append-only; imported receipts never promote their trust level. */
  async importRepositoryContext(input: RepositoryContext): Promise<StoredRepositoryContext> {
    const value = validateRepositoryContext(input);
    return this.db.transaction(async tx => {
      await tx.query('INSERT INTO qe_repository_contexts(digest,repository_id,head_sha,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',
        [value.digest, value.context.repository.id, value.context.head, JSON.stringify(value.context)]);
      return this.readRepositoryContext(tx, value.digest);
    });
  }
  private async readRepositoryContext(tx: Queryable, digest: string): Promise<StoredRepositoryContext> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; repository_id: string; head_sha: string; payload: unknown }>(tx,
      'SELECT digest,repository_id,head_sha,payload FROM qe_repository_contexts WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown repository context ${digest}`);
    const value = validateRepositoryContext(row.payload);
    if (value.digest !== digest || row.digest !== digest || row.repository_id !== value.context.repository.id || row.head_sha !== value.context.head) {
      fail('INTEGRITY_FAILURE', 'Stored repository context identity mismatch');
    }
    return value;
  }
  async getRepositoryContext(digest: string): Promise<StoredRepositoryContext> { return this.readRepositoryContext(this.db, digest); }
  async listRepositoryContexts(input: { repositoryId?: string; head?: string; after?: string; limit?: number } = {}): Promise<StoredRepositoryContext[]> {
    const options = z.object({ repositoryId: z.string().min(1).max(300).optional(), head: GitShaSchema.optional(),
      after: DigestSchema.optional(), limit: z.number().int().min(1).max(100).default(20) }).strict().parse(input);
    const rows = (await this.db.query<{ digest: string }>(
      'SELECT digest FROM qe_repository_contexts WHERE ($1::text IS NULL OR repository_id=$1) AND ($2::text IS NULL OR head_sha=$2) AND ($3::text IS NULL OR digest>$3) ORDER BY digest LIMIT $4',
      [options.repositoryId ?? null, options.head ?? null, options.after ?? null, options.limit])).rows;
    return Promise.all(rows.map(row => this.readRepositoryContext(this.db, row.digest)));
  }

  async importChangeSnapshot(input: ChangeSnapshot): Promise<StoredChangeSnapshot> {
    const value = validateChangeSnapshot(input);
    return this.db.transaction(tx => this.insertChangeSnapshot(tx, value));
  }
  private async insertChangeSnapshot(tx: Queryable, value: StoredChangeSnapshot): Promise<StoredChangeSnapshot> {
    await tx.query('INSERT INTO qe_change_snapshots(digest,repository_id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',
      [value.digest, value.snapshot.repository.id, JSON.stringify(value.snapshot)]);
    return this.readChangeSnapshot(tx, value.digest);
  }
  private async readChangeSnapshot(tx: Queryable, digest: string): Promise<StoredChangeSnapshot> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; repository_id: string; payload: unknown }>(tx,
      'SELECT digest,repository_id,payload FROM qe_change_snapshots WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown change snapshot ${digest}`);
    const value = validateChangeSnapshot(row.payload);
    if (value.digest !== digest || row.digest !== digest || row.repository_id !== value.snapshot.repository.id) fail('INTEGRITY_FAILURE', 'Stored change snapshot identity mismatch');
    return value;
  }
  async getChangeSnapshot(digest: string): Promise<StoredChangeSnapshot> { return this.readChangeSnapshot(this.db, digest); }

  /** Atomic immutable content only. Fresh API receipts are never persisted as trust. */
  async importGithubPrEvidence(input: GithubPrEvidence): Promise<StoredGithubPrEvidence> {
    const value = validateGithubPrEvidence(input);
    const snapshot = validateChangeSnapshot(value.evidence.snapshot);
    return this.db.transaction(async tx => {
      await this.insertChangeSnapshot(tx, snapshot);
      await tx.query('INSERT INTO qe_github_pr_evidence(digest,snapshot_digest,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',
        [value.digest, value.evidence.snapshotDigest, JSON.stringify(value.evidence)]);
      return this.readGithubPrEvidence(tx, value.digest);
    });
  }
  private async readGithubPrEvidence(tx: Queryable, digest: string): Promise<StoredGithubPrEvidence> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; snapshot_digest: string; payload: unknown }>(tx,
      'SELECT digest,snapshot_digest,payload FROM qe_github_pr_evidence WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown GitHub PR evidence ${digest}`);
    const value = validateGithubPrEvidence(row.payload);
    if (value.digest !== digest || row.digest !== digest || row.snapshot_digest !== value.evidence.snapshotDigest) {
      fail('INTEGRITY_FAILURE', 'Stored GitHub PR evidence identity or snapshot binding mismatch');
    }
    const snapshot = await this.readChangeSnapshot(tx, row.snapshot_digest);
    if (snapshot.digest !== value.evidence.snapshotDigest || digestOf(snapshot.snapshot) !== digestOf(value.evidence.snapshot)) {
      fail('INTEGRITY_FAILURE', 'Stored GitHub PR evidence snapshot content mismatch');
    }
    return value;
  }
  async getGithubPrEvidence(digest: string): Promise<StoredGithubPrEvidence> { return this.readGithubPrEvidence(this.db, digest); }

  /** Import only discovery selection. External progress/receipt claims are never accepted. */
  async importGithubPrHistoryPlan(input: unknown): Promise<HistoryBatch> {
    const value = validateHistoryPlan(input);
    await this.db.query('INSERT INTO qe_github_pr_history(digest,repository,plan,items) VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT DO NOTHING',
      [value.digest, value.plan.filter.repository, JSON.stringify(value.plan), JSON.stringify(initialHistoryItems(value.plan.pulls.map(pull => pull.number)))]);
    return this.getGithubPrHistoryBatch(value.digest);
  }
  async getGithubPrHistoryBatch(digest: string): Promise<HistoryBatch> {
    return this.db.transaction(tx => this.readGithubPrHistoryBatch(tx, digest));
  }
  private async readGithubPrHistoryBatch(tx: Queryable, digest: string): Promise<HistoryBatch> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; repository: string; plan: unknown; revision: number; items: unknown }>(tx,
      'SELECT * FROM qe_github_pr_history WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown GitHub PR history batch ${digest}`);
    const result = HistoryBatchSchema.parse({ digest: row.digest, plan: row.plan, revision: row.revision, items: row.items, receipt: { kind: 'package-integrity-only' } });
    if (result.digest !== digest || result.plan.filter.repository !== row.repository) fail('INTEGRITY_FAILURE', 'Stored history plan identity mismatch');
    for (const item of result.items.filter(value => value.status === 'captured')) await this.validateGithubPrHistoryBinding(tx, result, item);
    return result;
  }
  private async validateGithubPrHistoryBinding(tx: Queryable, batch: HistoryBatch, item: HistoryItem): Promise<void> {
    const evidence = await this.readGithubPrEvidence(tx, item.evidenceDigest!);
    if (evidence.evidence.pull.repository.toLowerCase() !== batch.plan.filter.repository || evidence.evidence.pull.number !== item.number || evidence.evidence.snapshotDigest !== item.snapshotDigest || !matchesHistoryFilter(evidence.evidence.pull, batch.plan.filter)) fail('INTEGRITY_FAILURE', 'Captured evidence does not match history selection');
    for (const requestDigest of item.miningRequestDigests) {
      if ((await this.readPrMiningRequest(tx, requestDigest)).request.input.evidenceDigest !== item.evidenceDigest) fail('INTEGRITY_FAILURE', 'Mining request does not bind this captured PR evidence');
    }
  }
  async listGithubPrHistoryBatches(input: { repository?: string; after?: string; limit?: number } = {}) {
    const options = z.object({ repository: z.string().max(140).optional(), after: DigestSchema.optional(), limit: z.number().int().min(1).max(100).default(20) }).strict().parse(input);
    const rows = (await this.db.query<{ digest: string }>('SELECT digest FROM qe_github_pr_history WHERE ($1::text IS NULL OR repository=$1) AND ($2::text IS NULL OR digest>$2) ORDER BY digest LIMIT $3',
      [options.repository?.toLowerCase() ?? null, options.after ?? null, options.limit])).rows;
    const results = [];
    for (const row of rows) {
      const batch = await this.getGithubPrHistoryBatch(row.digest);
      results.push({ digest: batch.digest, revision: batch.revision, filter: batch.plan.filter, discovery: batch.plan.discovery,
        counts: Object.fromEntries(['pending', 'capturing', 'captured', 'failed'].map(status => [status, batch.items.filter(item => item.status === status).length])) });
    }
    return { batches: results, nextAfter: rows.at(-1)?.digest ?? null, receipt: { kind: 'package-integrity-only' as const } };
  }
  /** CAS progress update; batch execution is explicitly serial and never scheduled here. */
  async updateGithubPrHistoryItem(digest: string, revision: number, raw: HistoryItem): Promise<HistoryBatch> {
    return this.db.transaction(tx => this.updateGithubPrHistoryItemInTransaction(tx, digest, revision, raw));
  }
  private async updateGithubPrHistoryItemInTransaction(tx: Queryable, digest: string, revision: number, raw: HistoryItem): Promise<HistoryBatch> {
    const item = HistoryItemSchema.parse(raw), batch = await this.readGithubPrHistoryBatch(tx, digest);
    if (batch.revision !== revision) fail('HISTORY_CONFLICT', 'History batch changed; stop concurrent operators and inspect progress');
    const previous = batch.items.find(value => value.number === item.number);
    if (!previous) fail('NOT_FOUND', 'PR is outside the frozen history plan');
    const starting = item.status === 'capturing' && previous.status !== 'captured' && previous.status !== 'capturing' && item.attempts === previous.attempts + 1;
    if (starting && batch.items.some(value => value.status === 'capturing')) fail('HISTORY_CONFLICT', 'Another history capture is active');
    const finishing = previous.status === 'capturing' && ['captured', 'failed'].includes(item.status) && item.attempts === previous.attempts && item.lastAttemptAt === previous.lastAttemptAt;
    const linking = previous.status === 'captured' && item.status === 'captured' && item.evidenceDigest === previous.evidenceDigest && item.snapshotDigest === previous.snapshotDigest && item.attempts === previous.attempts && item.lastAttemptAt === previous.lastAttemptAt && previous.miningRequestDigests.every(value => item.miningRequestDigests.includes(value));
    if (!starting && !finishing && !linking) fail('INVALID_TRANSITION', 'Invalid history progress transition');
    if (item.status === 'captured') await this.validateGithubPrHistoryBinding(tx, batch, item);
    const items = batch.items.map(value => value.number === item.number ? item : value);
    const changed = await tx.query('UPDATE qe_github_pr_history SET items=$1::jsonb,revision=revision+1 WHERE digest=$2 AND revision=$3 RETURNING digest', [JSON.stringify(items), digest, revision]);
    if (!changed.rows.length) fail('HISTORY_CONFLICT', 'History batch changed; stop concurrent operators and inspect progress');
    return this.readGithubPrHistoryBatch(tx, digest);
  }
  async createGithubPrHistoryMiningRequest(digest: string, number: number, input: PrMiningRequestInput) {
    miningBudget(input);
    const options = PrMiningRequestInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const batch = await this.readGithubPrHistoryBatch(tx, digest), item = batch.items.find(value => value.number === number);
      if (!item || item.status !== 'captured' || item.evidenceDigest !== options.evidenceDigest) fail('INVALID_SELECTION', 'Mining request must select this batch PR’s exact captured evidence digest');
      // Existing immutable request/unknown-case derivation is reused within the same transaction;
      // an over-cap link or CAS failure rolls back its request and case inserts too.
      const request = await this.insertPrMiningRequest(tx, options);
      if (!item.miningRequestDigests.includes(request.digest)) await this.updateGithubPrHistoryItemInTransaction(tx, digest, batch.revision,
        { ...item, miningRequestDigests: [...item.miningRequestDigests, request.digest].sort() });
      return request;
    });
  }

  /** Freeze selected PR bytes/statements and derive unknown-only training cases atomically. */
  async createPrMiningRequest(input: PrMiningRequestInput): Promise<StoredPrMiningRequest> {
    miningBudget(input);
    const options = PrMiningRequestInputSchema.parse(input);
    return this.db.transaction(tx => this.insertPrMiningRequest(tx, options));
  }
  private async insertPrMiningRequest(tx: Queryable, options: PrMiningRequestInput): Promise<StoredPrMiningRequest> {
    const evidence = await this.readGithubPrEvidence(tx, options.evidenceDigest);
    const derived = derivePrMiningRequest(options, evidence), { digest, request } = derived.request;
    await this.checkMiningParent(tx, options);
    for (const value of derived.cases) await this.importCase(tx, value);
    await tx.query('INSERT INTO qe_pr_mining_requests(digest,id,evidence_digest,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',
      [digest, options.id, options.evidenceDigest, JSON.stringify(request)]);
    const existing = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_pr_mining_requests WHERE id=$1', [options.id]);
    if (existing?.digest !== digest) fail('IMMUTABLE_CONFLICT', 'Mining request ID already has different content');
    return this.readPrMiningRequest(tx, digest);
  }
  private async checkMiningParent(tx: Queryable, input: PrMiningRequestInput): Promise<void> {
    if (input.requestedRule.parentDigest !== null) {
      const parent = await this.readRuleVersion(tx, input.requestedRule.parentDigest);
      if (parent.rule.ruleId !== input.requestedRule.ruleId || parent.rule.version === input.requestedRule.version) {
        fail('INVALID_LINEAGE', 'Mining request must select the same logical parent rule and a different version');
      }
    }
  }
  private async readPrMiningRequest(tx: Queryable, digest: string): Promise<StoredPrMiningRequest> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; id: string; evidence_digest: string; payload: unknown }>(tx, 'SELECT * FROM qe_pr_mining_requests WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown PR mining request ${digest}`);
    miningBudget(row.payload);
    const request = PrMiningRequestSchema.parse(row.payload);
    if (row.digest !== digest || digestOf(request) !== digest || request.input.id !== row.id || request.input.evidenceDigest !== row.evidence_digest) {
      fail('INTEGRITY_FAILURE', 'Stored mining request identity mismatch');
    }
    await this.checkMiningParent(tx, request.input);
    const evidence = await this.readGithubPrEvidence(tx, row.evidence_digest);
    const derived = derivePrMiningRequest(request.input, evidence);
    if (derived.request.digest !== digest) fail('INTEGRITY_FAILURE', 'Stored mining request bindings disagree with pinned PR evidence');
    for (const value of derived.cases) {
      const stored = await this.readCase(tx, value.id);
      if (digestOf(stored) !== digestOf(value)) fail('INTEGRITY_FAILURE', 'Mining source case differs from its pinned evidence');
    }
    return { digest, request };
  }
  async getPrMiningRequest(digest: string): Promise<StoredPrMiningRequest> { return this.readPrMiningRequest(this.db, digest); }
  async listPrMiningRequests(evidenceDigest?: string): Promise<StoredPrMiningRequest[]> {
    if (evidenceDigest !== undefined) DigestSchema.parse(evidenceDigest);
    return this.db.transaction(async tx => {
      const rows = (await tx.query<{ digest: string }>('SELECT digest FROM qe_pr_mining_requests WHERE ($1::text IS NULL OR evidence_digest=$1) ORDER BY digest LIMIT 101', [evidenceDigest ?? null])).rows;
      if (rows.length > 100) fail('LIST_LIMIT', 'More than 100 mining requests; filter by evidence digest');
      const result: StoredPrMiningRequest[] = [];
      for (const row of rows) result.push(await this.readPrMiningRequest(tx, row.digest));
      return result;
    });
  }
  /** A supplied candidate is syntax/provenance checked, never synthesized, certified or activated. */
  async importPrMiningCandidate(input: PrMiningCandidateInput): Promise<StoredPrMiningCandidate> {
    miningBudget(input);
    const options = PrMiningCandidateInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const request = await this.readPrMiningRequest(tx, options.requestDigest);
      const candidate = derivePrMiningCandidate(options, request);
      return this.insertPrMiningCandidate(tx, candidate, options.rule);
    });
  }
  /** Only an in-process completed runtime capability authorizes generated import.
   * Serialized receipts and model-authored JSON cannot enter through this API.
   */
  async savePrMiningModelCandidate(capability: TrustedPrMiningCandidate): Promise<StoredPrMiningCandidate> {
    const input = readTrustedPrMiningCandidate(capability);
    return this.db.transaction(async tx => {
      const request = await this.readPrMiningRequest(tx, input.requestDigest);
      const evidence = await this.readGithubPrEvidence(tx, request.request.input.evidenceDigest);
      const candidate = validateExecutedPrMiningCandidate(input, request, evidence);
      return this.insertPrMiningCandidate(tx, candidate, input.rule);
    });
  }
  private async insertPrMiningCandidate(tx: Queryable, candidate: PrMiningCandidate, rule: SemanticRuleVersion): Promise<StoredPrMiningCandidate> {
    const digest = digestOf(candidate);
    await this.insertRuleVersion(tx, rule);
    await tx.query('INSERT INTO qe_pr_mining_candidates(digest,id,request_digest,rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
      [digest, candidate.id, candidate.requestDigest, candidate.ruleDigest, JSON.stringify(candidate)]);
    const existing = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_pr_mining_candidates WHERE id=$1', [candidate.id]);
    if (existing?.digest !== digest) fail('IMMUTABLE_CONFLICT', 'Mining candidate ID already has different content');
    return this.readPrMiningCandidate(tx, digest);
  }
  private async readPrMiningCandidate(tx: Queryable, digest: string): Promise<StoredPrMiningCandidate> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; id: string; request_digest: string; rule_digest: string; payload: unknown }>(tx, 'SELECT * FROM qe_pr_mining_candidates WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown PR mining candidate ${digest}`);
    miningBudget(row.payload);
    const candidate = PrMiningCandidateSchema.parse(row.payload);
    if (row.digest !== digest || digestOf(candidate) !== digest || candidate.id !== row.id || candidate.requestDigest !== row.request_digest || candidate.ruleDigest !== row.rule_digest) {
      fail('INTEGRITY_FAILURE', 'Stored mining candidate identity mismatch');
    }
    const request = await this.readPrMiningRequest(tx, candidate.requestDigest), rule = await this.readSemanticRuleVersion(tx, candidate.ruleDigest);
    if (rule.rule.schemaVersion !== 2) fail('UNSUPPORTED_RULE_SCHEMA', 'PR mining candidates require semantic rule v2');
    const derived = candidate.schemaVersion === 1
      ? derivePrMiningCandidate({ id: candidate.id, requestDigest: candidate.requestDigest, source: candidate.source, rule: rule.rule }, request)
      : validateExecutedPrMiningCandidate({ id: candidate.id, requestDigest: candidate.requestDigest, rule: rule.rule, executionReceipt: candidate.executionReceipt },
        request, await this.readGithubPrEvidence(tx, request.request.input.evidenceDigest));
    if (digestOf(derived) !== digest) fail('INTEGRITY_FAILURE', 'Mining candidate provenance differs from its exact request/rule');
    return { digest, candidate };
  }
  async getPrMiningCandidate(digest: string): Promise<StoredPrMiningCandidate> { return this.readPrMiningCandidate(this.db, digest); }
  async listPrMiningCandidates(requestDigest?: string): Promise<StoredPrMiningCandidate[]> {
    if (requestDigest !== undefined) DigestSchema.parse(requestDigest);
    return this.db.transaction(async tx => {
      const rows = (await tx.query<{ digest: string }>('SELECT digest FROM qe_pr_mining_candidates WHERE ($1::text IS NULL OR request_digest=$1) ORDER BY digest LIMIT 101', [requestDigest ?? null])).rows;
      if (rows.length > 100) fail('LIST_LIMIT', 'More than 100 mining candidates; filter by request digest');
      const result: StoredPrMiningCandidate[] = [];
      for (const row of rows) result.push(await this.readPrMiningCandidate(tx, row.digest));
      return result;
    });
  }

  /** Bounded, stable content-digest pagination, not an inferred chronology. */
  async listChangeSnapshots(input: { repositoryId?: string; after?: string; limit?: number } = {}): Promise<StoredChangeSnapshot[]> {
    const options = z.object({ repositoryId: z.string().min(1).max(300).optional(), after: DigestSchema.optional(), limit: z.number().int().min(1).max(100).default(20) }).strict().parse(input);
    const rows = (await this.db.query<{ digest: string }>(
      'SELECT digest FROM qe_change_snapshots WHERE ($1::text IS NULL OR repository_id=$1) AND ($2::text IS NULL OR digest>$2) ORDER BY digest LIMIT $3',
      [options.repositoryId ?? null, options.after ?? null, options.limit])).rows;
    return Promise.all(rows.map(row => this.readChangeSnapshot(this.db, row.digest)));
  }

  /** One immutable rule/snapshot/config result. The complete review and its index commit together. */
  async runSemanticReview(input: { ruleDigest: string; snapshotDigest: string; fixtures?: ReviewFixture; attempt?: string; repositoryContextDigests?: string[] }): Promise<SemanticReview> {
    const options = z.object({ ruleDigest: DigestSchema, snapshotDigest: DigestSchema, fixtures: z.unknown().optional(), attempt: z.string().optional(),
      repositoryContextDigests: RepositoryContextDigestSetSchema.optional() }).strict().parse(input);
    const rule = await this.readSemanticRuleVersion(this.db, options.ruleDigest);
    const snapshot = await this.readChangeSnapshot(this.db, options.snapshotDigest);
    const repositoryContexts = options.repositoryContextDigests === undefined ? undefined
      : await Promise.all(options.repositoryContextDigests.map(digest => this.readRepositoryContext(this.db, digest)));
    const review = await buildSemanticReview({ rule, snapshot, ...(input.fixtures === undefined ? {} : { fixtures: input.fixtures }),
      ...(repositoryContexts === undefined ? {} : { repositoryContexts }), ...(options.attempt === undefined ? {} : { attempt: options.attempt }) });
    return this.saveSemanticReview(review);
  }
  /** Runtime capability only. A JSON receipt/result cannot claim execution. */
  async saveSemanticReviewModelResult(capability: TrustedSemanticReview): Promise<SemanticReview> {
    const review = readTrustedSemanticReview(capability);
    const rule = await this.readSemanticRuleVersion(this.db, review.ruleDigest);
    const snapshot = await this.readChangeSnapshot(this.db, review.snapshotDigest);
    validateSemanticReview(review, rule, snapshot);
    return this.saveSemanticReview(review);
  }
  private async saveSemanticReview(review: SemanticReview): Promise<SemanticReview> {
    return this.db.transaction(async tx => {
      await this.checkSemanticReviewRepositoryContexts(tx, review);
      await tx.query('INSERT INTO qe_semantic_reviews(id,rule_digest,snapshot_digest,payload_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
        [review.id, review.ruleDigest, review.snapshotDigest, digestOf(review), JSON.stringify(review)]);
      // A conflicting deterministic identity must not attach new children to the existing review.
      const existing = await one<SemanticReviewRow>(tx, 'SELECT * FROM qe_semantic_reviews WHERE id=$1', [review.id]);
      if (!existing || existing.payload_digest !== digestOf(review) || digestOf(existing.payload) !== digestOf(review)) fail('IMMUTABLE_CONFLICT', 'Semantic review identity already has different content');
      for (const finding of review.findings) {
        await tx.query('INSERT INTO qe_semantic_review_findings(id,review_id,rule_digest,snapshot_digest,rule_id,rule_version,payload_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING',
          [finding.id, finding.reviewId, finding.ruleDigest, finding.snapshotDigest, finding.ruleId, finding.ruleVersion, digestOf(finding), JSON.stringify(finding)]);
      }
      return this.readSemanticReview(tx, review.id);
    });
  }
  private async readSemanticRuleVersion(tx: Queryable, digest: string): Promise<StoredRuleVersion> {
    const stored = await this.readRuleVersion(tx, digest);
    if (stored.rule.schemaVersion !== 2) fail('UNSUPPORTED_RULE_SCHEMA', 'Semantic snapshot reviews and revision requests require a semantic rule v2');
    return stored;
  }
  /** An embedded package is durable review evidence only while it resolves to
   * the exact immutable registered context, never a caller-only JSON package. */
  private async checkSemanticReviewRepositoryContexts(tx: Queryable, review: SemanticReview): Promise<void> {
    for (const context of review.repositoryContexts ?? []) {
      const registered = await this.readRepositoryContext(tx, context.digest);
      if (digestOf(registered) !== digestOf(context)) fail('INTEGRITY_FAILURE', 'Semantic review repository context differs from its exact registered package');
    }
  }
  private async readSemanticReview(tx: Queryable, id: string, resources?: {
    count(value: unknown): void; rule(digest: string): Promise<StoredRuleVersion>; snapshot(digest: string): Promise<StoredChangeSnapshot>;
  }): Promise<SemanticReview> {
    SemanticReviewSchema.shape.id.parse(id);
    const row = await one<SemanticReviewRow>(tx, 'SELECT * FROM qe_semantic_reviews WHERE id=$1', [id]);
    if (!row) fail('NOT_FOUND', `Unknown semantic review ${id}`);
    resources?.count(row.payload);
    const rule = await (resources ? resources.rule(row.rule_digest) : this.readSemanticRuleVersion(tx, row.rule_digest));
    const snapshot = await (resources ? resources.snapshot(row.snapshot_digest) : this.readChangeSnapshot(tx, row.snapshot_digest));
    const review = validateSemanticReview(SemanticReviewSchema.parse(row.payload), rule, snapshot);
    if (review.id !== id || row.id !== id || review.ruleDigest !== row.rule_digest || review.snapshotDigest !== row.snapshot_digest || digestOf(review) !== row.payload_digest) {
      fail('INTEGRITY_FAILURE', 'Stored semantic review identity or content digest mismatch');
    }
    // resources.count(row.payload) above already charges every embedded context
    // against downstream revision/comparison input budgets before validation.
    await this.checkSemanticReviewRepositoryContexts(tx, review);
    const index = (await tx.query<ReviewFindingRow>('SELECT * FROM qe_semantic_review_findings WHERE review_id=$1 ORDER BY id', [id])).rows;
    if (index.length !== review.findings.length) fail('INTEGRITY_FAILURE', 'Semantic review finding index is incomplete');
    const members = new Map(review.findings.map(finding => [finding.id, finding]));
    for (const indexed of index) this.checkReviewFindingRow(indexed, members.get(indexed.id));
    return review;
  }
  private checkReviewFindingRow(row: ReviewFindingRow, finding: ReviewFinding | undefined): asserts finding is ReviewFinding {
    if (!finding || row.id !== finding.id || row.review_id !== finding.reviewId || row.rule_digest !== finding.ruleDigest || row.snapshot_digest !== finding.snapshotDigest
      || row.rule_id !== finding.ruleId || row.rule_version !== finding.ruleVersion || row.payload_digest !== digestOf(finding) || digestOf(row.payload) !== digestOf(finding)) {
      fail('INTEGRITY_FAILURE', 'Indexed review finding is not the exact parent review member');
    }
  }
  async getSemanticReview(id: string): Promise<SemanticReview> { return this.readSemanticReview(this.db, id); }
  async listSemanticReviews(input: { ruleDigest?: string; snapshotDigest?: string; after?: string; limit?: number } = {}): Promise<SemanticReview[]> {
    const options = z.object({ ruleDigest: DigestSchema.optional(), snapshotDigest: DigestSchema.optional(), after: SemanticReviewSchema.shape.id.optional(), limit: z.number().int().min(1).max(100).default(20) }).strict().parse(input);
    const rows = (await this.db.query<{ id: string }>('SELECT id FROM qe_semantic_reviews WHERE ($1::text IS NULL OR rule_digest=$1) AND ($2::text IS NULL OR snapshot_digest=$2) AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4',
      [options.ruleDigest ?? null, options.snapshotDigest ?? null, options.after ?? null, options.limit])).rows;
    const reviews: SemanticReview[] = [];
    for (const row of rows) reviews.push(await this.readSemanticReview(this.db, row.id));
    return reviews;
  }
  private async readReviewFinding(tx: Queryable, id: string): Promise<ReviewFinding> {
    LocalReviewFeedbackSchema.shape.findingId.parse(id);
    const row = await one<ReviewFindingRow>(tx, 'SELECT * FROM qe_semantic_review_findings WHERE id=$1', [id]);
    if (!row) fail('NOT_FOUND', `Unknown review finding ${id}`);
    const review = await this.readSemanticReview(tx, row.review_id);
    const finding = review.findings.find(value => value.id === id);
    this.checkReviewFindingRow(row, finding);
    return finding;
  }
  private checkReviewFeedbackRow(row: ReviewFeedbackRow, finding: ReviewFinding): LocalReviewFeedback {
    const feedback = LocalReviewFeedbackSchema.parse(row.payload);
    if (feedback.id !== row.id || feedback.findingId !== row.finding_id || feedback.reviewId !== row.review_id || feedback.ruleDigest !== row.rule_digest
      || feedback.ruleVersion !== row.rule_version || digestOf(feedback) !== row.payload_digest || feedback.findingId !== finding.id
      || feedback.reviewId !== finding.reviewId || feedback.ruleDigest !== finding.ruleDigest || feedback.ruleVersion !== finding.ruleVersion) {
      fail('INTEGRITY_FAILURE', 'Stored review feedback identity or binding mismatch');
    }
    return feedback;
  }
  private async readReviewFeedback(tx: Queryable, id: string): Promise<LocalReviewFeedback> {
    IdSchema.parse(id);
    const row = await one<ReviewFeedbackRow>(tx, 'SELECT * FROM qe_semantic_review_feedback WHERE id=$1', [id]);
    if (!row) fail('NOT_FOUND', `Unknown review feedback ${id}`);
    return this.checkReviewFeedbackRow(row, await this.readReviewFinding(tx, row.finding_id));
  }
  async getReviewFinding(id: string): Promise<ReviewFindingRecord> {
    return this.db.transaction(async tx => {
      const finding = await this.readReviewFinding(tx, id);
      const rows = (await tx.query<ReviewFeedbackRow>('SELECT * FROM qe_semantic_review_feedback WHERE finding_id=$1 ORDER BY id', [id])).rows;
      const feedback = rows.map(row => this.checkReviewFeedbackRow(row, finding));
      return { finding, feedback, verdict: deriveLocalReviewVerdict(feedback), identityVerification: 'caller-declared-unverified' };
    });
  }
  async appendReviewFeedback(input: LocalReviewFeedback): Promise<LocalReviewFeedback> {
    const feedback = LocalReviewFeedbackSchema.parse(input);
    return this.db.transaction(async tx => {
      const finding = await this.readReviewFinding(tx, feedback.findingId);
      if (feedback.reviewId !== finding.reviewId || feedback.ruleDigest !== finding.ruleDigest || feedback.ruleVersion !== finding.ruleVersion) {
        fail('VERSION_MISMATCH', 'Review feedback must bind to the exact finding, review and rule version');
      }
      await tx.query('INSERT INTO qe_semantic_review_feedback(id,finding_id,review_id,rule_digest,rule_version,payload_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING',
        [feedback.id, feedback.findingId, feedback.reviewId, feedback.ruleDigest, feedback.ruleVersion, digestOf(feedback), JSON.stringify(feedback)]);
      const stored = await this.readReviewFeedback(tx, feedback.id);
      if (digestOf(stored) !== digestOf(feedback)) fail('IMMUTABLE_CONFLICT', `Review feedback ${feedback.id} cannot be changed`);
      return stored;
    });
  }
  async createRevisionRequest(input: RevisionRequestInput): Promise<StoredRevisionRequest> {
    const options = RevisionRequestInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const rule = await this.readSemanticRuleVersion(tx, options.baseRuleDigest);
      if (options.requestedRuleVersion === rule.rule.version) fail('INVALID_REVISION_REQUEST', 'Requested version must differ from the pinned base version');
      const feedbackBindings = [];
      for (const id of options.feedbackIds) {
        const feedback = await this.readReviewFeedback(tx, id);
        if (feedback.ruleDigest !== options.baseRuleDigest) fail('VERSION_MISMATCH', 'Selected revision feedback must bind to the exact base rule digest');
        feedbackBindings.push({ id, digest: digestOf(feedback) });
      }
      const request = RevisionRequestSchema.parse({ ...options, schemaVersion: 1, kind: 'rule-revision-request', status: 'pending', feedbackBindings, synthesis: 'not_run' });
      const digest = digestOf(request);
      await tx.query('INSERT INTO qe_rule_revision_requests(digest,id,base_rule_digest,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',
        [digest, request.id, request.baseRuleDigest, JSON.stringify(request)]);
      const existing = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_rule_revision_requests WHERE id=$1', [request.id]);
      if (existing?.digest !== digest) fail('IMMUTABLE_CONFLICT', `Revision request ${request.id} cannot be changed`);
      return this.readRevisionRequest(tx, digest);
    });
  }
  private async readRevisionRequest(tx: Queryable, digest: string, resources?: {
    count(value: unknown): void; rule(digest: string): Promise<StoredRuleVersion>; feedback(id: string): Promise<LocalReviewFeedback>;
  }): Promise<StoredRevisionRequest> {
    DigestSchema.parse(digest);
    const row = await one<RevisionRequestRow>(tx, 'SELECT * FROM qe_rule_revision_requests WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown revision request ${digest}`);
    resources?.count(row.payload);
    const request = RevisionRequestSchema.parse(row.payload);
    if (row.digest !== digest || digestOf(request) !== digest || request.id !== row.id || request.baseRuleDigest !== row.base_rule_digest) {
      fail('INTEGRITY_FAILURE', 'Stored revision request identity or digest mismatch');
    }
    const rule = await (resources ? resources.rule(request.baseRuleDigest) : this.readSemanticRuleVersion(tx, request.baseRuleDigest));
    if (request.requestedRuleVersion === rule.rule.version || request.feedbackIds.length !== request.feedbackBindings.length) fail('INTEGRITY_FAILURE', 'Invalid frozen revision request');
    for (let i = 0; i < request.feedbackIds.length; i++) {
      const id = request.feedbackIds[i]!, binding = request.feedbackBindings[i]!;
      const feedback = await (resources ? resources.feedback(id) : this.readReviewFeedback(tx, id));
      if (binding.id !== id || binding.digest !== digestOf(feedback) || feedback.ruleDigest !== request.baseRuleDigest) fail('INTEGRITY_FAILURE', 'Frozen revision feedback selection mismatch');
    }
    return { digest, request };
  }
  async getRevisionRequest(digest: string): Promise<StoredRevisionRequest> { return this.readRevisionRequest(this.db, digest); }
  async listRevisionRequests(baseRuleDigest?: string): Promise<StoredRevisionRequest[]> {
    if (baseRuleDigest !== undefined) DigestSchema.parse(baseRuleDigest);
    // Like rule listing, this is a local, bounded catalog. Refuse rather than truncate.
    const rows = (await this.db.query<{ digest: string }>('SELECT digest FROM qe_rule_revision_requests WHERE ($1::text IS NULL OR base_rule_digest=$1) ORDER BY digest LIMIT 101', [baseRuleDigest ?? null])).rows;
    if (rows.length > 100) fail('LIST_LIMIT', 'More than 100 revision requests; filter by exact base rule digest');
    const records: StoredRevisionRequest[] = [];
    for (const row of rows) records.push(await this.readRevisionRequest(this.db, row.digest));
    return records;
  }

  /** Resolve only the frozen request's selected feedback, exact reviews/snapshots,
   * and existing base source/regression cases. Never load future feedback or evals. */
  private async readRevisionGenerationEvidence(tx: Queryable, digest: string): Promise<RevisionGenerationEvidence> {
    const count = revisionInputBudget(), rules = new Map<string, StoredRuleVersion>();
    const snapshots = new Map<string, StoredChangeSnapshot>(), reviews = new Map<string, SemanticReview>();
    const feedback = new Map<string, ComparisonFeedback>();
    const rule = async (digest: string) => {
      let result = rules.get(digest);
      if (!result) { result = await this.readSemanticRuleVersion(tx, digest); count(result.rule); rules.set(digest, result); }
      return result;
    };
    const snapshot = async (digest: string) => {
      let result = snapshots.get(digest);
      if (!result) {
        if (snapshots.size >= REVISION_GENERATION_LIMITS.snapshots) fail('REVISION_LIMIT', 'Too many selected revision snapshots');
        result = await this.readChangeSnapshot(tx, digest); count(result.snapshot);
        snapshots.set(digest, result);
      }
      return result;
    };
    const readFeedback = async (id: string) => {
      let result = feedback.get(id);
      if (!result) {
        const row = await one<ReviewFeedbackRow>(tx, 'SELECT * FROM qe_semantic_review_feedback WHERE id=$1', [id]);
        if (!row) fail('NOT_FOUND', `Unknown revision feedback ${id}`);
        count(row.payload);
        let review = reviews.get(row.review_id);
        if (!review) { review = await this.readSemanticReview(tx, row.review_id, { count, rule, snapshot }); reviews.set(review.id, review); }
        const finding = review.findings.find(value => value.id === row.finding_id);
        if (!finding) fail('INTEGRITY_FAILURE', 'Selected revision finding is absent from its review');
        result = { feedback: this.checkReviewFeedbackRow(row, finding), finding, review }; feedback.set(id, result);
      }
      return result.feedback;
    };
    const request = await this.readRevisionRequest(tx, digest, { count, rule, feedback: readFeedback });
    const baseRule = await rule(request.request.baseRuleDigest);
    if (baseRule.rule.schemaVersion !== 2) fail('UNSUPPORTED_RULE_SCHEMA', 'Revision generation requires semantic rule v2');
    const ids = [...new Set([...baseRule.rule.provenance.sourceCases.map(item => item.caseId), ...baseRule.rule.regressionCases.map(item => item.caseId)])].sort();
    if (ids.length > REVISION_GENERATION_LIMITS.cases) fail('REVISION_LIMIT', 'Revision exceeds 200 source/regression cases');
    const cases: ProblemCase[] = [];
    for (const id of ids) { const value = await this.readCase(tx, id); count(value); cases.push(value); }
    const graph = validateRevisionGenerationEvidence({ request, baseRule, cases, feedback: request.request.feedbackIds.map(id => feedback.get(id)!), snapshots: [...snapshots.values()] });
    // Check exactly the content identities exposed to generation, not unrelated
    // files/uncited sides in the same integrity-validated snapshot package.
    if (await one(tx, "SELECT digest FROM qe_source_splits WHERE digest=ANY($1::text[]) AND split='holdout' LIMIT 1", [revisionConsumedSourceDigests(graph)])) {
      fail('HOLDOUT_CONTAMINATION', 'Revision generation cannot consume registered heldout sources');
    }
    return graph;
  }
  async getRevisionGenerationEvidence(requestDigest: string): Promise<RevisionGenerationEvidence> {
    return this.db.transaction(tx => this.readRevisionGenerationEvidence(tx, requestDigest));
  }
  /** Reserve consumed content before exposing it to a generation runtime. Unique
   * source-split insertion serializes with concurrent case/holdout registration.
   * Failed/aborted attempts keep this conservative usage reservation. */
  private async reserveRevisionSources(tx: Queryable, graph: RevisionGenerationEvidence): Promise<void> {
    for (const digest of revisionConsumedSourceDigests(graph)) {
      await tx.query("INSERT INTO qe_source_splits(digest,split) VALUES($1,'training') ON CONFLICT DO NOTHING", [digest]);
      const source = await one<{ split: string }>(tx, 'SELECT split FROM qe_source_splits WHERE digest=$1', [digest]);
      if (!source || source.split === 'holdout') fail('HOLDOUT_CONTAMINATION', 'Generation-consumed source content cannot be heldout');
    }
  }
  async prepareRevisionGeneration(requestDigest: string): Promise<RevisionGenerationEvidence> {
    return this.db.transaction(async tx => {
      const graph = await this.readRevisionGenerationEvidence(tx, requestDigest);
      await this.reserveRevisionSources(tx, graph);
      return graph;
    });
  }
  async saveRevisionModelCandidate(capability: TrustedRevisionCandidate): Promise<StoredRevisionCandidate> {
    const input = readTrustedRevisionCandidate(capability);
    return this.db.transaction(async tx => {
      const graph = await this.readRevisionGenerationEvidence(tx, input.requestDigest);
      const candidate = validateExecutedRevisionCandidate(input, graph), digest = digestOf(candidate);
      await this.reserveRevisionSources(tx, graph);
      revisionRecordBudget(candidate);
      await this.insertRuleVersion(tx, input.rule);
      await tx.query('INSERT INTO qe_revision_candidates(digest,id,request_digest,rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
        [digest, candidate.id, candidate.requestDigest, candidate.ruleDigest, JSON.stringify(candidate)]);
      const existing = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_revision_candidates WHERE id=$1', [candidate.id]);
      if (existing?.digest !== digest) fail('IMMUTABLE_CONFLICT', 'Revision candidate ID already has different content');
      return this.readRevisionCandidate(tx, digest);
    });
  }
  private async readRevisionCandidate(tx: Queryable, digest: string): Promise<StoredRevisionCandidate> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; id: string; request_digest: string; rule_digest: string; payload: unknown }>(tx, 'SELECT * FROM qe_revision_candidates WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown revision candidate ${digest}`);
    revisionRecordBudget(row.payload);
    const candidate = RevisionCandidateSchema.parse(row.payload);
    if (row.digest !== digest || digestOf(candidate) !== digest || candidate.id !== row.id || candidate.requestDigest !== row.request_digest || candidate.ruleDigest !== row.rule_digest) fail('INTEGRITY_FAILURE', 'Stored revision candidate identity mismatch');
    const graph = await this.readRevisionGenerationEvidence(tx, candidate.requestDigest), rule = await this.readSemanticRuleVersion(tx, candidate.ruleDigest);
    if (rule.rule.schemaVersion !== 2) fail('UNSUPPORTED_RULE_SCHEMA', 'Revision candidate requires semantic rule v2');
    const expected = validateExecutedRevisionCandidate({ id: candidate.id, requestDigest: candidate.requestDigest, rule: rule.rule, executionReceipt: candidate.executionReceipt }, graph);
    if (digestOf(expected) !== digest) fail('INTEGRITY_FAILURE', 'Stored revision candidate differs from rederived execution');
    return { digest, candidate };
  }
  async getRevisionCandidate(digest: string): Promise<StoredRevisionCandidate> {
    return this.db.transaction(tx => this.readRevisionCandidate(tx, digest));
  }
  async listRevisionCandidates(input?: string | RevisionCandidatePage): Promise<StoredRevisionCandidate[]> {
    // Preserve the legacy bounded all-record API. Object options opt into cursor pages.
    const paged = typeof input === 'object' && input !== null;
    const options = RevisionCandidatePageSchema.parse(paged ? input : { requestDigest: input, limit: 100 });
    return this.db.transaction(async tx => {
      const rows = (await tx.query<{ digest: string }>(`SELECT digest FROM qe_revision_candidates
        WHERE ($1::text IS NULL OR request_digest=$1) AND ($2::text IS NULL OR id=$2)
        AND ($3::text IS NULL OR rule_digest=$3) AND ($4::text IS NULL OR digest>$4)
        ORDER BY digest LIMIT $5`, [options.requestDigest ?? null, options.id ?? null, options.ruleDigest ?? null,
        options.after ?? null, paged ? options.limit : 101])).rows;
      if (!paged && rows.length > 100) fail('LIST_LIMIT', 'More than 100 revision candidates; use cursor page options');
      const result: StoredRevisionCandidate[] = []; let bytes = 0;
      for (const row of rows) { const value = await this.readRevisionCandidate(tx, row.digest); bytes += Buffer.byteLength(JSON.stringify(value));
        if (bytes > REVISION_GENERATION_LIMITS.listBytes) fail('LIST_LIMIT', 'Revision candidate page exceeds 16MB; use a smaller limit'); result.push(value); }
      return result;
    });
  }

  /** Keep completed diagnoses and execution evidence without creating a rule
   * version when the selected revision operator does not mutate the rule. */
  async saveRevisionModelOutcome(capability: TrustedRevisionNoMutation): Promise<StoredRevisionNoMutationOutcome> {
    const input = readTrustedRevisionNoMutation(capability);
    return this.db.transaction(async tx => {
      const graph = await this.readRevisionGenerationEvidence(tx, input.requestDigest);
      const outcome = validateExecutedRevisionNoMutation(input, graph), digest = digestOf(outcome);
      await this.reserveRevisionSources(tx, graph);
      revisionRecordBudget(outcome);
      await tx.query('INSERT INTO qe_revision_outcomes(digest,id,request_digest,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',
        [digest, outcome.id, outcome.requestDigest, JSON.stringify(outcome)]);
      const existing = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_revision_outcomes WHERE id=$1', [outcome.id]);
      if (existing?.digest !== digest) fail('IMMUTABLE_CONFLICT', 'Revision outcome ID already has different content');
      return this.readRevisionOutcome(tx, digest);
    });
  }
  private async readRevisionOutcome(tx: Queryable, digest: string): Promise<StoredRevisionNoMutationOutcome> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; id: string; request_digest: string; payload: unknown }>(tx, 'SELECT * FROM qe_revision_outcomes WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown revision outcome ${digest}`);
    revisionRecordBudget(row.payload);
    const outcome = RevisionNoMutationOutcomeSchema.parse(row.payload);
    if (row.digest !== digest || digestOf(outcome) !== digest || outcome.id !== row.id || outcome.requestDigest !== row.request_digest) fail('INTEGRITY_FAILURE', 'Stored revision outcome identity mismatch');
    const graph = await this.readRevisionGenerationEvidence(tx, outcome.requestDigest);
    const expected = validateExecutedRevisionNoMutation({ id: outcome.id, requestDigest: outcome.requestDigest,
      candidateCreatedAt: outcome.candidateCreatedAt, executionReceipt: outcome.executionReceipt }, graph);
    if (digestOf(expected) !== digest) fail('INTEGRITY_FAILURE', 'Stored revision outcome differs from rederived execution');
    return { digest, outcome };
  }
  async getRevisionOutcome(digest: string): Promise<StoredRevisionNoMutationOutcome> {
    return this.db.transaction(tx => this.readRevisionOutcome(tx, digest));
  }
  async listRevisionOutcomes(input?: string | RevisionCatalogPage): Promise<StoredRevisionNoMutationOutcome[]> {
    const paged = typeof input === 'object' && input !== null;
    const options = RevisionCatalogPageSchema.parse(paged ? input : { requestDigest: input, limit: 100 });
    return this.db.transaction(async tx => {
      const rows = (await tx.query<{ digest: string }>(`SELECT digest FROM qe_revision_outcomes
        WHERE ($1::text IS NULL OR request_digest=$1) AND ($2::text IS NULL OR id=$2)
        AND ($3::text IS NULL OR digest>$3) ORDER BY digest LIMIT $4`,
        [options.requestDigest ?? null, options.id ?? null, options.after ?? null, paged ? options.limit : 101])).rows;
      if (!paged && rows.length > 100) fail('LIST_LIMIT', 'More than 100 revision outcomes; use cursor page options');
      const result: StoredRevisionNoMutationOutcome[] = []; let bytes = 0;
      for (const row of rows) { const value = await this.readRevisionOutcome(tx, row.digest); bytes += Buffer.byteLength(JSON.stringify(value));
        if (bytes > REVISION_GENERATION_LIMITS.listBytes) fail('LIST_LIMIT', 'Revision outcome page exceeds 16MB; use a smaller limit'); result.push(value); }
      return result;
    });
  }

  /** Resolves the bounded immutable input graph once, then derives rather than accepting a caller report. */
  private async deriveComparison(tx: Queryable, input: RevisionComparisonInput, scorer?: RevisionComparisonScorer) {
    const options = RevisionComparisonInputSchema.parse(input);
    const count = comparisonInputBudget();
    count(options);
    const rules = new Map<string, StoredRuleVersion>(), snapshots = new Map<string, StoredChangeSnapshot>();
    const reviews = new Map<string, SemanticReview>(), feedback = new Map<string, ComparisonFeedback>();
    const rule = async (digest: string) => {
      let result = rules.get(digest);
      if (!result) { result = await this.readSemanticRuleVersion(tx, digest); count(result.rule); rules.set(digest, result); }
      return result;
    };
    const snapshot = async (digest: string) => {
      let result = snapshots.get(digest);
      if (!result) {
        result = await this.readChangeSnapshot(tx, digest); count(result.snapshot);
        const sourceDigests = [...new Set(result.snapshot.changes.flatMap(change => [change.before, change.after]
          .flatMap(side => side.state === 'absent' || side.sha256 === null ? [] : [side.sha256])))];
        const heldout = await one(tx, "SELECT digest FROM qe_source_splits WHERE digest=ANY($1::text[]) AND split='holdout' LIMIT 1", [sourceDigests]);
        if (heldout) fail('HOLDOUT_CONTAMINATION', 'A revision comparison cannot consume snapshot bytes registered as heldout sources');
        snapshots.set(digest, result);
      }
      return result;
    };
    const review = async (id: string) => {
      let result = reviews.get(id);
      if (!result) {
        result = await this.readSemanticReview(tx, id, { count, rule, snapshot });
        const sourceDigests = [...new Set((result.repositoryContexts ?? []).flatMap(value => value.context.entries
          .flatMap(entry => entry.state === 'missing' || entry.sha256 === null ? [] : [entry.sha256])))];
        if (sourceDigests.length && await one(tx, "SELECT digest FROM qe_source_splits WHERE digest=ANY($1::text[]) AND split='holdout' LIMIT 1", [sourceDigests])) {
          fail('HOLDOUT_CONTAMINATION', 'A revision comparison cannot consume repository context bytes registered as heldout sources');
        }
        reviews.set(id, result);
      }
      return result;
    };
    const readFeedback = async (id: string) => {
      let result = feedback.get(id);
      if (!result) {
        const row = await one<ReviewFeedbackRow>(tx, 'SELECT * FROM qe_semantic_review_feedback WHERE id=$1', [id]);
        if (!row) fail('NOT_FOUND', `Unknown review feedback ${id}`);
        count(row.payload);
        const parent = await review(row.review_id), finding = parent.findings.find(value => value.id === row.finding_id);
        if (!finding) fail('INTEGRITY_FAILURE', 'Selected feedback finding is absent from its parent review');
        result = { feedback: this.checkReviewFeedbackRow(row, finding), finding, review: parent };
        feedback.set(id, result);
      }
      return result.feedback;
    };
    const request = await this.readRevisionRequest(tx, options.requestDigest, { count, rule, feedback: readFeedback });
    const baseRule = await rule(request.request.baseRuleDigest), candidateRule = await rule(options.candidateRuleDigest);
    // Fail cheap identity errors before loading all pairs/cases, with the same guards used by derivation.
    if (baseRule.rule.schemaVersion !== 2 || candidateRule.rule.schemaVersion !== 2
      || candidateRule.rule.ruleId !== baseRule.rule.ruleId || candidateRule.rule.provenance.parentDigest !== baseRule.digest
      || candidateRule.rule.version !== request.request.requestedRuleVersion) fail('INVALID_REVISION_CANDIDATE', 'Candidate must match the requested logical rule, direct parent and version');
    const caseIds = [...new Set([baseRule.rule, candidateRule.rule].flatMap(value => [...value.regressionCases.map(item => item.caseId), ...value.provenance.sourceCases.map(item => item.caseId)]))];
    if (caseIds.length > COMPARISON_LIMITS.cases) fail('COMPARISON_LIMIT', 'More than 200 combined source/regression cases');
    const cases: ProblemCase[] = [];
    for (const id of caseIds) { const value = await this.readCase(tx, id); count(value); cases.push(value); }
    const pairs: ComparisonPair[] = [];
    for (const selected of options.reviewPairs) {
      const base = await review(selected.baseReviewId), candidate = await review(selected.candidateReviewId);
      pairs.push({ base, candidate, snapshot: await snapshot(base.snapshotDigest) });
    }
    return deriveRevisionComparison(options, { request, baseRule, candidateRule, cases, pairs,
      feedback: request.request.feedbackIds.map(id => feedback.get(id)!) }, scorer);
  }
  async createRevisionComparison(input: RevisionComparisonInput, trustedAdjudications: readonly TrustedComparisonApplicability[] = []): Promise<StoredRevisionComparison> {
    const options = RevisionComparisonInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const previous = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_rule_revision_comparisons WHERE id=$1', [options.id]);
      if (previous) {
        const stored = await this.readRevisionComparison(tx, previous.digest);
        if (digestOf(stored.comparison.input) !== digestOf(options)) fail('IMMUTABLE_CONFLICT', `Revision comparison ${options.id} cannot be changed`);
        return stored;
      }
      // Validated immutable retries need no new runtime authority; a new insert does.
      const receipts = options.applicability?.adjudications.filter(value => value.kind === 'comparison-applicability-workspace-execution') ?? [];
      const trusted = trustedAdjudications.map(value => digestOf(readTrustedComparisonApplicability(value)));
      if (receipts.length !== trusted.length || new Set(trusted).size !== trusted.length || receipts.some(value => !trusted.includes(digestOf(value)))) {
        fail('UNTRUSTED_APPLICABILITY_EXECUTION', 'Workspace applicability requires matching process-local runtime capabilities, not imported receipt JSON');
      }
      const comparison = await this.deriveComparison(tx, options), digest = digestOf(comparison);
      await tx.query('INSERT INTO qe_rule_revision_comparisons(digest,id,request_digest,candidate_rule_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
        [digest, comparison.input.id, comparison.input.requestDigest, comparison.input.candidateRuleDigest, JSON.stringify(comparison)]);
      const existing = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_rule_revision_comparisons WHERE id=$1', [comparison.input.id]);
      if (existing?.digest !== digest) fail('IMMUTABLE_CONFLICT', `Revision comparison ${comparison.input.id} cannot be changed`);
      return this.readRevisionComparison(tx, digest);
    });
  }
  private async readRevisionComparison(tx: Queryable, digest: string): Promise<StoredRevisionComparison> {
    DigestSchema.parse(digest);
    const row = await one<RevisionComparisonRow>(tx, 'SELECT * FROM qe_rule_revision_comparisons WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown revision comparison ${digest}`);
    if (Buffer.byteLength(JSON.stringify(row.payload)) > COMPARISON_LIMITS.resultBytes) fail('COMPARISON_LIMIT', 'Stored comparison exceeds bounded result bytes');
    const comparison = RevisionComparisonSchema.parse(row.payload);
    if (row.digest !== digest || digestOf(comparison) !== digest || comparison.input.id !== row.id
      || comparison.input.requestDigest !== row.request_digest || comparison.input.candidateRuleDigest !== row.candidate_rule_digest) fail('INTEGRITY_FAILURE', 'Stored comparison identity or content digest mismatch');
    const derived = await this.deriveComparison(tx, comparison.input, comparison.scorer ?? 'legacy-detector-v1');
    if (digestOf(derived) !== digest) fail('INTEGRITY_FAILURE', 'Comparison report or frozen bindings differ from revalidated inputs');
    return { digest, comparison };
  }
  async getRevisionComparison(digest: string): Promise<StoredRevisionComparison> {
    return this.db.transaction(tx => this.readRevisionComparison(tx, digest));
  }
  async listRevisionComparisons(input?: string | RevisionComparisonPage): Promise<StoredRevisionComparison[]> {
    const paged = typeof input === 'object' && input !== null;
    const options = RevisionComparisonPageSchema.parse(paged ? input : { requestDigest: input, limit: 100 });
    return this.db.transaction(async tx => {
      const rows = (await tx.query<{ digest: string }>(`SELECT digest FROM qe_rule_revision_comparisons
        WHERE ($1::text IS NULL OR request_digest=$1) AND ($2::text IS NULL OR candidate_rule_digest=$2)
        AND ($3::text IS NULL OR digest>$3) ORDER BY digest LIMIT $4`,
        [options.requestDigest ?? null, options.candidateRuleDigest ?? null, options.after ?? null, paged ? options.limit : 101])).rows;
      if (!paged && rows.length > 100) fail('LIST_LIMIT', 'More than 100 comparisons; use cursor page options');
      const results: StoredRevisionComparison[] = []; let bytes = 0;
      for (const row of rows) {
        const value = await this.readRevisionComparison(tx, row.digest); bytes += Buffer.byteLength(JSON.stringify(value));
        if (bytes > COMPARISON_LIMITS.inputBytes) fail('LIST_LIMIT', 'Comparison page exceeds 16MB; use a smaller limit');
        results.push(value);
      }
      return results;
    });
  }
  async recordRevisionDecision(input: RevisionDecisionInput): Promise<StoredRevisionDecision> {
    const options = RevisionDecisionInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const { comparison } = await this.readRevisionComparison(tx, options.comparisonDigest);
      if (options.choice === 'accept' && comparison.summary.status !== 'compatible') fail('REVISION_ACCEPT_BLOCKED', 'Local acceptance requires fully scored compatible comparison evidence; reject or defer instead');
      const decision = RevisionDecisionSchema.parse({ ...options, schemaVersion: 1, kind: 'local-rule-revision-decision',
        requestDigest: comparison.input.requestDigest, candidateRuleDigest: comparison.input.candidateRuleDigest,
        comparisonStatus: comparison.summary.status, identityVerification: 'caller-declared-unverified', activation: 'not_performed', certification: 'none' });
      const digest = digestOf(decision);
      const previous = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_rule_revision_decisions WHERE id=$1', [decision.id]);
      if (previous) {
        if (previous.digest !== digest) fail('IMMUTABLE_CONFLICT', `Local revision decision ${decision.id} cannot be changed`);
        return this.readRevisionDecision(tx, digest);
      }
      if (options.choice === 'accept' && comparison.scorer !== 'per-anchor-semantic-v3' && comparison.scorer !== 'per-anchor-context-v4' && comparison.scorer !== 'scope-applicability-v5') fail('REVISION_ACCEPT_BLOCKED', 'New acceptance requires a current-scoring comparison under a new comparison ID; historical decisions remain readable');
      await tx.query('INSERT INTO qe_rule_revision_decisions(digest,id,comparison_digest,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',
        [digest, decision.id, decision.comparisonDigest, JSON.stringify(decision)]);
      const existing = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_rule_revision_decisions WHERE id=$1', [decision.id]);
      if (existing?.digest !== digest) fail('IMMUTABLE_CONFLICT', `Local revision decision ${decision.id} cannot be changed`);
      return this.readRevisionDecision(tx, digest);
    });
  }
  private async readRevisionDecision(tx: Queryable, digest: string): Promise<StoredRevisionDecision> {
    DigestSchema.parse(digest);
    const row = await one<RevisionDecisionRow>(tx, 'SELECT * FROM qe_rule_revision_decisions WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', `Unknown local revision decision ${digest}`);
    const decision = RevisionDecisionSchema.parse(row.payload);
    if (row.digest !== digest || digestOf(decision) !== digest || decision.id !== row.id || decision.comparisonDigest !== row.comparison_digest) fail('INTEGRITY_FAILURE', 'Stored decision identity or content digest mismatch');
    const { comparison } = await this.readRevisionComparison(tx, decision.comparisonDigest);
    if (decision.requestDigest !== comparison.input.requestDigest || decision.candidateRuleDigest !== comparison.input.candidateRuleDigest
      || decision.comparisonStatus !== comparison.summary.status || (decision.choice === 'accept' && comparison.summary.status !== 'compatible')) fail('INTEGRITY_FAILURE', 'Stored local decision is not bound to its exact admissible comparison');
    return { digest, decision };
  }
  async getRevisionDecision(digest: string): Promise<StoredRevisionDecision> {
    return this.db.transaction(tx => this.readRevisionDecision(tx, digest));
  }
  async listRevisionDecisions(comparisonDigest?: string): Promise<StoredRevisionDecision[]> {
    if (comparisonDigest !== undefined) DigestSchema.parse(comparisonDigest);
    return this.db.transaction(async tx => {
      const rows = (await tx.query<{ digest: string }>('SELECT digest FROM qe_rule_revision_decisions WHERE ($1::text IS NULL OR comparison_digest=$1) ORDER BY digest LIMIT 101', [comparisonDigest ?? null])).rows;
      if (rows.length > 100) fail('LIST_LIMIT', 'More than 100 local decisions; filter by comparison digest');
      const results: StoredRevisionDecision[] = [];
      for (const row of rows) results.push(await this.readRevisionDecision(tx, row.digest));
      return results;
    });
  }

  private semanticGovernanceStore() {
    return new SemanticGovernanceStore(this.db, {
      rule: (tx, digest) => this.readRuleVersion(tx, digest),
      decision: (tx, digest) => this.readRevisionDecision(tx, digest),
      comparison: (tx, digest) => this.readRevisionComparison(tx, digest),
    });
  }
  /** Explicit opt-in local review governance. Never updates the v1 active registry. */
  async applySemanticGovernance(input: SemanticGovernanceCommand) { return this.semanticGovernanceStore().apply(input); }
  async getSemanticGovernance(ruleId: string) { return this.semanticGovernanceStore().get(ruleId); }
  async getSemanticGovernanceHistory(ruleId: string) { return this.semanticGovernanceStore().history(ruleId); }
  /** Read-only scope selection: callers must separately request any review execution. */
  async selectLocalSemanticRules(input: LocalSemanticSelectionInput) { return this.semanticGovernanceStore().select(input); }

  private async validateGovernedReviewInput(tx: Queryable, input: GovernedReviewPlan['input']) {
    const snapshot = await this.readChangeSnapshot(tx, input.snapshotDigest);
    if (snapshot.snapshot.repository.id !== input.repository) fail('GOVERNANCE_SNAPSHOT_MISMATCH', 'Plan repository must exactly match the frozen snapshot');
    const paths = new Set(snapshot.snapshot.changes.flatMap(change => [change.before, change.after]).flatMap(side => side.state === 'absent' ? [] : [side.path]));
    if (input.paths.some(path => !paths.has(path))) fail('GOVERNANCE_SNAPSHOT_MISMATCH', 'Selection paths must be literal changed paths in the frozen snapshot');
    if (input.repositoryContextDigests !== undefined) {
      const contexts = await Promise.all(input.repositoryContextDigests.map(digest => this.readRepositoryContext(tx, digest)));
      validateReviewRepositoryContexts(contexts, snapshot);
    }
  }
  /** Freezes all registry heads and exclusions atomically. Same input ID retries recover the original plan. */
  async createGovernedReviewPlan(raw: GovernedReviewPlanInput): Promise<StoredGovernedReviewPlan> {
    this.checkApplicationJobScope();
    const input = normalizeGovernedReviewInput(raw), inputDigest = digestOf(input);
    return this.db.transaction(async tx => {
      const previous = await one<{ digest: string; input_digest: string }>(tx, 'SELECT digest,input_digest FROM qe_governed_review_plans WHERE id=$1', [input.id]);
      if (previous) {
        if (previous.input_digest !== inputDigest) fail('IMMUTABLE_CONFLICT', 'Governed review plan ID already has different input');
        return this.readGovernedReviewPlan(tx, previous.digest);
      }
      await this.validateGovernedReviewInput(tx, input);
      const selection = await this.semanticGovernanceStore().selectInTransaction(tx, { repository: input.repository, paths: input.paths });
      const plan = deriveGovernedReviewPlan(input, selection), digest = digestOf(plan);
      await tx.query('INSERT INTO qe_governed_review_plans(digest,id,input_digest,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',
        [digest, input.id, inputDigest, JSON.stringify(plan)]);
      const row = await one<{ digest: string; input_digest: string }>(tx, 'SELECT digest,input_digest FROM qe_governed_review_plans WHERE id=$1', [input.id]);
      if (!row || row.input_digest !== inputDigest) fail('IMMUTABLE_CONFLICT', 'Governed review plan ID already has different input');
      return this.readGovernedReviewPlan(tx, row.digest);
    });
  }
  private async readGovernedReviewPlan(tx: Queryable, digest: string): Promise<StoredGovernedReviewPlan> {
    DigestSchema.parse(digest);
    const row = await one<{ digest: string; id: string; input_digest: string; payload: unknown }>(tx, 'SELECT * FROM qe_governed_review_plans WHERE digest=$1', [digest]);
    if (!row) fail('NOT_FOUND', 'Unknown governed review plan');
    if (Buffer.byteLength(JSON.stringify(row.payload)) > GOVERNED_REVIEW_LIMITS.bytes) fail('INTEGRITY_FAILURE', 'Stored governed plan exceeds bounded read size');
    const parsed = GovernedReviewPlanSchema.safeParse(row.payload);
    if (!parsed.success) fail('INTEGRITY_FAILURE', 'Stored governed review plan is invalid');
    const plan = parsed.data;
    if (row.digest !== digest || row.id !== plan.input.id || row.input_digest !== digestOf(plan.input)
      || digestOf(plan) !== digest || digestOf(deriveGovernedReviewPlan(plan.input, plan.selection)) !== digest)
      fail('INTEGRITY_FAILURE', 'Stored governed review plan identity mismatch');
    await this.validateGovernedReviewInput(tx, plan.input);
    const historical = await this.semanticGovernanceStore().historicalSelection(tx,
      { repository: plan.input.repository, paths: plan.input.paths }, plan.governanceHeads);
    if (digestOf(historical) !== plan.selectionDigest) fail('INTEGRITY_FAILURE', 'Frozen selection differs from its exact historical governance heads');
    return { digest, plan };
  }
  async getGovernedReviewPlan(digest: string): Promise<StoredGovernedReviewPlan> {
    return this.db.transaction(tx => this.readGovernedReviewPlan(tx, digest));
  }
  private async currentGovernedReviewPlan(tx: Queryable, stored: StoredGovernedReviewPlan): Promise<boolean> {
    const { input, selectionDigest } = stored.plan;
    const selection = await this.semanticGovernanceStore().selectInTransaction(tx, { repository: input.repository, paths: input.paths });
    return digestOf(selection) === selectionDigest;
  }
  async isGovernedReviewPlanCurrent(digest: string): Promise<boolean> {
    return this.db.transaction(async tx => this.currentGovernedReviewPlan(tx, await this.readGovernedReviewPlan(tx, digest)));
  }
  async requireCurrentGovernedReviewPlan(digest: string): Promise<StoredGovernedReviewPlan> {
    return this.db.transaction(async tx => {
      const stored = await this.readGovernedReviewPlan(tx, digest);
      if (!await this.currentGovernedReviewPlan(tx, stored)) fail('STALE_GOVERNANCE_PLAN', 'Registry heads changed; create a new explicit plan ID before new execution');
      return stored;
    });
  }
  private async validateGovernedReviewJob(tx: Queryable, job: ApplicationJob): Promise<StoredGovernedReviewPlan> {
    if (job.kind !== 'semantic-review' || !job.governancePlanDigest) fail('GOVERNANCE_PLAN_MISMATCH', 'A governed semantic review job requires an exact stored plan');
    const stored = await this.readGovernedReviewPlan(tx, job.governancePlanDigest);
    if (!governedReviewJobs(stored).some(expected => applicationJobDigest(expected) === applicationJobDigest(job)))
      fail('GOVERNANCE_PLAN_MISMATCH', 'Job is not an exact member of the frozen governed review plan');
    return stored;
  }
  async requireCurrentGovernedReviewJob(raw: ApplicationJob): Promise<StoredGovernedReviewPlan> {
    const job = ApplicationJobSchema.parse(raw);
    return this.db.transaction(async tx => {
      const stored = await this.validateGovernedReviewJob(tx, job);
      if (!await this.currentGovernedReviewPlan(tx, stored)) fail('STALE_GOVERNANCE_PLAN', 'Registry heads changed before workspace resolution');
      return stored;
    });
  }
  /** Admission is the linearization point. No lock or transaction spans model work.
   * A later transition cannot revoke already admitted work. Every retry checks again. */
  async admitGovernedReviewJob(raw: ApplicationJob, rawOwner: string): Promise<GovernedReviewAdmission> {
    this.checkApplicationJobScope();
    const job = ApplicationJobSchema.parse(raw), owner = ApplicationJobOwnerSchema.parse(rawOwner), jobDigest = applicationJobDigest(job);
    return this.db.transaction(async tx => {
      // Same job -> registry lock order as completion validation; no opposite lock order.
      const current = await this.readApplicationJob(tx, jobDigest, true);
      if (!current) fail('NOT_FOUND', 'Governed review must hold a claim before admission');
      this.checkApplicationJobOwner(current, owner);
      this.checkApplicationJobPayload(job, current.row);
      const stored = await this.validateGovernedReviewJob(tx, job);
      const previous = await this.readGovernedReviewAdmission(tx, job, current.record.attempts);
      if (previous) return previous; // The same live claim has already crossed admission.
      if (!await this.currentGovernedReviewPlan(tx, stored)) fail('STALE_GOVERNANCE_PLAN', 'Registry heads changed before this execution attempt was admitted');
      const admission = GovernedReviewAdmissionSchema.parse({ schemaVersion: 1, kind: 'local-governed-review-admission',
        jobDigest, planDigest: stored.digest, selectionDigest: stored.plan.selectionDigest, attempt: current.record.attempts,
        semantics: 'head-check-committed-before-execution-not-continuous-authorization' });
      await tx.query('INSERT INTO qe_governed_review_admissions(job_digest,attempt,plan_digest,payload_digest,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
        [jobDigest, admission.attempt, stored.digest, digestOf(admission), JSON.stringify(admission)]);
      this.checkApplicationJobOwner((await this.readApplicationJob(tx, jobDigest))!, owner);
      return admission;
    });
  }
  private async readGovernedReviewAdmission(tx: Queryable, job: ApplicationJob, attempt: number): Promise<GovernedReviewAdmission | null> {
    z.number().int().positive().parse(attempt);
    const jobDigest = applicationJobDigest(job);
    const row = await one<{ job_digest: string; attempt: number; plan_digest: string; payload_digest: string; payload: unknown }>(tx,
      'SELECT * FROM qe_governed_review_admissions WHERE job_digest=$1 AND attempt=$2', [jobDigest, attempt]);
    if (!row) return null;
    const parsed = GovernedReviewAdmissionSchema.safeParse(row.payload);
    if (!parsed.success) fail('INTEGRITY_FAILURE', 'Stored governance admission is invalid');
    const admission = parsed.data;
    if (job.kind !== 'semantic-review' || job.governancePlanDigest !== row.plan_digest || admission.planDigest !== row.plan_digest
      || row.job_digest !== jobDigest || admission.jobDigest !== jobDigest || row.attempt !== attempt || admission.attempt !== attempt
      || row.payload_digest !== digestOf(admission)) fail('INTEGRITY_FAILURE', 'Governance admission identity mismatch');
    const stored = await this.validateGovernedReviewJob(tx, job);
    if (stored.plan.selectionDigest !== admission.selectionDigest) fail('INTEGRITY_FAILURE', 'Governance admission selection mismatch');
    return admission;
  }
  async getGovernedReviewAdmission(job: ApplicationJob, attempt: number): Promise<GovernedReviewAdmission | null> {
    const parsed = ApplicationJobSchema.parse(job);
    return this.db.transaction(tx => this.readGovernedReviewAdmission(tx, parsed, attempt));
  }

  async importProblemCase(input: ProblemCase): Promise<ProblemCase> {
    const value = ProblemCaseSchema.parse(input);
    return this.db.transaction(tx => this.importCase(tx, value));
  }
  private async importCase(tx: Queryable, value: ProblemCase): Promise<ProblemCase> {
    const hash = digestOf(value);
    const existing = await one<{ payload_digest: string; payload: ProblemCase }>(tx, 'SELECT payload_digest,payload FROM qe_problem_cases WHERE id=$1', [value.id]);
    if (existing) {
      if (existing.payload_digest !== hash) fail('IMMUTABLE_CONFLICT', `Problem case ${value.id} already has different content`);
      return this.readCase(tx, value.id);
    }
    if (value.provenance.derivedFromCaseId) {
      const parent = await this.readCase(tx, value.provenance.derivedFromCaseId);
      if (parent.lineageId !== value.lineageId || parent.split !== value.split) fail('SPLIT_LEAKAGE', 'Derived cases must preserve parent lineage and data split');
    }
    await tx.query('INSERT INTO qe_case_lineages(id,split) VALUES($1,$2) ON CONFLICT DO NOTHING', [value.lineageId, value.split]);
    const lineage = await one<{ split: string }>(tx, 'SELECT split FROM qe_case_lineages WHERE id=$1', [value.lineageId]);
    if (lineage?.split !== value.split) fail('SPLIT_LEAKAGE', 'One case lineage cannot span training and evaluation splits');
    await tx.query('INSERT INTO qe_source_splits(digest,split) VALUES($1,$2) ON CONFLICT DO NOTHING', [value.sourceDigest, value.split]);
    const source = await one<{ split: string }>(tx, 'SELECT split FROM qe_source_splits WHERE digest=$1', [value.sourceDigest]);
    if (source?.split !== value.split) fail('SPLIT_LEAKAGE', 'Identical source content cannot span data splits');
    await tx.query('INSERT INTO qe_problem_cases(id,lineage_id,source_digest,split,payload_digest,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING', [value.id, value.lineageId, value.sourceDigest, value.split, hash, JSON.stringify(value)]);
    const persisted = await this.readCase(tx, value.id);
    if (digestOf(persisted) !== hash) fail('IMMUTABLE_CONFLICT', `Problem case ${value.id} already has different content`);
    return persisted;
  }
  async getProblemCase(id: string): Promise<ProblemCase> { return this.readCase(this.db, id); }
  private async readCase(tx: Queryable, id: string): Promise<ProblemCase> {
    IdSchema.parse(id);
    const row = await one<{ id: string; lineage_id: string; source_digest: string; split: string; payload_digest: string; payload: unknown }>(tx, 'SELECT * FROM qe_problem_cases WHERE id=$1', [id]);
    if (!row) fail('NOT_FOUND', `Unknown problem case ${id}`);
    const value = ProblemCaseSchema.parse(row.payload);
    if (value.id !== id || row.id !== id || value.lineageId !== row.lineage_id || value.sourceDigest !== row.source_digest
      || value.split !== row.split || digestOf(value) !== row.payload_digest) fail('INTEGRITY_FAILURE', 'Stored ProblemCase identity or content digest mismatch');
    return value;
  }

  /** Imports supplied cases and the rule in one transaction, including all provenance checks. */
  async importRuleVersion(input: RuleVersion, casesInput: ProblemCase[] = []): Promise<StoredRuleVersion> {
    const rule = RuleVersionSchema.parse(input);
    const cases = z.array(ProblemCaseSchema).max(1000).parse(casesInput);
    return this.db.transaction(tx => this.insertRuleVersion(tx, rule, cases));
  }
  private async insertRuleVersion(tx: Queryable, rule: RuleVersion, cases: ProblemCase[] = []): Promise<StoredRuleVersion> {
    const digest = ruleVersionDigest(rule);
    await tx.query('LOCK TABLE qe_rule_bundles IN SHARE ROW EXCLUSIVE MODE');
    for (const problemCase of cases) await this.importCase(tx, problemCase);
    const previous = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_rule_bundles WHERE rule_id=$1 AND version=$2', [rule.ruleId, rule.version]);
    if (previous) {
      if (previous.digest !== digest) fail('IMMUTABLE_CONFLICT', 'The same logical rule version cannot have different content or schema');
      return this.readRuleVersion(tx, digest);
    }
    if (rule.provenance.parentDigest) {
      const parent = await this.readRuleVersion(tx, rule.provenance.parentDigest);
      if (parent.rule.ruleId !== rule.ruleId) fail('INVALID_LINEAGE', 'A new version must descend from the same logical rule');
      if (rule.schemaVersion < parent.rule.schemaVersion) fail('INVALID_LINEAGE', 'A semantic rule version cannot be downgraded to RuleBundle v1');
    } else {
      const sibling = await one(tx, 'SELECT digest FROM qe_rule_bundles WHERE rule_id=$1 LIMIT 1', [rule.ruleId]);
      if (sibling) fail('INVALID_LINEAGE', 'Changed versions must retain a parent rule digest');
    }
    const sourceIds = rule.schemaVersion === 1 ? rule.provenance.sourceCaseIds : rule.provenance.sourceCases.map(source => source.caseId);
    for (const id of new Set([...sourceIds, ...rule.regressionCases.map(value => value.caseId)])) {
      const problemCase = await this.readCase(tx, id);
      if (problemCase.split === 'holdout') fail('HOLDOUT_CONTAMINATION', 'Heldout cases cannot be used to author or regress a rule');
    }
    if (rule.schemaVersion === 2) {
      for (const source of rule.provenance.sourceCases) {
        const problemCase = await this.readCase(tx, source.caseId);
        if (source.repository !== problemCase.repository || source.commit !== problemCase.commit
          || source.path !== problemCase.path || source.sourceDigest !== problemCase.sourceDigest) {
          fail('SOURCE_MISMATCH', 'Source provenance must match the exact stored case repository, full commit, path and source digest');
        }
      }
    }
    await tx.query('INSERT INTO qe_rule_bundles(digest,rule_id,version,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING', [digest, rule.ruleId, rule.version, JSON.stringify(rule)]);
    const stored = await one<{ digest: string }>(tx, 'SELECT digest FROM qe_rule_bundles WHERE rule_id=$1 AND version=$2', [rule.ruleId, rule.version]);
    if (stored?.digest !== digest) fail('IMMUTABLE_CONFLICT', 'The same logical rule version cannot have different content');
    return this.readRuleVersion(tx, digest);
  }
  async getRuleVersion(digest: string): Promise<StoredRuleVersion> { return this.readRuleVersion(this.db, digest); }
  async listRuleVersions(ruleId?: string): Promise<StoredRuleVersion[]> {
    if (ruleId !== undefined) IdSchema.parse(ruleId);
    const result = await this.db.query<RuleVersionRow>(
      'SELECT digest,rule_id,version,payload FROM qe_rule_bundles' + (ruleId === undefined ? '' : ' WHERE rule_id=$1') + ' ORDER BY rule_id,version,digest',
      ruleId === undefined ? [] : [ruleId],
    );
    return result.rows.map(row => this.decodeRuleVersion(row));
  }
  private decodeRuleVersion(row: RuleVersionRow): StoredRuleVersion {
    const rule = RuleVersionSchema.parse(row.payload);
    if (ruleVersionDigest(rule) !== row.digest || rule.ruleId !== row.rule_id || rule.version !== row.version) {
      fail('CORRUPT_RULE_VERSION', 'Stored rule content does not match its immutable identity');
    }
    return { digest: row.digest, rule };
  }
  private async readRuleVersion(tx: Queryable, digest: string): Promise<StoredRuleVersion> {
    DigestSchema.parse(digest);
    const row = await one<RuleVersionRow>(tx, 'SELECT digest,rule_id,version,payload FROM qe_rule_bundles WHERE digest=$1', [digest]);
    return row ? this.decodeRuleVersion(row) : fail('NOT_FOUND', `Unknown rule version ${digest}`);
  }
  /** Legacy API and runtime are deliberately v1-only. This never synthesizes a detector for v2. */
  async importBundle(input: RuleBundle): Promise<StoredRuleBundle> {
    const stored = await this.importRuleVersion(RuleBundleSchema.parse(input));
    return { digest: stored.digest, bundle: RuleBundleSchema.parse(stored.rule) };
  }
  async getBundle(digest: string): Promise<StoredRuleBundle> { return this.readBundle(this.db, digest); }
  private async readBundle(tx: Queryable, digest: string): Promise<StoredRuleBundle> {
    const stored = await this.readRuleVersion(tx, digest);
    if (stored.rule.schemaVersion !== 1) fail('UNSUPPORTED_RULE_SCHEMA', 'This execution/evaluation/promotion path requires RuleBundle v1; semantic v2 execution is not implemented');
    return { digest, bundle: stored.rule };
  }

  async createRun(input: RunIdentity): Promise<StoredRun> {
    const identity = RunIdentitySchema.parse(input);
    const id = 'run_' + digestOf(identity);
    return this.db.transaction(async tx => {
      await this.readBundle(tx, identity.bundleDigest);
      await tx.query('INSERT INTO qe_runs(id,run_key,bundle_digest,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING', [id, identity.key, identity.bundleDigest, JSON.stringify(identity)]);
      const stored = await one<{ id: string; payload: RunIdentity }>(tx, 'SELECT id,payload FROM qe_runs WHERE run_key=$1', [identity.key]);
      if (!stored || stored.id !== id) fail('IDEMPOTENCY_CONFLICT', 'Run key was already bound to a different commit, bundle, repository or configuration');
      return { id: stored.id, identity: stored.payload };
    });
  }
  async getRun(id: string): Promise<StoredRun> { return this.readRun(this.db, id); }
  private async readRun(tx: Queryable, id: string): Promise<StoredRun> {
    const row = await one<{ payload: RunIdentity }>(tx, 'SELECT payload FROM qe_runs WHERE id=$1', [id]);
    if (!row) fail('NOT_FOUND', `Unknown run ${id}`);
    await this.readBundle(tx, row.payload.bundleDigest);
    return { id, identity: row.payload };
  }

  async appendFinding(input: Finding): Promise<Finding> {
    const finding = FindingSchema.parse(input);
    return this.db.transaction(async tx => {
      const run = await this.readRun(tx, finding.runId);
      const { bundle } = await this.readBundle(tx, finding.bundleDigest);
      if (run.identity.bundleDigest !== finding.bundleDigest || bundle.ruleId !== finding.ruleId || bundle.version !== finding.ruleVersion) fail('VERSION_MISMATCH', 'Finding does not match the exact run and rule version');
      await tx.query('INSERT INTO qe_findings(id,run_id,bundle_digest,rule_id,rule_version,payload_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING', [finding.id, finding.runId, finding.bundleDigest, finding.ruleId, finding.ruleVersion, digestOf(finding), JSON.stringify(finding)]);
      const stored = await this.readFinding(tx, finding.id);
      if (digestOf(stored) !== digestOf(finding)) fail('IMMUTABLE_CONFLICT', `Finding ${finding.id} cannot be changed`);
      return stored;
    });
  }
  private async readFinding(tx: Queryable, id: string): Promise<Finding> {
    const row = await one<{ payload: Finding }>(tx, 'SELECT payload FROM qe_findings WHERE id=$1', [id]);
    if (!row) fail('NOT_FOUND', `Unknown finding ${id}`);
    await this.readBundle(tx, row.payload.bundleDigest);
    return row.payload;
  }
  private async readFeedback(tx: Queryable, findingId: string): Promise<Feedback[]> {
    return (await tx.query<{ payload: Feedback }>('SELECT payload FROM qe_feedback WHERE finding_id=$1 ORDER BY id', [findingId])).rows.map(row => row.payload);
  }
  async getFinding(id: string): Promise<FindingRecord> {
    return this.db.transaction(async tx => {
      const finding = await this.readFinding(tx, id);
      const feedback = await this.readFeedback(tx, id);
      return { finding, feedback, verdict: deriveVerdict(feedback) };
    });
  }
  async listFindings(runId: string): Promise<Finding[]> {
    await this.readRun(this.db, runId);
    return (await this.db.query<{ payload: Finding }>('SELECT payload FROM qe_findings WHERE run_id=$1 ORDER BY id', [runId])).rows.map(row => row.payload);
  }
  async appendFeedback(input: Feedback): Promise<Feedback> {
    const feedback = FeedbackSchema.parse(input);
    return this.db.transaction(async tx => {
      const finding = await this.readFinding(tx, feedback.findingId);
      if (finding.bundleDigest !== feedback.bundleDigest || finding.ruleVersion !== feedback.ruleVersion) fail('VERSION_MISMATCH', 'Feedback must bind to the exact finding and rule version');
      await tx.query('INSERT INTO qe_feedback(id,finding_id,bundle_digest,rule_version,payload_digest,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING', [feedback.id, feedback.findingId, feedback.bundleDigest, feedback.ruleVersion, digestOf(feedback), JSON.stringify(feedback)]);
      const stored = await one<{ payload: Feedback }>(tx, 'SELECT payload FROM qe_feedback WHERE id=$1', [feedback.id]);
      if (!stored || digestOf(stored.payload) !== digestOf(feedback)) fail('IMMUTABLE_CONFLICT', `Feedback ${feedback.id} cannot be changed`);
      return stored.payload;
    });
  }

  async createEvaluation(manifestInput: EvaluationManifest, resultsInput: EvaluationResult[]): Promise<StoredEvaluation> {
    const manifest = EvaluationManifestSchema.parse(manifestInput);
    const results = resultsInput.map(value => EvaluationResultSchema.parse(value));
    const value = { manifest, results: [...results].sort((a, b) => a.caseId.localeCompare(b.caseId)) };
    return this.db.transaction(async tx => {
      await this.readBundle(tx, manifest.bundleDigest);
      await this.loadEvidence(tx, value);
      await tx.query('INSERT INTO qe_evaluations(id,bundle_digest,payload_digest,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING', [manifest.id, manifest.bundleDigest, digestOf(value), JSON.stringify(value)]);
      const stored = await this.readEvaluation(tx, manifest.id);
      if (digestOf(stored) !== digestOf(value)) fail('IMMUTABLE_CONFLICT', 'Frozen evaluation manifest/results cannot change');
      return stored;
    });
  }
  async getEvaluation(id: string): Promise<StoredEvaluation> { return this.readEvaluation(this.db, id); }
  private async readEvaluation(tx: Queryable, id: string): Promise<StoredEvaluation> {
    const row = await one<{ payload: StoredEvaluation }>(tx, 'SELECT payload FROM qe_evaluations WHERE id=$1', [id]);
    if (!row) fail('NOT_FOUND', `Unknown evaluation ${id}`);
    await this.readBundle(tx, row.payload.manifest.bundleDigest);
    return row.payload;
  }
  /** Durable provenance independent of job-runtime completion retention. Bytes remain in the configured artifact store. */
  async recordArtifactLink(input: ArtifactLink): Promise<ArtifactLink> {
    const value = ArtifactLinkSchema.parse(input);
    return this.db.transaction(async tx => {
      await this.readEvaluation(tx, value.evaluationId);
      await tx.query(
        'INSERT INTO qe_artifact_links(evaluation_id,kind,digest,object_key,size_bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [value.evaluationId, value.kind, value.ref.digest, value.ref.key, value.ref.size],
      );
      const stored = (await this.readArtifactLinks(tx, value.evaluationId)).find(link => link.kind === value.kind);
      if (!stored || digestOf(stored) !== digestOf(value)) fail('IMMUTABLE_CONFLICT', 'An evaluation artifact kind is already bound to a different immutable reference');
      return stored;
    });
  }
  async getArtifactLinks(evaluationId: string): Promise<ArtifactLink[]> {
    IdSchema.parse(evaluationId);
    return this.db.transaction(async tx => {
      await this.readEvaluation(tx, evaluationId);
      return this.readArtifactLinks(tx, evaluationId);
    });
  }
  private async readArtifactLinks(tx: Queryable, evaluationId: string): Promise<ArtifactLink[]> {
    const result = await tx.query<{ kind: 'input' | 'result'; digest: string; object_key: string; size_bytes: string }>(
      'SELECT kind,digest,object_key,size_bytes::text AS size_bytes FROM qe_artifact_links WHERE evaluation_id=$1 ORDER BY kind', [evaluationId],
    );
    return result.rows.map(row => ({ evaluationId, kind: row.kind, ref: { digest: row.digest, key: row.object_key, size: Number(row.size_bytes) } }));
  }
  private async loadEvidence(tx: Queryable, evaluation: StoredEvaluation): Promise<EvaluationEvidence[]> {
    const { manifest, results } = evaluation;
    await this.readBundle(tx, manifest.bundleDigest);
    if (results.length !== manifest.caseIds.length || new Set(results.map(value => value.caseId)).size !== results.length || results.some(value => !manifest.caseIds.includes(value.caseId))) fail('INCOMPLETE_EVALUATION', 'Every frozen manifest case must have exactly one result, including misses and errors');
    const evidence: EvaluationEvidence[] = [];
    for (const result of results) {
      const problemCase = await this.readCase(tx, result.caseId);
      const finding = await this.readFinding(tx, result.findingId);
      const run = await this.readRun(tx, result.runId);
      if (finding.runId !== result.runId || finding.bundleDigest !== manifest.bundleDigest || run.identity.bundleDigest !== manifest.bundleDigest || run.identity.configDigest !== manifest.configDigest) fail('VERSION_MISMATCH', 'Evaluation result is bound to a different run, bundle or configuration');
      if (run.identity.repository !== problemCase.repository || run.identity.commit !== problemCase.commit || finding.location.path !== problemCase.path || finding.sourceDigest !== problemCase.sourceDigest) fail('CASE_MISMATCH', 'Evaluation result must match exact case repository, commit, path and source digest');
      evidence.push({ problemCase, finding, feedback: await this.readFeedback(tx, finding.id) });
    }
    return evidence;
  }
  async evaluate(id: string, policy: PromotionProposal['policy']): Promise<EvaluationReport> {
    return this.db.transaction(async tx => evaluateEvidence(await this.loadEvidence(tx, await this.readEvaluation(tx, id)), policy));
  }
  async getActive(ruleId: string): Promise<string | null> { return this.readActive(this.db, ruleId); }
  private async readActive(tx: Queryable, ruleId: string): Promise<string | null> {
    const digest = (await one<{ bundle_digest: string }>(tx, 'SELECT bundle_digest FROM qe_active_rules WHERE rule_id=$1', [ruleId]))?.bundle_digest ?? null;
    if (digest) await this.readBundle(tx, digest);
    return digest;
  }
  async proposePromotion(input: PromotionProposal): Promise<StoredProposal> {
    const proposal = PromotionProposalSchema.parse(input);
    return this.db.transaction(async tx => {
      const bundle = await this.readBundle(tx, proposal.bundleDigest);
      if (bundle.bundle.ruleId !== proposal.ruleId) fail('VERSION_MISMATCH', 'Promotion rule does not match bundle');
      if (await this.readActive(tx, proposal.ruleId) !== proposal.expectedActiveDigest) fail('STALE_APPROVAL', 'Active bundle changed; create a proposal against the current version');
      const evaluation = await this.readEvaluation(tx, proposal.evaluationId);
      if (evaluation.manifest.bundleDigest !== proposal.bundleDigest) fail('VERSION_MISMATCH', 'Evaluation certifies a different rule version');
      await tx.query('LOCK TABLE qe_feedback IN SHARE MODE');
      const report = evaluateEvidence(await this.loadEvidence(tx, evaluation), proposal.policy);
      if (!report.eligible) fail('PROMOTION_BLOCKED', report.reasons.join('; '));
      const value = { proposal, report };
      await tx.query('INSERT INTO qe_proposals(id,rule_id,bundle_digest,evaluation_id,payload_digest,evidence_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING', [proposal.id, proposal.ruleId, proposal.bundleDigest, proposal.evaluationId, digestOf(value), report.evidenceDigest, JSON.stringify(value)]);
      const stored = await this.readProposal(tx, proposal.id);
      if (digestOf(stored) !== digestOf(value)) fail('IMMUTABLE_CONFLICT', 'Promotion proposal is immutable');
      return stored;
    });
  }
  async getProposal(id: string): Promise<StoredProposal> { return this.readProposal(this.db, id); }
  private async readProposal(tx: Queryable, id: string): Promise<StoredProposal> {
    const row = await one<{ payload: StoredProposal }>(tx, 'SELECT payload FROM qe_proposals WHERE id=$1', [id]);
    if (!row) fail('NOT_FOUND', `Unknown promotion proposal ${id}`);
    await this.readBundle(tx, row.payload.proposal.bundleDigest);
    return row.payload;
  }
  async approvePromotion(input: { proposalId: string; expectedActiveDigest: string | null; actor: string }): Promise<Promotion> {
    if (!input.actor.trim()) fail('INVALID_ACTOR', 'Approval requires an explicit reviewer identity');
    return this.db.transaction(async tx => {
      const { proposal, report } = await this.readProposal(tx, input.proposalId);
      if (input.expectedActiveDigest !== proposal.expectedActiveDigest) fail('STALE_APPROVAL', 'Approval does not bind to the proposal expected active version');
      const existing = await one<{ actor: string; bundle_digest: string; previous_digest: string | null }>(tx, 'SELECT actor,bundle_digest,previous_digest FROM qe_promotions WHERE proposal_id=$1', [input.proposalId]);
      if (existing) {
        if (existing.actor !== input.actor) fail('IMMUTABLE_CONFLICT', 'This approval is already bound to another actor');
        return { proposalId: input.proposalId, actor: existing.actor, bundleDigest: existing.bundle_digest, previousDigest: existing.previous_digest };
      }
      // A table lock protects the feedback snapshot against concurrent appends until CAS commits.
      // SHARE blocks ROW EXCLUSIVE inserts but still permits readers; held only for this short transaction.
      await tx.query('LOCK TABLE qe_feedback IN SHARE MODE');
      const current = evaluateEvidence(await this.loadEvidence(tx, await this.readEvaluation(tx, proposal.evaluationId)), proposal.policy);
      if (current.evidenceDigest !== report.evidenceDigest) fail('STALE_EVIDENCE', 'Evidence changed after proposal; review a new proposal');
      if (!current.eligible) fail('PROMOTION_BLOCKED', current.reasons.join('; '));
      let updated: { rows: Record<string, unknown>[] };
      if (proposal.expectedActiveDigest === null) {
        updated = await tx.query('INSERT INTO qe_active_rules(rule_id,bundle_digest) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING rule_id', [proposal.ruleId, proposal.bundleDigest]);
      } else {
        updated = await tx.query('UPDATE qe_active_rules SET bundle_digest=$2 WHERE rule_id=$1 AND bundle_digest=$3 RETURNING rule_id', [proposal.ruleId, proposal.bundleDigest, proposal.expectedActiveDigest]);
      }
      if (updated.rows.length !== 1) fail('STALE_APPROVAL', 'Active version changed before approval; stale promotion rejected');
      await tx.query('INSERT INTO qe_promotions(proposal_id,actor,bundle_digest,previous_digest) VALUES($1,$2,$3,$4)', [proposal.id, input.actor, proposal.bundleDigest, proposal.expectedActiveDigest]);
      return { proposalId: proposal.id, actor: input.actor, bundleDigest: proposal.bundleDigest, previousDigest: proposal.expectedActiveDigest };
    });
  }
}
