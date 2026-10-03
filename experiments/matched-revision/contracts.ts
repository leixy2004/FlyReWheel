import { z } from 'zod';
import { DigestSchema, IdSchema } from '../../src/core/model.js';
import { RevisionPolicyDiagnosisSchema } from '../../src/core/revision-model.js';
import { RepositoryPathSchema } from '../../src/core/semantic-rule.js';
import { CodexModelReasoningEffortSchema } from '../../src/core/codex-model-settings.js';
import type { RevisionModelInput } from '../../src/revision-generation.js';
import { WorkspaceWorkerProcessEvidence, WorkspaceWorkerUsage } from '../../src/workspace/worker-protocol.js';
import type { MATCHED_CODEX_CAPABILITIES } from '../../src/workspace/matched-codex-policy.js';
export type { MatchedModelRequest as ModelRequest } from '../../src/core/matched-revision-model.js';
import type { MatchedModelRequest as ModelRequest } from '../../src/core/matched-revision-model.js';

const Text = z.string().min(1).max(32_768).refine(s => !!s.trim(), 'Expected nonblank text');
const Refs = z.array(z.string().min(1).max(300)).max(300).refine(xs => new Set(xs).size === xs.length, 'Duplicate references');
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ARMS = ['F', 'U', 'H', 'M'] as const;
export type Arm = typeof ARMS[number];
export { RuleContentSchema, StructuredStateSchema, MemoryDeltaSchema, MemoryStateSchema, PersistentStateSchema, ProposalSchema, JudgmentSchema, ReviewSchema } from '../../src/core/matched-revision-model.js';
export type { RuleContent, PersistentState, Proposal, Judgment } from '../../src/core/matched-revision-model.js';
import type { Judgment } from '../../src/core/matched-revision-model.js';
export const SharedDiagnosisSchema = z.object({
  condition: z.enum(['provided', 'inferred']), lockedAt: z.string().datetime({ offset: true }),
  diagnoses: z.array(RevisionPolicyDiagnosisSchema).min(1).max(100),
  originalContextStatus: z.enum(['decisive_evidence_present', 'decisive_evidence_absent', 'unknown']),
  revisionContextStatus: z.enum(['sufficient', 'restored_before_revision', 'still_missing', 'unknown']),
  provenance: z.object({
    origin: z.enum(['authored_fixture', 'independent_human_declared', 'model_inference_declared', 'administrative_failure',
      'authored_sdk_diagnosis_no_model', 'authored_sdk_diagnosis_pending']),
    sourceRecordDigest: DigestSchema, description: Text,
    upstreamModel: Text.nullable(), upstreamCalls: Count,
    inputTokens: Count.nullable(), outputTokens: Count.nullable(), costMicros: Count.nullable(), elapsedMs: Count.nullable(),
    rawFailure: Text.nullable(),
  }).strict(),
}).strict();
export type SharedDiagnosis = z.infer<typeof SharedDiagnosisSchema>;
export const TargetInputSchema = z.object({
  id: IdSchema, prId: IdSchema, familyId: IdSchema, lineageId: IdSchema,
  path: RepositoryPathSchema, sourceDigest: DigestSchema, source: Text, sourceSnapshotDigest: DigestSchema,
  issueScope: z.object({ start: Count, end: Count }).strict().refine(s => s.end > s.start, 'Empty issue scope'),
  evidence: z.array(z.object({ id: IdSchema, content: Text }).strict()).min(1).max(32),
  missingEvidence: z.array(Text).max(32),
}).strict();
export type TargetInput = z.infer<typeof TargetInputSchema>;
export const GateCaseSchema = z.object({
  input: TargetInputSchema, expected: z.enum(['violation', 'safe', 'not_applicable']),
  role: z.enum(['old_positive', 'feedback', 'regression']), obligationRefs: Refs.min(1), evidenceRecordDigest: DigestSchema,
}).strict();
export type GateCase = z.infer<typeof GateCaseSchema>;
export const FutureCaseSchema = z.object({
  input: TargetInputSchema,
  label: z.enum(['violation', 'legal_neighbor', 'safe_applicable', 'unknown', 'disputed']),
  repeatedFeedbackMechanism: z.boolean(), labelRecordDigest: DigestSchema,
}).strict();
export type FutureCase = z.infer<typeof FutureCaseSchema>;
export const SettingsSchema = z.object({
  revisionModel: Text, reviewerModel: Text, sampler: z.object({ temperature: z.number().min(0).max(2), seed: Count }).strict(),
  modelReasoningEffort: CodexModelReasoningEffortSchema.optional(),
  armOrder: z.array(z.enum(ARMS)).length(4).refine(xs => new Set(xs).size === 4, 'Every arm exactly once'),
  tokenizer: z.literal('fixture-utf8-byte-upper-bound-v1'),
  limits: z.object({
    revisionInputTokens: Count.min(1), revisionOutputTokens: Count.min(1), persistentStateTokens: Count.min(1),
    reviewInputTokens: Count.min(1), reviewOutputTokens: Count.min(1),
    maxCallsPerArm: Count.min(1), maxInputBytes: Count.min(1).max(2_000_000), maxOutputBytes: Count.min(1).max(1_000_000),
    maxInputTokensPerArm: Count.min(1), maxOutputTokensPerArm: Count.min(1),
    timeoutMsPerCall: Count.min(1).max(300_000), maxElapsedMsPerArm: Count.min(1), maxCostMicrosPerArm: Count,
  }).strict(),
}).strict();
export type Settings = z.infer<typeof SettingsSchema>;
/** Revision graph is validated by existing product graph/receipt checks, not z.unknown(). */
export interface FrozenEpisode {
  schemaVersion: 1; kind: 'matched-revision-frozen-episode'; origin: 'authored_fixture';
  id: string; familyId: string; frozenAt: string; revision: RevisionModelInput;
  diagnosis: SharedDiagnosis; gate: GateCase[]; revisionLineageIds: string[];
  visibilityAndMissingness: string; protocolRecordDigest: string;
  settings: Settings;
}
export interface FrozenPacket { digest: string; episode: FrozenEpisode }
export interface FrozenFuture { digest: string; cases: FutureCase[] }
export const UsageSchema = z.object({ inputTokens: Count, outputTokens: Count, cachedInputTokens: Count,
  costMicros: Count.nullable() }).strict().refine(u => u.cachedInputTokens <= u.inputTokens, 'Cached tokens exceed input');
