import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  bundleDigest, digestOf, deriveVerdict, evaluateEvidence,
  RuleBundleSchema, ProblemCaseSchema, RunIdentitySchema, FindingSchema, FeedbackSchema, DigestSchema, IdSchema,
  EvaluationManifestSchema, EvaluationResultSchema, PromotionProposalSchema,
  type RuleBundle, type StoredRuleBundle, type ProblemCase, type RunIdentity, type StoredRun,
  type Finding, type Feedback, type Verdict, type EvaluationManifest, type EvaluationResult,
  type EvaluationEvidence, type EvaluationReport, type PromotionProposal,
} from '../core/index.js';
import { openPGliteDatabase, openPostgresDatabase, type Database, type Queryable } from './database.js';

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError'; }
}
function fail(code: string, message: string): never { throw new DomainError(code, message); }
export type FindingRecord = { finding: Finding; feedback: Feedback[]; verdict: Verdict };
export type StoredEvaluation = { manifest: EvaluationManifest; results: EvaluationResult[] };
export type StoredProposal = { proposal: PromotionProposal; report: EvaluationReport };
export type Promotion = { proposalId: string; actor: string; bundleDigest: string; previousDigest: string | null };
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

/** Domain persistence only: no scheduler, provider publication, or model execution. */
export class QualEvoStore {
  private constructor(private readonly db: Database) {}
  static async openPGlite(path?: string): Promise<QualEvoStore> { return QualEvoStore.initialize(await openPGliteDatabase(path)); }
  static async openPostgres(connectionString: string): Promise<QualEvoStore> { return QualEvoStore.initialize(await openPostgresDatabase(connectionString)); }
  static async initialize(db: Database): Promise<QualEvoStore> {
    try {
      for (const migration of ['001_initial.sql', '002_artifact_links.sql']) {
        await db.exec(await readFile(new URL(`./migrations/${migration}`, import.meta.url), 'utf8'));
      }
      return new QualEvoStore(db);
    } catch (error) { await db.close(); throw error; }
  }
  async close(): Promise<void> { await this.db.close(); }

  async importProblemCase(input: ProblemCase): Promise<ProblemCase> {
    const value = ProblemCaseSchema.parse(input);
    const hash = digestOf(value);
    return this.db.transaction(async tx => {
      const existing = await one<{ payload_digest: string; payload: ProblemCase }>(tx, 'SELECT payload_digest,payload FROM qe_problem_cases WHERE id=$1', [value.id]);
      if (existing) {
        if (existing.payload_digest !== hash) fail('IMMUTABLE_CONFLICT', `Problem case ${value.id} already has different content`);
        return existing.payload;
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
    });
  }
  async getProblemCase(id: string): Promise<ProblemCase> { return this.readCase(this.db, id); }
  private async readCase(tx: Queryable, id: string): Promise<ProblemCase> {
    const row = await one<{ payload: ProblemCase }>(tx, 'SELECT payload FROM qe_problem_cases WHERE id=$1', [id]);
    return row?.payload ?? fail('NOT_FOUND', `Unknown problem case ${id}`);
  }

  async importBundle(input: RuleBundle): Promise<StoredRuleBundle> {
    const bundle = RuleBundleSchema.parse(input);
    const digest = bundleDigest(bundle);
    return this.db.transaction(async tx => {
      await tx.query('LOCK TABLE qe_rule_bundles IN SHARE ROW EXCLUSIVE MODE');
      const previous = await one<{ digest: string; payload: RuleBundle }>(tx, 'SELECT digest,payload FROM qe_rule_bundles WHERE rule_id=$1 AND version=$2', [bundle.ruleId, bundle.version]);
      if (previous) {
        if (previous.digest !== digest) fail('IMMUTABLE_CONFLICT', 'The same logical rule version cannot have different content');
        return { digest: previous.digest, bundle: previous.payload };
      }
      if (bundle.provenance.parentDigest) {
        const parent = await this.readBundle(tx, bundle.provenance.parentDigest);
        if (parent.bundle.ruleId !== bundle.ruleId) fail('INVALID_LINEAGE', 'A new bundle must descend from the same logical rule');
      } else {
        const sibling = await one(tx, 'SELECT digest FROM qe_rule_bundles WHERE rule_id=$1 LIMIT 1', [bundle.ruleId]);
        if (sibling) fail('INVALID_LINEAGE', 'Changed versions must retain a parent bundle digest');
      }
      for (const id of new Set([...bundle.provenance.sourceCaseIds, ...bundle.regressionCases.map(value => value.caseId)])) {
        const problemCase = await this.readCase(tx, id);
        if (problemCase.split === 'holdout') fail('HOLDOUT_CONTAMINATION', 'Heldout cases cannot be used to author or regress a rule bundle');
      }
      await tx.query('INSERT INTO qe_rule_bundles(digest,rule_id,version,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING', [digest, bundle.ruleId, bundle.version, JSON.stringify(bundle)]);
      const stored = await one<{ digest: string; payload: RuleBundle }>(tx, 'SELECT digest,payload FROM qe_rule_bundles WHERE rule_id=$1 AND version=$2', [bundle.ruleId, bundle.version]);
      if (stored?.digest !== digest) fail('IMMUTABLE_CONFLICT', 'The same logical rule version cannot have different content');
      return { digest, bundle: stored.payload };
    });
  }
  async getBundle(digest: string): Promise<StoredRuleBundle> { return this.readBundle(this.db, digest); }
  private async readBundle(tx: Queryable, digest: string): Promise<StoredRuleBundle> {
    const row = await one<{ payload: RuleBundle }>(tx, 'SELECT payload FROM qe_rule_bundles WHERE digest=$1', [digest]);
    return row ? { digest, bundle: row.payload } : fail('NOT_FOUND', `Unknown bundle ${digest}`);
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
    return row ? { id, identity: row.payload } : fail('NOT_FOUND', `Unknown run ${id}`);
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
    return row?.payload ?? fail('NOT_FOUND', `Unknown finding ${id}`);
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
    return row?.payload ?? fail('NOT_FOUND', `Unknown evaluation ${id}`);
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
    return (await one<{ bundle_digest: string }>(tx, 'SELECT bundle_digest FROM qe_active_rules WHERE rule_id=$1', [ruleId]))?.bundle_digest ?? null;
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
    return row?.payload ?? fail('NOT_FOUND', `Unknown promotion proposal ${id}`);
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
