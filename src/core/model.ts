import { z } from 'zod';

export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a SHA-256 hex digest');
export const IdSchema = z.string().min(1).max(200);
const DateSchema = z.string().datetime({ offset: true });
export const VerdictSchema = z.enum(['TP', 'FP', 'Unknown', 'Disputed']);
export type Verdict = z.infer<typeof VerdictSchema>;
export const CandidateStateSchema = z.enum([
  'not_recalled', 'not_verified', 'rejected', 'passed', 'abstained', 'execution_error',
]);
export type CandidateState = z.infer<typeof CandidateStateSchema>;

export const DetectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ast-grep'), language: z.string().min(1), pattern: z.string().min(1) }).strict(),
  z.object({ kind: z.enum(['opengrep', 'semgrep']), language: z.string().min(1), yaml: z.string().min(1) }).strict(),
]);
export const RuleBundleSchema = z.object({
  schemaVersion: z.literal(1),
  ruleId: IdSchema,
  version: IdSchema,
  skill: z.object({
    title: z.string().min(1),
    invariant: z.string().min(1),
    applicability: z.array(z.string().min(1)).min(1),
    exceptions: z.array(z.string().min(1)),
    requiredContext: z.array(z.string().min(1)),
  }).strict(),
  detector: DetectorSchema,
  regressionCases: z.array(z.object({
    caseId: IdSchema,
    role: z.enum(['positive', 'negative', 'fixed']),
  }).strict()).min(1),
  provenance: z.object({
    sourceCaseIds: z.array(IdSchema).min(1),
    parentDigest: DigestSchema.nullable(),
    author: z.string().min(1),
    createdAt: DateSchema,
    rationale: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict();
export type RuleBundle = z.infer<typeof RuleBundleSchema>;
export type StoredRuleBundle = { digest: string; bundle: RuleBundle };

export const ProblemCaseSchema = z.object({
  id: IdSchema,
  lineageId: IdSchema,
  split: z.enum(['training', 'validation', 'holdout']),
  expected: z.enum(['violation', 'safe', 'unknown']),
  title: z.string().min(1),
  repository: z.string().min(1),
  commit: z.string().min(7),
  path: z.string().min(1),
  sourceDigest: DigestSchema,
  provenance: z.object({
    kind: z.enum(['human', 'synthetic', 'imported']),
    reference: z.string().min(1),
    reviewedBy: z.string().min(1).nullable(),
    derivedFromCaseId: IdSchema.nullable(),
  }).strict(),
}).strict();
export type ProblemCase = z.infer<typeof ProblemCaseSchema>;

export const RunIdentitySchema = z.object({
  key: IdSchema,
  repository: z.string().min(1),
  commit: z.string().min(7),
  bundleDigest: DigestSchema,
  configDigest: DigestSchema,
}).strict();
export type RunIdentity = z.infer<typeof RunIdentitySchema>;
export type StoredRun = { id: string; identity: RunIdentity };

export const LocationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startColumn: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
}).strict().refine(value => value.endLine >= value.startLine, 'End line precedes start line');
export type Location = z.infer<typeof LocationSchema>;
export const AdjudicationSchema = z.object({
  decision: z.enum(['violation', 'safe', 'unknown']),
  source: z.enum(['fixture', 'agent']),
  reasoning: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
}).strict();
export type Adjudication = z.infer<typeof AdjudicationSchema>;
/** Bounded execution provenance only; never store credentials, raw provider payloads or home paths. */
export const ExecutionMetadataSchema = z.object({
  mode: z.enum(['offline_fixture', 'codex_sdk', 'openai_compatible']),
  origin: z.enum(['fixture_replay', 'model', 'evidence_gate', 'execution_error']),
  model: z.string().min(1).max(200).nullable(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict().optional(),
  sessionId: z.string().min(1).max(200).nullable(),
  costUsd: z.number().nonnegative().nullable(),
}).strict();
export type ExecutionMetadata = z.infer<typeof ExecutionMetadataSchema>;
export const FindingSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  bundleDigest: DigestSchema,
  ruleId: IdSchema,
  ruleVersion: IdSchema,
  location: LocationSchema,
  sourceDigest: DigestSchema,
  candidateState: CandidateStateSchema,
  execution: z.object({ state: z.enum(['succeeded', 'failed', 'not_run']), error: z.string().min(1).nullable() }).strict(),
  adjudication: AdjudicationSchema.nullable(),
  evidenceRefs: z.array(z.string().min(1)),
  executionMetadata: ExecutionMetadataSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.execution.state === 'failed') {
    if (!value.execution.error || value.candidateState !== 'execution_error') fail('Failed execution requires execution_error and an error');
  } else if (value.execution.error !== null || value.candidateState === 'execution_error') fail('Execution errors must be independent, explicit failed execution');
  const expectedDecision = { passed: 'violation', rejected: 'safe', abstained: 'unknown' } as const;
  if (value.candidateState in expectedDecision) {
    if (value.execution.state !== 'succeeded' || value.adjudication?.decision !== expectedDecision[value.candidateState as keyof typeof expectedDecision]) fail('Candidate state does not match completed adjudication');
  } else if (value.adjudication !== null) fail('Unadjudicated candidates cannot contain a decision');
  if (value.candidateState === 'not_verified' && value.execution.state !== 'not_run') fail('not_verified must have not_run semantic execution');
  if (value.candidateState === 'not_recalled' && value.execution.state !== 'succeeded') fail('not_recalled requires a successful detector execution');
});
export type Finding = z.infer<typeof FindingSchema>;

