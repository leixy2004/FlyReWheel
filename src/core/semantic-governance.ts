import { z } from 'zod';
import { DigestSchema, IdSchema } from './model.js';
import { RepositoryIdSchema, RepositoryPathSchema, RuleScopeSchema } from './semantic-rule.js';

/** This namespace never feeds the v1 active registry or a production executor. */
export const SEMANTIC_GOVERNANCE_NAMESPACE = 'local-semantic-review' as const;
export const GOVERNANCE_LIMITS = { events: 250, versions: 100, rules: 100, bytes: 16_000_000 } as const;
const Text = z.string().min(1).max(16_384).refine(value => !!value.trim(), 'Expected nonblank text');
const Identity = IdSchema.refine(value => value.trim() === value && !!value.length, 'Expected an exact nonblank ID');
const command = z.object({
  id: Identity, namespace: z.literal(SEMANTIC_GOVERNANCE_NAMESPACE),
  ruleDigest: DigestSchema, scopeDigest: DigestSchema, expectedHeadDigest: DigestSchema.nullable(),
  actor: Text, source: z.enum(['fixture', 'local-human-declared']), reason: Text, createdAt: z.string().datetime({ offset: true }),
}).strict();
export const SemanticGovernanceCommandSchema = z.discriminatedUnion('action', [
  command.extend({ action: z.literal('register') }).strict(),
  command.extend({ action: z.literal('bootstrap-shadow') }).strict(),
  command.extend({ action: z.literal('select-shadow'), decisionDigest: DigestSchema }).strict(),
  command.extend({ action: z.literal('suspend') }).strict(),
  command.extend({ action: z.literal('retire') }).strict(),
  command.extend({ action: z.literal('supersede'), decisionDigest: DigestSchema,
    successor: z.object({ ruleDigest: DigestSchema, scopeDigest: DigestSchema }).strict() }).strict(),
]);
export type SemanticGovernanceCommand = z.infer<typeof SemanticGovernanceCommandSchema>;
export const SemanticGovernanceStatusSchema = z.enum(['candidate', 'local-shadow', 'suspended', 'retired', 'superseded']);
export type SemanticGovernanceStatus = z.infer<typeof SemanticGovernanceStatusSchema>;
export const SemanticGovernanceBindingSchema = z.object({
  ruleDigest: DigestSchema, ruleId: Identity, version: Identity, scope: RuleScopeSchema, scopeDigest: DigestSchema, parentDigest: DigestSchema.nullable(),
}).strict();
export type SemanticGovernanceBinding = z.infer<typeof SemanticGovernanceBindingSchema>;
export const SemanticGovernanceTrustSchema = z.object({
  identityVerification: z.literal('caller-declared-unverified'),
  eligibility: z.literal('local-experimental-review-only'),
  productionActivation: z.literal('not_performed'), certification: z.literal('none'),
}).strict();
export const semanticGovernanceTrust = Object.freeze(SemanticGovernanceTrustSchema.parse({
  identityVerification: 'caller-declared-unverified', eligibility: 'local-experimental-review-only', productionActivation: 'not_performed', certification: 'none',
}));
export const SemanticGovernanceEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unvalidated-root-bootstrap') }).strict(),
  z.object({ kind: z.literal('accepted-local-comparison'), decisionDigest: DigestSchema, comparisonDigest: DigestSchema,
    baseRuleDigest: DigestSchema, candidateRuleDigest: DigestSchema, scorer: z.enum(['per-anchor-semantic-v3', 'per-anchor-context-v4', 'scope-applicability-v5']),
    decisionSource: z.enum(['fixture', 'local-human-declared']), comparisonStatus: z.literal('compatible'), observations: z.number().int().positive(),
    semanticEvidence: z.enum(['offline-fixture-declarations', 'includes-workspace-execution-receipts']),
    scope: z.literal('declared-cases-and-selected-feedback-only'), certification: z.literal('none'),
  }).strict(),
]);
export type SemanticGovernanceEvidence = z.infer<typeof SemanticGovernanceEvidenceSchema>;
export const SemanticGovernanceEventSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('local-semantic-governance-event'), command: SemanticGovernanceCommandSchema,
  ruleId: Identity, sequence: z.number().int().positive().max(GOVERNANCE_LIMITS.events), previousEventDigest: DigestSchema.nullable(),
  bindings: z.array(SemanticGovernanceBindingSchema).min(1).max(2),
  transitions: z.array(z.object({ ruleDigest: DigestSchema, from: SemanticGovernanceStatusSchema.nullable(), to: SemanticGovernanceStatusSchema }).strict()).min(1).max(2),
  shadowRuleDigest: DigestSchema.nullable(), evidence: SemanticGovernanceEvidenceSchema.nullable(), trust: SemanticGovernanceTrustSchema,
}).strict();
export type SemanticGovernanceEvent = z.infer<typeof SemanticGovernanceEventSchema>;
export type StoredSemanticGovernanceEvent = { digest: string; event: SemanticGovernanceEvent };
export type GovernedSemanticVersion = SemanticGovernanceBinding & { status: SemanticGovernanceStatus; selectionEvidence: SemanticGovernanceEvidence | null };
export type SemanticGovernanceState = {
  namespace: typeof SEMANTIC_GOVERNANCE_NAMESPACE; ruleId: string; headDigest: string | null; sequence: number;
  versions: GovernedSemanticVersion[]; shadowRuleDigest: string | null; trust: typeof semanticGovernanceTrust;
};
export const LocalSemanticSelectionInputSchema = z.object({
  repository: RepositoryIdSchema,
  paths: z.array(RepositoryPathSchema).min(1).max(1000).refine(values => new Set(values).size === values.length, 'Duplicate selection paths'),
}).strict();
export type LocalSemanticSelectionInput = z.infer<typeof LocalSemanticSelectionInputSchema>;
export type LocalSemanticSelectionEntry = GovernedSemanticVersion & { headDigest: string };
export type LocalSemanticSelection = LocalSemanticSelectionInput & {
  namespace: typeof SEMANTIC_GOVERNANCE_NAMESPACE;
  selected: LocalSemanticSelectionEntry[];
  excluded: (LocalSemanticSelectionEntry & { reason: 'out_of_scope' | Exclude<SemanticGovernanceStatus, 'local-shadow'> })[];
  trust: typeof semanticGovernanceTrust;
};

export const LocalSemanticSelectionEntrySchema = SemanticGovernanceBindingSchema.extend({
  status: SemanticGovernanceStatusSchema, selectionEvidence: SemanticGovernanceEvidenceSchema.nullable(), headDigest: DigestSchema,
}).strict();
export const LocalSemanticSelectionSchema = LocalSemanticSelectionInputSchema.extend({
  namespace: z.literal(SEMANTIC_GOVERNANCE_NAMESPACE),
  selected: z.array(LocalSemanticSelectionEntrySchema).max(GOVERNANCE_LIMITS.rules),
  excluded: z.array(LocalSemanticSelectionEntrySchema.extend({
    reason: z.enum(['out_of_scope', 'candidate', 'suspended', 'retired', 'superseded']),
  }).strict()).max(GOVERNANCE_LIMITS.rules * GOVERNANCE_LIMITS.versions),
  trust: SemanticGovernanceTrustSchema,
}).strict();
