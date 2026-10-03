import { z } from 'zod';
import { PrMiningExecutionReceiptSchema } from './pr-mining-execution.js';
import { DigestSchema, IdSchema } from './model.js';
import { RepositoryPathSchema, SourceCaseReferenceSchema, SemanticRuleVersionSchema } from './semantic-rule.js';

const Text = z.string().min(1).max(16_384).refine(value => !!value.trim(), 'Expected nonblank text');
const unique = (values: string[]) => new Set(values).size === values.length;
export const PR_MINING_LIMITS = { sources: 32, statements: 128, jsonBytes: 2_000_000 } as const;
export const MiningSourceSelectionSchema = z.object({ side: z.enum(['before', 'after']), path: RepositoryPathSchema }).strict();
export const MiningStatementSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pull') }).strict(),
  z.object({ kind: z.enum(['issue-comment', 'review', 'review-comment']), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
export const PrMiningRequestInputSchema = z.object({
  id: IdSchema, evidenceDigest: DigestSchema,
  sources: z.array(MiningSourceSelectionSchema).min(1).max(PR_MINING_LIMITS.sources)
    .refine(values => unique(values.map(value => JSON.stringify([value.side, value.path]))), 'Duplicate mining sources'),
  statements: z.array(MiningStatementSelectionSchema).min(1).max(PR_MINING_LIMITS.statements)
    .refine(values => unique(values.map(value => value.kind === 'pull' ? 'pull' : `${value.kind}:${value.id}`)), 'Duplicate mining statements'),
  requestedRule: z.object({ ruleId: SemanticRuleVersionSchema.shape.ruleId, version: SemanticRuleVersionSchema.shape.version, parentDigest: DigestSchema.nullable() }).strict(),
  objective: Text, actor: Text, source: z.enum(['fixture', 'supplied']), createdAt: z.string().datetime({ offset: true }),
}).strict();
export type PrMiningRequestInput = z.infer<typeof PrMiningRequestInputSchema>;
export const PrMiningRequestSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('pr-rule-mining-request'), input: PrMiningRequestInputSchema,
  snapshotDigest: DigestSchema,
  sourceBindings: z.array(SourceCaseReferenceSchema.extend({
    side: z.enum(['before', 'after']), objectId: z.string().regex(/^[a-f0-9]{40}$/),
    mode: z.enum(['100644', '100755']), byteLength: z.number().int().nonnegative().max(262_144), caseDigest: DigestSchema,
  }).strict()).min(1).max(PR_MINING_LIMITS.sources),
  statementBindings: z.array(z.object({ selection: MiningStatementSelectionSchema, digest: DigestSchema }).strict()).min(1).max(PR_MINING_LIMITS.statements),
  status: z.literal('pending'), synthesis: z.literal('not_run'),
  trust: z.object({ evidence: z.literal('package-integrity-only'), observation: z.literal('current-api-state'), historicalReviewCheckpoint: z.literal(false),
    statements: z.literal('untrusted-not-ground-truth-or-feedback'), labels: z.literal('unknown-only'),
    identity: z.literal('caller-declared-unverified'), context: z.literal('selected-changed-sides-only'), certification: z.literal('none') }).strict(),
}).strict();
export type PrMiningRequest = z.infer<typeof PrMiningRequestSchema>;
export type StoredPrMiningRequest = { digest: string; request: PrMiningRequest };
export const PrMiningCandidateInputSchema = z.object({
  id: IdSchema, requestDigest: DigestSchema, source: z.enum(['supplied', 'fixture']), rule: SemanticRuleVersionSchema,
}).strict();
export type PrMiningCandidateInput = z.infer<typeof PrMiningCandidateInputSchema>;
export const SuppliedPrMiningCandidateSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('pr-rule-mining-candidate'), id: IdSchema,
  requestDigest: DigestSchema, evidenceDigest: DigestSchema, snapshotDigest: DigestSchema, ruleDigest: DigestSchema,
  source: z.enum(['supplied', 'fixture']), status: z.literal('candidate'), synthesis: z.literal('not_run'),
  validation: z.literal('schema-and-exact-provenance-only'), semanticValidation: z.literal('not_run'), regressionExecution: z.literal('not_run'),
  activation: z.literal('not_performed'), certification: z.literal('none'),
}).strict();
/** Stored generated records are readable JSON; they are not import authority. */
export const ExecutedPrMiningCandidateSchema = SuppliedPrMiningCandidateSchema.extend({
  schemaVersion: z.literal(2), source: z.enum(['model', 'fixture']),
  synthesis: z.enum(['completed', 'not_run']), executionReceipt: PrMiningExecutionReceiptSchema,
}).strict().superRefine((candidate, ctx) => {
  if (candidate.synthesis !== candidate.executionReceipt.modelExecution
    || candidate.requestDigest !== candidate.executionReceipt.requestDigest
    || (candidate.executionReceipt.modelExecution === 'not_run' && candidate.source !== 'fixture')) {
    ctx.addIssue({ code: 'custom', message: 'Candidate execution provenance mismatch' });
  }
});
export const PrMiningCandidateSchema = z.discriminatedUnion('schemaVersion', [SuppliedPrMiningCandidateSchema, ExecutedPrMiningCandidateSchema]);
export const ExecutedPrMiningCandidateInputSchema = z.object({
  id: IdSchema, requestDigest: DigestSchema, rule: SemanticRuleVersionSchema, executionReceipt: PrMiningExecutionReceiptSchema,
}).strict();
export type ExecutedPrMiningCandidateInput = z.infer<typeof ExecutedPrMiningCandidateInputSchema>;
export type ExecutedPrMiningCandidate = z.infer<typeof ExecutedPrMiningCandidateSchema>;
export type PrMiningCandidate = z.infer<typeof PrMiningCandidateSchema>;
export type StoredPrMiningCandidate = { digest: string; candidate: PrMiningCandidate };
