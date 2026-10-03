import { z } from 'zod';
import { DigestSchema } from './model.js';
import { SemanticRuleVersionSchema } from './semantic-rule.js';
import { SemanticReviewSchema, SnapshotAnchorSchema } from './semantic-review.js';
import { RepositoryContextDigestSetSchema } from './semantic-review-context.js';
import { ChangeSnapshotPackageSchema } from '../change-snapshot.js';

/** A separate descriptive research contract; never a v1 promotion certificate. */
export const PAIRED_EVALUATION_VERSION = 'exact-anchor-issue-paired-v1' as const;
export const CONTEXT_PAIRED_EVALUATION_VERSION = 'exact-anchor-context-issue-paired-v2' as const;
export const PAIRED_EVALUATION_LIMITS = {
  datasetBytes: 16_000_000, annotationBytes: 4_000_000, runsBytes: 32_000_000,
  reportBytes: 16_000_000, prs: 25, families: 8, arms: 4, units: 200,
  instances: 2000, anchorsPerInstance: 20, totalFindings: 20_000,
} as const;
const Text = z.string().min(1).max(4096).refine(v => !!v.trim(), 'Expected nonblank text');
const Id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const Timestamp = z.string().datetime({ offset: true });
const Notes = z.array(Text).max(100);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Provenance = z.literal('locally-declared-unverified');
export const EvaluationDatasetSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('paired-review-evaluation-dataset'), id: Id, version: Id,
  protocolDigest: DigestSchema,
  sampling: z.object({
    kind: z.enum(['synthetic', 'census-declared', 'probability-declared', 'purposive', 'enriched-case-study', 'unknown']),
    population: Text, frameDigest: DigestSchema.nullable(), selectionProcedure: Text,
    frameUnknownCount: Count, limitations: Notes,
  }).strict(),
  temporal: z.object({
    historyCutoff: Timestamp.nullable(), targetWindowStart: Timestamp.nullable(), targetWindowEnd: Timestamp.nullable(),
    annotationObservationCutoff: Timestamp.nullable(),
    visibility: z.enum(['synthetic', 'as-of-declared', 'current-capture', 'unknown']),
    historyExposure: z.enum(['synthetic', 'as-of-allowlist-declared', 'all-local-refs-v1', 'unknown']),
    isolationManifestDigest: DigestSchema.nullable(), pretrainingExposure: z.enum(['unknown', 'possible', 'synthetic']), limitations: Notes,
  }).strict(),
  sourceAttestation: Provenance,
  families: z.array(z.object({ id: Id, ruleIds: z.array(Id).min(1).max(20), definitionDigest: DigestSchema, description: Text }).strict()).min(1).max(PAIRED_EVALUATION_LIMITS.families),
  prs: z.array(z.object({
    id: Id, repository: Text, number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    split: z.enum(['synthetic', 'development', 'holdout']), lineageId: Id,
    inclusionProbability: z.number().gt(0).max(1).nullable(), checkpointAt: Timestamp.nullable(),
    checkpointEvidenceDigest: DigestSchema.nullable(), snapshot: ChangeSnapshotPackageSchema,
  }).strict()).min(1).max(PAIRED_EVALUATION_LIMITS.prs),
}).strict();
export type EvaluationDataset = z.infer<typeof EvaluationDatasetSchema>;
export const EvaluationAnnotationSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('paired-review-evaluation-annotations'), id: Id, version: Id,
  datasetDigest: DigestSchema, rubricDigest: DigestSchema,
  provenance: z.object({
    origin: z.enum(['synthetic', 'local-human-declared', 'adjudicated']),
    verification: Provenance, authors: z.array(Id).min(1).max(20),
    independentOfRuns: z.boolean(), blindedToOutputs: z.boolean(), procedure: Text,
    evidenceDigests: z.array(DigestSchema).max(100),
  }).strict(),
  coverage: z.array(z.object({ prId: Id, familyId: Id,
    state: z.enum(['complete-declared', 'partial', 'unassessed', 'excluded']), reason: Text,
  }).strict()).max(PAIRED_EVALUATION_LIMITS.units),
  instances: z.array(z.object({
    id: Id, prId: Id, familyId: Id, issueId: Id, lineageId: Id,
    label: z.enum(['positive', 'negative', 'unknown', 'disputed', 'excluded']),
    anchors: z.array(SnapshotAnchorSchema).min(1).max(PAIRED_EVALUATION_LIMITS.anchorsPerInstance),
    reason: Text, evidenceDigests: z.array(DigestSchema).max(20),
  }).strict()).max(PAIRED_EVALUATION_LIMITS.instances),
}).strict();
export type EvaluationAnnotations = z.infer<typeof EvaluationAnnotationSchema>;