export type Usage = z.infer<typeof UsageSchema>;
export const TransportEvidenceSchema = z.object({
  adapter: z.literal('authored-codex-sdk'), sdkVersion: z.literal('0.159.2'),
  controls: z.literal('not-enforced-authored-script'), modelCalls: z.literal(0),
  sessionId: z.string().min(1).max(256).nullable(), processEvidence: WorkspaceWorkerProcessEvidence.nullable(),
  rawUsage: WorkspaceWorkerUsage.nullable(), cleanup: z.enum(['verified', 'unverified', 'not_started']),
}).strict();
export const TransportResultSchema = z.object({
  status: z.enum(['completed', 'failed']), output: z.unknown(), error: Text.nullable(), usage: UsageSchema.nullable(),
  transportEvidence: TransportEvidenceSchema.optional(),
}).strict();
export type TransportResult = z.infer<typeof TransportResultSchema>;
/** Authored callbacks or explicitly authored SDK executables, never live-model fallback. */
export interface AuthoredTransport {
  kind: 'authored-test-no-model'; id: string;
  capabilities?: typeof MATCHED_CODEX_CAPABILITIES;
  /** Bounded wait for the existing supervised invocation after cancellation. */
  abortSettlementMs?: number;
  execute(request: ModelRequest, signal: AbortSignal): Promise<TransportResult>;
}
export interface Observation {
  targetId: string; prediction: Judgment['prediction']; reason: string;
  evidenceSupport: 'fixture-bound' | 'unsupported' | 'not_assessable'; judgment: Judgment | null;
}
