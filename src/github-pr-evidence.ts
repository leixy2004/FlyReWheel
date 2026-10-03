import { z } from 'zod';
import { digestOf } from './core/identity.js';
import { ChangeSnapshotSchema } from './change-snapshot.js';

export const GITHUB_PR_MAX_JSON_BYTES = 8_000_000;
export const GithubSha = z.string().regex(/^[a-f0-9]{40}$/).refine(value => !/^0+$/.test(value));
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const GithubRepository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(value => !['.', '..'].includes(value.split('/')[1]));
export const GithubAuthor = z.object({ id: Id, login: z.string().min(1).max(100) }).strict().nullable();
const Time = z.string().datetime({ offset: true });
export const GithubPath = z.string().min(1).max(4096).refine(path => Buffer.byteLength(path) <= 4096 && !path.includes('\0') && !path.includes('\\') &&
  !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..') &&
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(path)) === path, 'Invalid repository-relative path');
const Body = z.string().max(65_536).nullable();
const GithubUrl = z.string().url().max(2048).refine(value => new URL(value).origin === 'https://github.com');
export const GithubPullSchema = z.object({
  id: Id, number: Id, repository: GithubRepository, url: GithubUrl,
  title: z.string().max(1024), body: Body, author: GithubAuthor,
  state: z.enum(['open', 'closed']), draft: z.boolean(), merged: z.boolean(),
  createdAt: Time, updatedAt: Time, closedAt: Time.nullable(), mergedAt: Time.nullable(),
  baseRef: z.string().max(1024), baseTip: GithubSha, headRef: z.string().max(1024), head: GithubSha,
  headRepository: GithubRepository.nullable(), mergeCommit: GithubSha.nullable(),
  reportedChangedFiles: Count, reportedIssueComments: Count, reportedReviewComments: Count,
}).strict();
const CommentBase = z.object({ id: Id, url: GithubUrl, author: GithubAuthor, body: Body });
export const GithubIssueCommentSchema = CommentBase.extend({ createdAt: Time, updatedAt: Time }).strict();
export const GithubReviewSchema = CommentBase.extend({
  submittedAt: Time.nullable(), state: z.string().min(1).max(100), commitId: GithubSha.nullable(),
}).strict();
export const GithubReviewCommentSchema = CommentBase.extend({
  createdAt: Time, updatedAt: Time, reviewId: Id.nullable(), inReplyToId: Id.nullable(),
  path: GithubPath, diffHunk: z.string().max(131_072),
  commitId: GithubSha, originalCommitId: GithubSha, line: Count.nullable(), originalLine: Count.nullable(),
  startLine: Count.nullable(), originalStartLine: Count.nullable(),
  side: z.enum(['LEFT', 'RIGHT']).nullable(), startSide: z.enum(['LEFT', 'RIGHT']).nullable(),
}).strict();
export const GithubPrEvidenceSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('github-pr-evidence'),
  snapshotDigest: Digest, snapshot: ChangeSnapshotSchema,
  pull: GithubPullSchema,
  source: z.object({
    provider: z.literal('github'), apiOrigin: z.literal('https://api.github.com'),
    observation: z.literal('current-api-state'), historicalReviewCheckpoint: z.literal(false),
    ancestry: z.literal('provider-declared'), inventory: z.literal('provider-declared-compare'),
    repositoryContext: z.literal('changed-paths-only'),
    discussionConsistency: z.literal('non-atomic-current-observation'),
    discussionCoverage: z.literal('all-pages-returned-within-limits'),
    compareFileCount: z.number().int().min(0).max(299),
    sourceStatements: z.literal('untrusted-not-ground-truth-or-feedback'),
  }).strict(),
  discussions: z.object({
    issueComments: z.array(GithubIssueCommentSchema).max(300),
    reviews: z.array(GithubReviewSchema).max(300),
    reviewComments: z.array(GithubReviewCommentSchema).max(300),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (digestOf(value.snapshot) !== value.snapshotDigest) invalid('PR evidence snapshot digest mismatch');
  const { snapshot, pull } = value, metadata = snapshot.prMetadata;
  if (snapshot.repository.id !== `github:${pull.repository.toLowerCase()}` || snapshot.baseTip !== pull.baseTip || snapshot.head !== pull.head ||
      !metadata || metadata.provider !== 'github' || metadata.repository !== pull.repository || metadata.number !== pull.number || metadata.url !== pull.url || metadata.declaredVisibleAt !== undefined) {
    invalid('PR source identity/ref binding disagrees with snapshot');
  }
  if (pull.url.toLowerCase() !== `https://github.com/${pull.repository}/pull/${pull.number}`.toLowerCase()) invalid('PR URL and identity disagree');
  if (value.source.compareFileCount > snapshot.changes.length || snapshot.changes.length > value.source.compareFileCount * 2) invalid('Compare inventory count disagrees with normalized changes');
  if (pull.reportedIssueComments !== value.discussions.issueComments.length || pull.reportedReviewComments !== value.discussions.reviewComments.length) invalid('Discussion counts differ from provider-reported PR counts');
  for (const rows of Object.values(value.discussions)) {
    let previous = 0;
    for (const row of rows) {
      if (row.id <= previous) invalid('Discussion IDs must be unique and canonically sorted'); previous = row.id;
      if (row.url.split('#')[0].toLowerCase() !== pull.url.toLowerCase()) invalid('Discussion URL is outside its source PR');
    }
  }
  if (Buffer.byteLength(JSON.stringify(value.discussions)) > 2_000_000) invalid('Discussion evidence exceeds 2MB');
  if (Buffer.byteLength(JSON.stringify(value)) > 6_000_000) invalid('PR evidence exceeds 6MB');
});
export type GithubPrEvidence = z.infer<typeof GithubPrEvidenceSchema>;
export type StoredGithubPrEvidence = { digest: string; evidence: GithubPrEvidence };
export function validateGithubPrEvidence(input: unknown): StoredGithubPrEvidence {
  const evidence = GithubPrEvidenceSchema.parse(input);
  return { digest: digestOf(evidence), evidence };
}
export const GithubAcquisitionReceiptSchema = z.object({
  kind: z.literal('github-api-observation'), startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  authentication: z.literal('none'), transport: z.literal('@octokit/rest@22.0.1'),
  verification: z.literal('live-api-observation-not-verified-history'),
  requestLimit: z.number().int().min(1).max(50), requests: z.number().int().min(1).max(50),
  decodedResponseBytes: Count.max(12_000_000),
  observations: z.array(z.object({
    endpoint: z.string().min(1).max(2048), observedAt: z.string().datetime(), dataDigest: Digest,
    requestId: z.string().max(256).optional(), serverDate: z.string().max(100).optional(),
  }).strict()).min(1).max(50),
}).strict().superRefine((value, ctx) => {
  if (value.requests !== value.observations.length || value.requests > value.requestLimit || value.completedAt < value.startedAt) ctx.addIssue({ code: 'custom', message: 'Inconsistent acquisition receipt' });
});
/** A file's receipt is only a declaration: imports always replace it with integrity-only. */
export const GithubPrEvidencePackageSchema = z.object({
  digest: Digest, evidence: GithubPrEvidenceSchema,
  receipt: z.union([GithubAcquisitionReceiptSchema, z.object({ kind: z.literal('package-integrity-only') }).strict()]).optional(),
}).strict().refine(value => digestOf(value.evidence) === value.digest, 'PR evidence digest mismatch');
