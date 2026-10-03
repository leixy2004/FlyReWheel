import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { digestOf } from './core/identity.js';
import { classifyGithubReadFailure, githubHttpFailureDiagnostic, GithubReadError } from './github-pr-diagnostics.js';
import { DEFAULT_SNAPSHOT_LIMITS, SnapshotLimitsSchema, validateChangeSnapshot, type ChangeSnapshot } from './change-snapshot.js';
import {
  GithubAcquisitionReceiptSchema, GithubAuthor, GithubPath, GithubIssueCommentSchema, GithubPrEvidenceSchema, GithubPullSchema,
  GithubRepository, GithubReviewCommentSchema, GithubReviewSchema, GithubSha, validateGithubPrEvidence,
} from './github-pr-evidence.js';

const Input = z.object({
  repository: GithubRepository, number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxRequests: z.number().int().min(1).max(50).default(50), limits: SnapshotLimitsSchema.optional(),
  includeSourceProvenance: z.boolean().default(false),
  expectedMerge: z.object({ mergedAt: z.string().datetime(), mergeCommit: GithubSha }).strict().optional(),
}).strict();
export type CaptureGithubPrInput = z.input<typeof Input>;
/** Shared in-process allowance for an explicitly invoked serial batch; never serialized as trust. */
export type GithubCaptureBudget = { requestsRemaining: number; deadline: number };
export type GithubSourceObservation = { endpoint: string; observedAt: string; dataDigest: string; data: Record<string, unknown> };
type GithubSourceIdentity = { commit: string; tree: string; observation: GithubSourceObservation };
export type GithubSourceProvenance = {
  sourceIdentities: { baseTip: GithubSourceIdentity & { role: 'current-tip-metadata-only-not-source' }; mergeBase: GithubSourceIdentity; head: GithubSourceIdentity };
  license: { sourceRef: string; path: string; text: string; blobSha1: string; sha256: string;
    observation: GithubSourceObservation; treeObservation: GithubSourceObservation };
  sourceTrees: GithubSourceObservation[];
};
export class GithubCaptureLimitError extends Error {
  constructor(public readonly reason: 'request-budget' | 'deadline', message: string) { super(message); this.name = 'GithubCaptureLimitError'; }
}
const Path = GithubPath;
const Size = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const TreeEntry = z.object({ path: Path, mode: z.string().regex(/^[0-7]{6}$/), type: z.enum(['blob', 'tree', 'commit']), sha: GithubSha, size: Size.optional() });
type Entry = z.infer<typeof TreeEntry>;
type Side = ChangeSnapshot['changes'][number]['before'];
type Response<T> = { data: T; status: number; headers: Record<string, string | number | undefined> };
const author = (value: unknown) => GithubAuthor.parse(value === null ? null : value && typeof value === 'object' ? { id: (value as any).id, login: (value as any).login } : value);
function pull(data: any, repository: string, number: number) {
  if (data.number !== number || typeof data.base?.repo?.full_name !== 'string' || data.base.repo.full_name.toLowerCase() !== repository.toLowerCase() || data.base.repo.private !== false) throw new Error('PR did not identify the requested public base repository');
  return GithubPullSchema.parse({
    id: data.id, number: data.number, repository: data.base.repo.full_name, url: data.html_url, title: data.title, body: data.body, author: author(data.user),
    state: data.state, draft: data.draft, merged: data.merged, createdAt: data.created_at, updatedAt: data.updated_at, closedAt: data.closed_at, mergedAt: data.merged_at,
    baseRef: data.base.ref, baseTip: data.base.sha, headRef: data.head?.ref, head: data.head?.sha,
    headRepository: data.head?.repo?.full_name ?? null, mergeCommit: data.merge_commit_sha,
    reportedChangedFiles: data.changed_files, reportedIssueComments: data.comments, reportedReviewComments: data.review_comments,
  });
}
function issueComment(data: any) { return GithubIssueCommentSchema.parse({ id: data.id, url: data.html_url, author: author(data.user), body: data.body, createdAt: data.created_at, updatedAt: data.updated_at }); }
function review(data: any) { return GithubReviewSchema.parse({ id: data.id, url: data.html_url, author: author(data.user), body: data.body, submittedAt: data.submitted_at ?? null, state: data.state, commitId: data.commit_id ?? null }); }
function reviewComment(data: any) {
  return GithubReviewCommentSchema.parse({ id: data.id, url: data.html_url, author: author(data.user), body: data.body, createdAt: data.created_at, updatedAt: data.updated_at,
    reviewId: data.pull_request_review_id ?? null, inReplyToId: data.in_reply_to_id ?? null, path: data.path, diffHunk: data.diff_hunk,
    commitId: data.commit_id, originalCommitId: data.original_commit_id, line: data.line ?? null, originalLine: data.original_line ?? null,
    startLine: data.start_line ?? null, originalStartLine: data.original_start_line ?? null, side: data.side ?? null, startSide: data.start_side ?? null });
}
const hashBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const order = (a: ChangeSnapshot['changes'][number], b: ChangeSnapshot['changes'][number]) => {
  const key = (change: ChangeSnapshot['changes'][number]) => {
    const before = change.before.state === 'absent' ? '' : change.before.path, after = change.after.state === 'absent' ? '' : change.after.path;
    return [after || before, change.status, before, after];
  };
  const left = key(a), right = key(b);
  for (let i = 0; i < left.length; i++) { const value = Buffer.compare(Buffer.from(left[i]), Buffer.from(right[i])); if (value) return value; }
  return 0;
};

