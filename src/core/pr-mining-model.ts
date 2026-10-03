import { z } from 'zod';
import { EvaluationWorkspaceBindingSchema } from '../workspace/history-policy.js';
import { IdSchema } from './model.js';
import { RepositoryIdSchema, RepositoryPathSchema } from './semantic-rule.js';
import { CodexWorkspaceRequestSchema } from '../workspace/codex-runner.js';

const Text = z.string().min(1).max(8192).refine(value => !!value.trim(), 'Expected nonblank text');
const TextList = z.array(Text).max(32);
const ScopePath = z.union([z.literal('.'), RepositoryPathSchema]);
/** No provenance, labels, regression roles, identity or certification are model-writable. */
export const RuleProposalSchema = z.object({
  status: z.literal('candidate'),
  semantics: z.object({ title: Text, mechanism: Text, invariant: Text, applicability: TextList.min(1), exceptions: TextList,
    requiredContext: TextList, expectedBehavior: Text }).strict(),
  paths: z.object({ include: z.array(ScopePath).min(1).max(32), exclude: z.array(ScopePath).max(32) }).strict(),
  detectionAssets: z.array(z.object({ id: IdSchema, detector: z.object({ kind: z.literal('ast-grep'),
    language: z.enum(['typescript', 'javascript', 'tsx', 'jsx', 'python']), pattern: Text }).strict() }).strict()).max(4),
  rationale: Text, evidenceRefs: z.array(z.string().min(1).max(300)).min(1).max(160),
}).strict();
export const PrMiningModelResponseSchema = z.object({ result: z.discriminatedUnion('status', [RuleProposalSchema,
  z.object({ status: z.literal('insufficient_evidence'), reasoning: Text, missingEvidence: TextList,
    evidenceRefs: z.array(z.string().min(1).max(300)).max(160) }).strict(),
]) }).strict();

export const PrMiningModelLimitsSchema = z.object({
  maxInputBytes: z.number().int().min(1).max(2_000_000),
  maxOutputBytes: z.number().int().min(1).max(1_000_000),
  timeoutMs: z.number().int().min(1).max(300_000),
}).strict();
export type PrMiningModelLimits = z.infer<typeof PrMiningModelLimitsSchema>;
export const DEFAULT_PR_MINING_MODEL_LIMITS: PrMiningModelLimits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, timeoutMs: 30_000 };
export const PrMiningModelContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selected-evidence') }).strict(),
  z.object({ kind: z.literal('full-repository'), repository: RepositoryIdSchema,
    checkout: z.enum(['before', 'after']), workspace: CodexWorkspaceRequestSchema.shape.workspace,
    evaluation: EvaluationWorkspaceBindingSchema.optional() }).strict(),
]);
export type PrMiningModelContext = z.infer<typeof PrMiningModelContextSchema>;