export const EvaluationMatchConditionsSchema = z.object({
  model: z.object({ provider: Text, name: Text, version: Text, configurationDigest: DigestSchema,
    execution: z.enum(['authored-fixture', 'declared-model']), attestation: Provenance }).strict(),
  information: z.object({ manifestDigest: DigestSchema, access: z.enum(['diff-only', 'changed-files', 'full-repository', 'selected-evidence']),
    toolsDigest: DigestSchema, retrievalDigest: DigestSchema, historyPolicy: Text }).strict(),
  budget: z.object({ manifestDigest: DigestSchema, accounting: z.literal('construction-maintenance-and-review'),
    maxModelCalls: Count, maxInputTokens: Count, maxOutputTokens: Count, maxWallTimeMs: Count,
    currency: z.string().regex(/^[A-Z]{3}$/), maxCostMicros: Count }).strict(),
}).strict();
export const EvaluationRunsSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('paired-review-evaluation-runs'), id: Id, version: Id,
  datasetDigest: DigestSchema, baselineArmId: Id,
  arms: z.array(z.object({
    id: Id, description: Text,
    policy: z.object({ id: Id, version: Id, digest: DigestSchema }).strict(),
    conditions: EvaluationMatchConditionsSchema,
    // Null means unmeasured, never free. The exact budget declaration is not an enforcement receipt.
    totalUsage: z.object({ modelCalls: Count, inputTokens: Count, outputTokens: Count, wallTimeMs: Count, costMicros: Count }).strict().nullable(),
    units: z.array(z.object({
      prId: Id, familyId: Id, state: z.enum(['completed', 'abstained', 'failed', 'not-run']), reason: Text,
      // Optional for historical runs; when supplied it pins context even for failed/not-run units.
      repositoryContextDigests: RepositoryContextDigestSetSchema.optional(),
      rule: z.object({ digest: DigestSchema, rule: SemanticRuleVersionSchema }).strict(),
      review: z.object({ digest: DigestSchema, value: SemanticReviewSchema }).strict().nullable(),
    }).strict()).max(PAIRED_EVALUATION_LIMITS.units),
  }).strict()).min(2).max(PAIRED_EVALUATION_LIMITS.arms),
}).strict();
export type EvaluationRuns = z.infer<typeof EvaluationRunsSchema>;
export type EvaluationArm = EvaluationRuns['arms'][number];

export function emptyEvaluationCounts() {
  return {
    prs: 0, units: 0, completedUnits: 0, abstainedUnits: 0, failedUnits: 0, notRunUnits: 0, missingRunUnits: 0,
    annotationCompleteUnits: 0, annotationPartialUnits: 0, annotationUnassessedUnits: 0, annotationExcludedUnits: 0,
    positiveInstances: 0, negativeInstances: 0, unknownInstances: 0, disputedInstances: 0, excludedInstances: 0,
    usefulInstances: 0, falseAlertInstances: 0, missedPositiveInstances: 0, knownNegativeWithoutAlertInstances: 0,
    instancesWithNoExactPrediction: 0, instancesWithUnknownPrediction: 0, explicitSafeInstances: 0,
    uniqueAlerts: 0, usefulAlertAnchors: 0, redundantPositiveAlertAnchors: 0, falseAlertAnchors: 0,
    unknownLabelAlertAnchors: 0, disputedLabelAlertAnchors: 0, excludedLabelAlertAnchors: 0, unmatchedAlertAnchors: 0,
    safePredictionAnchors: 0, abstentionAnchors: 0, notVerifiedAnchors: 0, unmatchedPredictionAnchors: 0,
    capturedTargets: 0, excludedTargets: 0, deletedTargets: 0, outOfScopeTargets: 0, unsupportedTargets: 0,
    knownTargets: 0, unknownTargets: 0, notRunTargets: 0, incompleteScanTargets: 0,
  };
}
export type EvaluationCounts = ReturnType<typeof emptyEvaluationCounts>;