/** GET-only public source acquisition. No credentials, git clone, repository execution or provider writes.
 * `fetch` is a transport seam for offline tests; the production path uses unmodified official Octokit.
 * JSON byte budgets are checked after Octokit decodes each response, not a streaming wire-memory bound.
 */
export async function captureGithubPrEvidence(input: CaptureGithubPrInput, testing: { fetch?: typeof globalThis.fetch; budget?: GithubCaptureBudget } = {}) {
  const options = Input.parse(input), limits = options.limits ?? { ...DEFAULT_SNAPSHOT_LIMITS };
  const [owner, repo] = options.repository.split('/');
  const client = new Octokit({ userAgent: 'FlyReWheel/0.1 read-only-evidence', ...(testing.fetch ? { request: { fetch: testing.fetch } } : {}) });
  client.hook.before('request', request => {
    if (request.method !== 'GET' || request.headers.authorization !== undefined) throw new Error('Only unauthenticated GitHub GET requests are allowed');
    request.headers['x-github-api-version'] = '2022-11-28';
  });
  const startedAt = new Date().toISOString(), deadline = Math.min(Date.now() + 120_000, testing.budget?.deadline ?? Infinity);
  const observations: z.infer<typeof GithubAcquisitionReceiptSchema>['observations'] = [];
  let requests = 0, decodedResponseBytes = 0;
  const read = async <T>(endpoint: string, action: (request: { signal: AbortSignal; redirect: 'error' }) => Promise<Response<T>>) => {
    if (++requests > options.maxRequests) throw new GithubCaptureLimitError('request-budget', `GitHub request limit ${options.maxRequests} exceeded; no evidence produced`);
    if (testing.budget && testing.budget.requestsRemaining <= 0) throw new GithubCaptureLimitError('request-budget', 'GitHub batch request limit reached; no evidence produced');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GithubCaptureLimitError('deadline', 'GitHub acquisition exceeded its bounded deadline');
    if (testing.budget) testing.budget.requestsRemaining--;
    const request = { signal: AbortSignal.timeout(Math.min(15_000, remaining)), redirect: 'error' as const };
    let result: Response<T>;
    try { result = await action(request); }
    catch (error) {
      if (Date.now() >= deadline) throw new GithubCaptureLimitError('deadline', 'GitHub acquisition exceeded its bounded deadline');
      // Do not reproduce server bodies or arbitrary credential-bearing request objects in errors.
      const diagnostic = githubHttpFailureDiagnostic(error);
      throw new GithubReadError(endpoint, diagnostic, classifyGithubReadFailure(error, diagnostic));
    }
    if (Date.now() > deadline) throw new GithubCaptureLimitError('deadline', 'GitHub acquisition exceeded its bounded deadline');
    if (result.status !== 200) throw new Error('Unexpected GitHub read status; no evidence produced');
    const bytes = Buffer.byteLength(JSON.stringify(result.data));
    decodedResponseBytes += bytes;
    if (bytes > 2_000_000 || decodedResponseBytes > 12_000_000) throw new Error('GitHub decoded-response byte budget exceeded; no evidence produced');
    const requestId = result.headers['x-github-request-id'], serverDate = result.headers.date;
    const observation = { endpoint, observedAt: new Date().toISOString(), dataDigest: digestOf(result.data) };
    observations.push({ ...observation,
      ...(requestId === undefined ? {} : { requestId: String(requestId) }), ...(serverDate === undefined ? {} : { serverDate: String(serverDate) }) });
    return { ...result, observation };
  };
  const prEndpoint = `GET /repos/${owner}/${repo}/pulls/${options.number}`;
  const getPull = async () => pull((await read(prEndpoint, request => client.rest.pulls.get({ owner, repo, pull_number: options.number, request }))).data, options.repository, options.number);
  const initial = await getPull();
  if (options.expectedMerge && (!initial.merged || initial.mergedAt !== options.expectedMerge.mergedAt ||
    initial.mergeCommit !== options.expectedMerge.mergeCommit)) throw new Error('Frozen PR merge identity changed; no source read');
  if (initial.reportedIssueComments > 300 || initial.reportedReviewComments > 300) throw new Error('Discussion count exceeds bounded capture; no evidence produced');
  const comparison = (await read(`GET /repos/${owner}/${repo}/compare/${initial.baseTip}...${initial.head}?page=1&per_page=1`,
    request => client.rest.repos.compareCommits({ owner, repo, base: initial.baseTip, head: initial.head, page: 1, per_page: 1, request }))).data;
  if (comparison.base_commit.sha !== initial.baseTip) throw new Error('Comparison base differs from pinned PR base');
  const mergeBase = GithubSha.parse(comparison.merge_base_commit.sha);
  const files = z.array(z.object({
    filename: Path, previous_filename: Path.optional(), status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed']), sha: GithubSha,
  })).max(299).parse(comparison.files);
  // Compare returns at most 300 files, without a reliable total beyond the cap. Reject equality too.
  const paths = new Set<string>();
  for (const file of files) { if (paths.has(file.filename)) throw new Error('Duplicate compare inventory path'); paths.add(file.filename); }
  const rootTrees = new Map<string, string>();
  const commitObservations = new Map<string, GithubSourceObservation>();
  for (const commit of [...new Set([mergeBase, initial.head, ...(options.includeSourceProvenance ? [initial.baseTip] : [])])]) {
    const response = await read(`GET /repos/${owner}/${repo}/git/commits/${commit}`, request => client.rest.git.getCommit({ owner, repo, commit_sha: commit, request }));
    const value = response.data;
    if (value.sha !== commit) throw new Error('Git commit identity differs from requested SHA');
    rootTrees.set(commit, GithubSha.parse(value.tree.sha));
    if (options.includeSourceProvenance) commitObservations.set(commit, { ...response.observation, data: value });
  }
  const trees = new Map<string, Entry[]>();
  const treeObservations = new Map<string, GithubSourceObservation>();
  const getTree = async (sha: string) => {
    const known = trees.get(sha); if (known) return known;
    const response = await read(`GET /repos/${owner}/${repo}/git/trees/${sha}`, request => client.rest.git.getTree({ owner, repo, tree_sha: sha, request }));
    const value = response.data;
    if (value.sha !== sha || value.truncated !== false) throw new Error('Missing, mismatched or truncated Git tree');
    const entries = z.array(TreeEntry).max(10_000).parse(value.tree), names = new Set<string>();
    for (const entry of entries) {
      if (entry.path.includes('/') || names.has(entry.path)) throw new Error('Invalid nonrecursive tree entry');
      names.add(entry.path);
      if ((entry.type === 'tree') !== (entry.mode === '040000') || (entry.type === 'commit') !== (entry.mode === '160000') || (entry.type === 'blob' && entry.size === undefined)) throw new Error('Git tree type/mode/size mismatch');
    }
    trees.set(sha, entries);
    if (options.includeSourceProvenance) treeObservations.set(sha, { ...response.observation, data: value });
    return entries;
  };
  const sizes = new Map<string, number>();
  const sideAt = async (commit: string, path: string): Promise<Side> => {
    let sha = rootTrees.get(commit)!;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entry = (await getTree(sha)).find(value => value.path === parts[i]);
      if (!entry) return { state: 'absent' };
      if (i < parts.length - 1) {
        if (entry.type !== 'tree') return { state: 'absent' };
        sha = entry.sha; continue;
      }
      if (entry.type === 'tree') throw new Error('Compare inventory path is a directory');
      if (entry.size !== undefined) {
        if (sizes.has(entry.sha) && sizes.get(entry.sha) !== entry.size) throw new Error('Contradictory Git blob sizes');
        sizes.set(entry.sha, entry.size);
      }
      return { state: 'excluded', path, mode: entry.mode, objectId: entry.sha, reason: 'unsupported-mode', byteLength: entry.size ?? null, sha256: null };
    }
    throw new Error('Empty path');
  };
  const inventory: ChangeSnapshot['changes'] = [];
  const requirePresent = (side: Side) => { if (side.state === 'absent') throw new Error('Compare inventory is missing an expected tree entry'); return side; };
  for (const file of files) {
    const oldPath = file.status === 'renamed' ? Path.parse(file.previous_filename) : file.filename;
    const before = await sideAt(mergeBase, oldPath), after = await sideAt(initial.head, file.filename);
    if (file.status === 'added' || file.status === 'copied') {
      if (before.state !== 'absent') throw new Error('Added/copied path already exists in comparison base');
      requirePresent(after); inventory.push({ status: 'A', before, after });
    } else if (file.status === 'removed') {
      requirePresent(before); if (after.state !== 'absent') throw new Error('Removed path remains in comparison head');
      inventory.push({ status: 'D', before, after });
    } else {
      const left = requirePresent(before), right = requirePresent(after);
      if (file.status === 'renamed') {
        if (oldPath === file.filename) throw new Error('Rename requires different paths');
        if (left.objectId === right.objectId && left.mode.slice(0, 3) === right.mode.slice(0, 3)) inventory.push({ status: 'R100', before, after });
        else inventory.push({ status: 'D', before, after: { state: 'absent' } }, { status: 'A', before: { state: 'absent' }, after });
      } else inventory.push({ status: left.mode.slice(0, 3) === right.mode.slice(0, 3) ? 'M' : 'T', before, after });
    }
    const declared = file.status === 'removed' ? requirePresent(before) : requirePresent(after);
    if (file.sha !== declared.objectId) throw new Error('Compare file SHA disagrees with pinned tree');
    if (inventory.length > limits.maxChanges) throw new Error('Normalized change count exceeds limit; no evidence produced');
  }
  inventory.sort(order);
  let capturedBytes = 0, readBytes = 0;
  const blobs = new Map<string, Buffer>();
  const captureSide = async (side: Side): Promise<Side> => {
    if (side.state === 'absent') return side;
    const base = { path: side.path, mode: side.mode, objectId: side.objectId }, size = side.byteLength;
    const excluded = (reason: Extract<Side, { state: 'excluded' }>['reason'], digest: string | null = null): Side => ({ ...base, state: 'excluded', reason, byteLength: size, sha256: digest });
    if (side.mode === '160000') return { ...base, state: 'excluded', reason: 'submodule', byteLength: null, sha256: null };
    if (size === null) throw new Error('Missing Git blob size');
    if (side.mode === '120000') return excluded('symlink');
    if (!['100644', '100755'].includes(side.mode)) return excluded('unsupported-mode');
    if (size > limits.maxBlobBytes) return excluded('oversize');
    if (capturedBytes + size > limits.maxTotalBytes) return excluded('total-byte-limit');
    let bytes = blobs.get(side.objectId);
    if (!bytes) {
      if (readBytes + size > 8_388_608) throw new Error('GitHub blob-read budget exceeded');
      const blob = (await read(`GET /repos/${owner}/${repo}/git/blobs/${side.objectId}`, request => client.rest.git.getBlob({ owner, repo, file_sha: side.objectId, request }))).data;
      if (blob.sha !== side.objectId || blob.size !== size || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('Git blob metadata mismatch');
      const encoded = blob.content.replace(/\n/g, '');
      bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length !== size || hashBlob(bytes) !== side.objectId) throw new Error('Git blob byte/identity verification failed');
      blobs.set(side.objectId, bytes); readBytes += bytes.length;
    }
    const digest = sha256(bytes);
    try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (bytes.includes(0)) return excluded('binary', digest); }
    catch { return excluded('binary', digest); }
    capturedBytes += bytes.length;
    return { ...base, mode: side.mode as '100644' | '100755', state: 'captured', byteLength: size, sha256: digest, bytesBase64: bytes.toString('base64') };
  };
  for (const change of inventory) { change.before = await captureSide(change.before); change.after = await captureSide(change.after); }
  const sides = inventory.flatMap(change => [change.before, change.after]);
  const frozen = validateChangeSnapshot({ schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: `github:${initial.repository.toLowerCase()}`, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: initial.baseTip, mergeBase, head: initial.head, comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits,
    prMetadata: { verification: 'caller-supplied-unverified', provider: 'github', repository: initial.repository, number: initial.number, url: initial.url },
    changes: inventory, coverage: { changedPaths: inventory.length, capturedSides: sides.filter(side => side.state === 'captured').length,
      excludedSides: sides.filter(side => side.state === 'excluded').length, capturedBytes, scope: 'changed-entries-only' } });
  let sourceProvenance: GithubSourceProvenance | undefined;
  if (options.includeSourceProvenance) {
    const headTree = rootTrees.get(initial.head)!;
    const candidates = (await getTree(headTree)).filter(entry => /^(?:LICENSE|LICENCE|COPYING)(?:[._-][A-Za-z0-9._-]+)?$/i.test(entry.path));
    if (candidates.length !== 1) throw new Error('Exactly one root license file is required for source provenance');
    const licenseEntry = candidates[0];
    if (licenseEntry.type !== 'blob' || !['100644', '100755'].includes(licenseEntry.mode) ||
      licenseEntry.size === undefined || licenseEntry.size < 1 || licenseEntry.size > 262_144) throw new Error('Unsupported root license entry');
    if (readBytes + licenseEntry.size > 8_388_608) throw new Error('GitHub license-read byte budget exceeded');
    const response = await read(`GET /repos/${owner}/${repo}/contents/${encodeURIComponent(licenseEntry.path)}?ref=${initial.head}`,
      request => client.rest.repos.getContent({ owner, repo, path: licenseEntry.path, ref: initial.head, request }));
    const content = z.object({ type: z.literal('file'), path: Path, sha: GithubSha, size: Size,
      encoding: z.literal('base64'), content: z.string() }).parse(response.data);
    const encoded = content.content.replace(/\n/g, ''), bytes = Buffer.from(encoded, 'base64');
    if (content.path !== licenseEntry.path || content.sha !== licenseEntry.sha || content.size !== licenseEntry.size ||
      bytes.length !== licenseEntry.size || bytes.toString('base64') !== encoded || hashBlob(bytes) !== licenseEntry.sha)
      throw new Error('License byte/tree identity verification failed');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('License is not strict UTF-8 text'); }
    if (bytes.includes(0) || !text.trim() || !Buffer.from(text).equals(bytes)) throw new Error('License is not nonempty text');
    readBytes += bytes.length;
    const identity = (commit: string): GithubSourceIdentity => ({ commit, tree: rootTrees.get(commit)!, observation: commitObservations.get(commit)! });
    sourceProvenance = { sourceIdentities: { baseTip: { ...identity(initial.baseTip), role: 'current-tip-metadata-only-not-source' },
      mergeBase: identity(mergeBase), head: identity(initial.head) },
    license: { sourceRef: initial.head, path: licenseEntry.path, text, blobSha1: licenseEntry.sha, sha256: sha256(bytes),
      observation: { ...response.observation, data: response.data as Record<string, unknown> }, treeObservation: treeObservations.get(headTree)! },
    sourceTrees: [...treeObservations.values()] };
  }
  const pages = async <T extends { id: number }>(endpoint: string, get: (page: number, request: { signal: AbortSignal; redirect: 'error' }) => Promise<Response<unknown>>, parse: (data: any) => T): Promise<T[]> => {
    const rows: T[] = [], ids = new Set<number>();
    for (let page = 1; page <= 3; page++) {
      const response = await read(`${endpoint}?page=${page}&per_page=100`, request => get(page, request));
      const data = z.array(z.unknown()).max(100).parse(response.data);
      for (const item of data) { const row = parse(item); if (ids.has(row.id)) throw new Error('Duplicate discussion ID across pages'); ids.add(row.id); rows.push(row); }
      if (Buffer.byteLength(JSON.stringify(rows)) > 2_000_000) throw new Error('Discussion evidence exceeds 2MB');
      // Only follow locally constructed numbered requests. Never request URLs supplied in Link headers.
      const hasNext = /;\s*rel="next"/.test(String(response.headers.link ?? ''));
      if (!hasNext) return rows.sort((a, b) => a.id - b.id);
      if (data.length !== 100) throw new Error('Inconsistent discussion pagination');
    }
    throw new Error('Discussion pagination limit reached; no truncated evidence produced');
  };
  const issueComments = await pages(`GET /repos/${owner}/${repo}/issues/${initial.number}/comments`, (page, request) => client.rest.issues.listComments({ owner, repo, issue_number: initial.number, page, per_page: 100, request }), issueComment);
  const reviews = await pages(`GET /repos/${owner}/${repo}/pulls/${initial.number}/reviews`, (page, request) => client.rest.pulls.listReviews({ owner, repo, pull_number: initial.number, page, per_page: 100, request }), review);
  const reviewComments = await pages(`GET /repos/${owner}/${repo}/pulls/${initial.number}/comments`, (page, request) => client.rest.pulls.listReviewComments({ owner, repo, pull_number: initial.number, page, per_page: 100, request }), reviewComment);
  const final = await getPull();
  if (digestOf(final) !== digestOf(initial)) throw new Error('PR changed during acquisition; no evidence produced');
  const stored = validateGithubPrEvidence(GithubPrEvidenceSchema.parse({ schemaVersion: 1, kind: 'github-pr-evidence', snapshotDigest: frozen.digest, snapshot: frozen.snapshot, pull: initial,
    source: { provider: 'github', apiOrigin: 'https://api.github.com', observation: 'current-api-state', historicalReviewCheckpoint: false,
      ancestry: 'provider-declared', inventory: 'provider-declared-compare', repositoryContext: 'changed-paths-only',
      discussionConsistency: 'non-atomic-current-observation', discussionCoverage: 'all-pages-returned-within-limits', compareFileCount: files.length,
      sourceStatements: 'untrusted-not-ground-truth-or-feedback' }, discussions: { issueComments, reviews, reviewComments } }));
  return { ...stored, ...(sourceProvenance ? { sourceProvenance } : {}), receipt: GithubAcquisitionReceiptSchema.parse({ kind: 'github-api-observation', startedAt, completedAt: new Date().toISOString(),
    authentication: 'none', transport: '@octokit/rest@22.0.1', verification: 'live-api-observation-not-verified-history', requestLimit: options.maxRequests, requests, decodedResponseBytes, observations }) };
}
