import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ContextRevisionModelResponseSchema, LegacyRevisionModelResponseSchema, RevisionModelResponseSchema } from '../core/revision-model.js';
import { ComparisonApplicabilityModelResponseSchema } from '../core/comparison-applicability-model.js';
import { MatchedDiagnosisSchema, ProposalSchema, ReviewSchema } from '../core/matched-revision-model.js';
import { PrMiningModelResponseSchema } from '../core/pr-mining-model.js';
import { ContextSemanticReviewModelResponseSchema, PerAnchorSemanticReviewModelResponseSchema, SemanticReviewModelResponseSchema } from '../core/semantic-review-model.js';
import { CodexWorkspaceLimits } from './codex-runner.js';
import { EvaluationWorkspaceBindingSchema, WorkspaceHistoryPolicySchema, validateHistoryBinding } from './history-policy.js';
import { MatchedCodexExecutionSchema } from './matched-codex-policy.js';
import { CodexModelReasoningEffortSchema } from '../core/codex-model-settings.js';

/** Fixed image protocol, not a request-supplied schema or executable selector. */
export const WorkspaceWorkerInput = z.object({
  workingDirectory: z.string().max(4096).refine(isAbsolute),
  model: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/),
  modelReasoningEffort: CodexModelReasoningEffortSchema.optional(),
  prompt: z.string().min(1).max(2_097_152),
  toolPolicy: z.enum(['full-repo-shell-v1', 'selected-evidence-no-tools-v1']),
  historyPolicy: WorkspaceHistoryPolicySchema,
  evaluation: EvaluationWorkspaceBindingSchema.optional(),
  evaluationBranch: z.string().max(100).regex(/^attempt\/[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  outputContract: z.enum(['pr-mining-v1', 'semantic-review-v1', 'semantic-review-v2', 'semantic-review-v3', 'rule-revision-v1', 'rule-revision-v2', 'rule-revision-v3', 'comparison-applicability-v1', 'matched-diagnosis-v1', 'matched-proposal-v1', 'matched-review-v1']).optional(),
  matchedExecution: MatchedCodexExecutionSchema.optional(),
  limits: CodexWorkspaceLimits,
}).strict().superRefine((input, ctx) => {
  try { validateHistoryBinding(input); }
  catch { ctx.addIssue({ code: 'custom', message: 'Evaluation worker policy/binding mismatch' }); }
  if (!!input.evaluation !== !!input.evaluationBranch) ctx.addIssue({ code: 'custom', message: 'Evaluation worker requires its bound attempt branch' });
  const diagnosis = input.outputContract === 'matched-diagnosis-v1';
  const matched = diagnosis || input.outputContract === 'matched-proposal-v1' || input.outputContract === 'matched-review-v1';
  if (matched !== !!input.matchedExecution) ctx.addIssue({ code: 'custom', message: 'Matched contracts require explicit matched execution controls, only on matched requests' });
  if (diagnosis && input.matchedExecution?.kind !== 'authored-sdk-native-no-model') {
    ctx.addIssue({ code: 'custom', message: 'Matched diagnosis requires authored-sdk-native-no-model execution' });
  }
  if (diagnosis && input.toolPolicy !== 'selected-evidence-no-tools-v1') {
    ctx.addIssue({ code: 'custom', message: 'Matched diagnosis requires the fixed selected-evidence/no-tools policy' });
  }
});

export const WorkspaceWorkerAnswer = z.object({
  summary: z.string().max(16_384),
  changedFiles: z.array(z.string().max(4096)).max(200),
  checks: z.array(z.object({ command: z.string().max(4096),
    outcome: z.enum(['passed', 'failed', 'not-run']), detail: z.string().max(4096) }).strict()).max(100),
  limitations: z.array(z.string().max(4096)).max(100),
}).strict();

export const WorkspaceWorkerUsage = z.object({
  input_tokens: z.number().int().nonnegative(), cached_input_tokens: z.number().int().nonnegative(),
  cache_write_input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative(),
}).strict();
export const WorkspaceWorkerProcessEvidence = z.object({ reason: z.string().max(100), exitCode: z.number().int().nullable(),
  // Native authored supervision captures the actual JSONL fields before SDK
  // normalization (the pinned SDK defaults a missing cache-write field to zero).
  reportedUsage: z.object({ input_tokens: z.number().int().nonnegative().safe().nullable(),
    cached_input_tokens: z.number().int().nonnegative().safe().nullable(), cache_write_input_tokens: z.number().int().nonnegative().safe().nullable(),
    output_tokens: z.number().int().nonnegative().safe().nullable(), reasoning_output_tokens: z.number().int().nonnegative().safe().nullable() }).strict().optional(),
  // Explicit setting forwarded to the SDK/CLI, not proof of model acceptance.
  // Older/unspecified receipts omit it; no SDK or service default is inferred.
  modelReasoningEffort: CodexModelReasoningEffortSchema.optional(),
  stdoutBytes: z.number().int().nonnegative(), stderrBytes: z.number().int().nonnegative(),
  forwardedBytes: z.number().int().nonnegative(), processGroupStopped: z.boolean() }).strict();
export const WorkspaceWorkerResult = z.object({
  protocolVersion: z.literal(1), value: WorkspaceWorkerAnswer, usage: WorkspaceWorkerUsage,
  sessionId: z.string().min(1).max(256), processEvidence: WorkspaceWorkerProcessEvidence,
  boundary: z.enum(['isolated-runtime', 'authored-test-no-isolation']),
}).strict();

/** Mining is an explicit versioned contract; the default v1 envelope is unchanged. */
export const PrMiningWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('pr-mining-v1'),
  value: PrMiningModelResponseSchema,
}).strict();
export type PrMiningWorkspaceWorkerResult = z.infer<typeof PrMiningWorkspaceWorkerResult>;