export const FeedbackSchema = z.object({
  id: IdSchema,
  findingId: IdSchema,
  bundleDigest: DigestSchema,
  ruleVersion: IdSchema,
  actor: z.string().min(1),
  source: z.enum(['human', 'agent', 'system']),
  kind: z.enum(['label', 'resolve', 'merge', 'note']),
  label: VerdictSchema.nullable(),
  reason: z.string().min(1),
  createdAt: DateSchema,
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'label' && (value.label === null || value.source !== 'human')) ctx.addIssue({ code: 'custom', message: 'Only explicit human feedback can supply a ground-truth label' });
  if (value.kind !== 'label' && value.label !== null) ctx.addIssue({ code: 'custom', message: 'Resolve, merge and note events cannot supply correctness labels' });
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export const EvaluationManifestSchema = z.object({
  id: IdSchema,
  bundleDigest: DigestSchema,
  datasetVersion: IdSchema,
  caseIds: z.array(IdSchema).min(1),
  configDigest: DigestSchema,
  createdAt: DateSchema,
}).strict().refine(v => new Set(v.caseIds).size === v.caseIds.length, 'Duplicate evaluation cases');
export type EvaluationManifest = z.infer<typeof EvaluationManifestSchema>;
export const EvaluationResultSchema = z.object({
  caseId: IdSchema,
  runId: IdSchema,
  findingId: IdSchema,
}).strict();
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export const PromotionPolicySchema = z.object({
  minKnownCases: z.number().int().positive(),
  minPositiveCases: z.number().int().positive(),
  minNegativeCases: z.number().int().positive(),
  minPrecision: z.number().min(0).max(1),
  minRecall: z.number().min(0).max(1),
  maxAbstentionRate: z.number().min(0).max(1),
  minFeedbackLabels: z.number().int().nonnegative(),
}).strict();
export type PromotionPolicy = z.infer<typeof PromotionPolicySchema>;
export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  minKnownCases: 10, minPositiveCases: 5, minNegativeCases: 5,
  minPrecision: 0.9, minRecall: 0.8, maxAbstentionRate: 0.1, minFeedbackLabels: 0,
};
export const PromotionProposalSchema = z.object({
  id: IdSchema,
  ruleId: IdSchema,
  bundleDigest: DigestSchema,
  evaluationId: IdSchema,
  expectedActiveDigest: DigestSchema.nullable(),
  policy: PromotionPolicySchema,
}).strict();
export type PromotionProposal = z.infer<typeof PromotionProposalSchema>;
