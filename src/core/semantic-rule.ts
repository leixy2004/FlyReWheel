import { z } from 'zod';
import { DetectorSchema, DigestSchema, IdSchema, RuleBundleSchema } from './model.js';

const TextSchema = z.string().min(1).refine(value => value.trim().length > 0, 'Expected nonblank text');
const SemanticIdSchema = IdSchema.refine(value => value.trim() === value && value.length > 0, 'Expected a nonblank, unpadded ID');
/** An exact caller-supplied repository identity, not a verified URL or a glob. */
export const RepositoryIdSchema = z.string().min(1).max(500).refine(
  value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value), 'Expected an exact, unpadded repository identity',
);
export const FullCommitSchema = z.string().regex(/^[a-f0-9]{40}$/, 'Expected a full lowercase Git SHA-1 commit');
/** POSIX repository paths only. No normalization, traversal, wildcard or host-path interpretation. */
export const RepositoryPathSchema = z.string().min(1).max(4096).refine(
  value => value.trim() === value && !/[\\:*?\[\]{}\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
  'Expected a literal repository-relative POSIX path without traversal or wildcards',
);
const ScopePathSchema = z.union([z.literal('.'), RepositoryPathSchema]);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const under = (path: string, prefix: string) => prefix === '.' || path === prefix || path.startsWith(`${prefix}/`);
export const RuleScopeSchema = z.object({
  repositories: z.array(RepositoryIdSchema).min(1).refine(unique, 'Duplicate repositories'),
  paths: z.object({
    include: z.array(ScopePathSchema).min(1).refine(unique, 'Duplicate included paths'),
    exclude: z.array(ScopePathSchema).refine(unique, 'Duplicate excluded paths'),
  }).strict(),
}).strict().refine(
  value => value.paths.include.some(include => !value.paths.exclude.some(exclude => under(include, exclude))),
  'Exclusions cannot cover every included path',
);
export type RuleScope = z.infer<typeof RuleScopeSchema>;

/** This is candidate scope only; a match does not establish semantic applicability or a finding. */
export function matchesRuleScope(scopeInput: RuleScope, repository: string, path: string): boolean {
  const scope = RuleScopeSchema.parse(scopeInput);
  RepositoryIdSchema.parse(repository);
  RepositoryPathSchema.parse(path);
  return scope.repositories.includes(repository)
    && scope.paths.include.some(prefix => under(path, prefix))
    && !scope.paths.exclude.some(prefix => under(path, prefix));
}

export const SourceCaseReferenceSchema = z.object({
  caseId: SemanticIdSchema,
  repository: RepositoryIdSchema,
  commit: FullCommitSchema,
  path: RepositoryPathSchema,
  sourceDigest: DigestSchema,
}).strict();

/** Semantic identity is independent of executable projections. No model or detector is run on import. */
export const SemanticRuleVersionSchema = z.object({
  schemaVersion: z.literal(2),
  ruleId: SemanticIdSchema,
  version: SemanticIdSchema,
  semantics: z.object({
    title: TextSchema,
    mechanism: TextSchema,
    invariant: TextSchema,
    applicability: z.array(TextSchema).min(1),
    exceptions: z.array(TextSchema),
    requiredContext: z.array(TextSchema),
    expectedBehavior: TextSchema,
  }).strict(),
  scope: RuleScopeSchema,
  detectionAssets: z.array(z.object({
    id: SemanticIdSchema,
    detector: DetectorSchema,
  }).strict()).refine(values => unique(values.map(value => value.id)), 'Duplicate detection asset IDs').optional(),
  regressionCases: z.array(z.object({
    caseId: SemanticIdSchema,
    role: z.enum(['positive', 'negative', 'fixed']),
  }).strict()).refine(values => unique(values.map(value => value.caseId)), 'Duplicate regression cases'),
  provenance: z.object({
    sourceCases: z.array(SourceCaseReferenceSchema).min(1)
      .refine(values => unique(values.map(value => value.caseId)), 'Duplicate source cases'),
    parentDigest: DigestSchema.nullable(),
    author: TextSchema,
    createdAt: z.string().datetime({ offset: true }),
    rationale: TextSchema,
  }).strict(),
}).strict();
export type SemanticRuleVersion = z.infer<typeof SemanticRuleVersionSchema>;

/** Explicit read compatibility only: v1 retains its original structure and content digest. */
export const RuleVersionSchema = z.discriminatedUnion('schemaVersion', [RuleBundleSchema, SemanticRuleVersionSchema]);
export type RuleVersion = z.infer<typeof RuleVersionSchema>;
export type StoredRuleVersion = { digest: string; rule: RuleVersion };