export const LegacySemanticReviewWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('semantic-review-v1'),
  value: SemanticReviewModelResponseSchema,
}).strict();
export type LegacySemanticReviewWorkspaceWorkerResult = z.infer<typeof LegacySemanticReviewWorkspaceWorkerResult>;
export const PerAnchorSemanticReviewWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('semantic-review-v2'),
  value: PerAnchorSemanticReviewModelResponseSchema,
}).strict();
export type PerAnchorSemanticReviewWorkspaceWorkerResult = z.infer<typeof PerAnchorSemanticReviewWorkspaceWorkerResult>;
export const ContextSemanticReviewWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('semantic-review-v3'),
  value: ContextSemanticReviewModelResponseSchema,
}).strict();
export type ContextSemanticReviewWorkspaceWorkerResult = z.infer<typeof ContextSemanticReviewWorkspaceWorkerResult>;
export const SemanticReviewWorkspaceWorkerResult = z.discriminatedUnion('outputContract', [
  LegacySemanticReviewWorkspaceWorkerResult, PerAnchorSemanticReviewWorkspaceWorkerResult, ContextSemanticReviewWorkspaceWorkerResult,
]);
export type SemanticReviewWorkspaceWorkerResult = z.infer<typeof SemanticReviewWorkspaceWorkerResult>;

const LegacyRevisionWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('rule-revision-v1'),
  value: LegacyRevisionModelResponseSchema,
}).strict();
const PolicyRevisionWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('rule-revision-v2'),
  value: RevisionModelResponseSchema,
}).strict();
const ContextRevisionWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('rule-revision-v3'),
  value: ContextRevisionModelResponseSchema,
}).strict();
export const RevisionWorkspaceWorkerResult = z.discriminatedUnion('outputContract', [LegacyRevisionWorkspaceWorkerResult, PolicyRevisionWorkspaceWorkerResult, ContextRevisionWorkspaceWorkerResult]);
export type RevisionWorkspaceWorkerResult = z.infer<typeof RevisionWorkspaceWorkerResult>;

/** Selected exact-finding adjudication, independent of semantic review coverage. */
export const ComparisonApplicabilityWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('comparison-applicability-v1'),
  value: ComparisonApplicabilityModelResponseSchema,
}).strict();
export type ComparisonApplicabilityWorkspaceWorkerResult = z.infer<typeof ComparisonApplicabilityWorkspaceWorkerResult>;

export const MatchedDiagnosisWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('matched-diagnosis-v1'), value: MatchedDiagnosisSchema,
  boundary: z.literal('authored-test-no-isolation'),
}).strict();
export type MatchedDiagnosisWorkspaceWorkerResult = z.infer<typeof MatchedDiagnosisWorkspaceWorkerResult>;
export const MatchedProposalWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('matched-proposal-v1'), value: ProposalSchema,
}).strict();
export const MatchedReviewWorkspaceWorkerResult = WorkspaceWorkerResult.extend({
  protocolVersion: z.literal(2), outputContract: z.literal('matched-review-v1'), value: ReviewSchema,
}).strict();
export const MatchedWorkspaceWorkerResult = z.discriminatedUnion('outputContract', [
  MatchedDiagnosisWorkspaceWorkerResult, MatchedProposalWorkspaceWorkerResult, MatchedReviewWorkspaceWorkerResult,
]);
export type MatchedWorkspaceWorkerResult = z.infer<typeof MatchedWorkspaceWorkerResult>;

export const WorkspaceWorkerGateway = z.object({ kind: z.literal('credential-isolated-gateway'),
  baseUrl: z.string().max(2048).url(), allowedHost: z.string().max(253).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
}).strict().superRefine((gateway, context) => {
  const url = new URL(gateway.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
    || (url.port && url.port !== '443') || url.hostname !== gateway.allowedHost || gateway.allowedHost.includes('..')) {
    context.addIssue({ code: 'custom', message: 'Gateway requires a credential-free HTTPS URL on the exact trusted allowed host' });
  }
});
export type WorkspaceWorkerGateway = z.infer<typeof WorkspaceWorkerGateway>;
export const WorkspaceWorkerImageConfig = z.object({ schemaVersion: z.literal(1),
  gateway: z.union([z.object({ kind: z.literal('blocked') }).strict(), WorkspaceWorkerGateway]),
}).strict();
