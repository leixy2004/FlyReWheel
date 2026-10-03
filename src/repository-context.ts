import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { digestOf } from './core/identity.js';
import { SpanSchema, sourcePosition } from './adapters/candidates.js';
import { ChangeSnapshotSchema, SnapshotReceiptSchema, validateChangeSnapshot, type StoredChangeSnapshot } from './change-snapshot.js';
import { GitShaSchema, GitDigestSchema, GitSizeSchema, GitPathSchema, GitBlobSideSchema, gitUtf8, gitSha256, gitBlobId, validateGitBlobSides, type GitBlobSide } from './git-object-evidence.js';
import { openGitEvidenceRepository } from './git-evidence-repository.js';

/** A bounded selected-file supplement, not a repository archive or semantic review. */
export const REPOSITORY_CONTEXT_MAX_JSON_BYTES = 5_000_000;
export const DEFAULT_REPOSITORY_CONTEXT_LIMITS = { maxPaths: 128, maxBlobBytes: 262_144, maxTotalBytes: 2_097_152 };
export const RepositoryContextLimitsSchema = z.object({
  maxPaths: z.number().int().min(1).max(128),
  maxBlobBytes: z.number().int().min(1).max(262_144),
  maxTotalBytes: z.number().int().min(1).max(2_097_152),
}).strict();
const DirectoryEntrySchema = z.object({
  state: z.literal('excluded'), path: GitPathSchema, mode: z.literal('040000'), objectId: GitShaSchema,
  reason: z.literal('directory'), byteLength: z.null(), sha256: z.null(),
}).strict();
export const RepositoryContextEntrySchema = z.union([
  GitBlobSideSchema.options[1], GitBlobSideSchema.options[2], DirectoryEntrySchema,
  z.object({ state: z.literal('missing'), path: GitPathSchema }).strict(),
]);
export type RepositoryContextEntry = z.infer<typeof RepositoryContextEntrySchema>;
function isBlobSide(entry: RepositoryContextEntry): entry is Exclude<GitBlobSide, { state: 'absent' }> {
  return entry.state !== 'missing' && !(entry.state === 'excluded' && entry.reason === 'directory');
}
const pathOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const RepositoryContextSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('git-repository-context'),
  repository: ChangeSnapshotSchema.shape.repository, head: GitShaSchema,
  selection: z.literal('explicit-paths-at-head'), limits: RepositoryContextLimitsSchema,
  entries: z.array(RepositoryContextEntrySchema).min(1).max(128),
  coverage: z.object({
    selectedPaths: GitSizeSchema.max(128), capturedPaths: GitSizeSchema.max(128), excludedPaths: GitSizeSchema.max(128),
    missingPaths: GitSizeSchema.max(128), capturedBytes: GitSizeSchema.max(2_097_152),
    scope: z.literal('selected-paths-only'), historicalAvailability: z.literal('unproven'),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.entries.length > value.limits.maxPaths) invalid('Selected path count exceeds declared limit');
  const entries = new Map<string, RepositoryContextEntry>();
  const directoryObjects = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    if (index && pathOrder(value.entries[index - 1].path, entry.path) >= 0) invalid('Selected paths must be unique and in canonical UTF-8 byte order');
    entries.set(entry.path, entry);
    if (entry.state === 'excluded' && entry.reason === 'directory') {
      if (/^0+$/.test(entry.objectId)) invalid('Directory needs a real Git tree object ID');
      directoryObjects.add(entry.objectId);
    }
    // Directory objects have their own explicit exclusion; they are never treated as blobs.
    if (isBlobSide(entry) && entry.mode === '040000') invalid('Tree mode requires an explicit directory exclusion');
  }
  for (const entry of value.entries) {
    if (isBlobSide(entry) && directoryObjects.has(entry.objectId)) invalid('One Git object cannot be both tree and blob/commit');
    const components = entry.path.split('/');
    for (let i = 1; i < components.length; i++) {
      const parent = entries.get(components.slice(0, i).join('/'));
      if (parent && (parent.state === 'missing' || parent.mode !== '040000') && entry.state !== 'missing') invalid('Selected child conflicts with a missing or non-directory parent');
    }
  }
  const counts = validateGitBlobSides(value.entries.filter(isBlobSide), value.limits, invalid);
  const expected = {
    selectedPaths: value.entries.length, capturedPaths: counts.capturedSides,
    excludedPaths: value.entries.filter(entry => entry.state === 'excluded').length,
    missingPaths: value.entries.filter(entry => entry.state === 'missing').length, capturedBytes: counts.capturedBytes,
    scope: 'selected-paths-only', historicalAvailability: 'unproven',
  };
  if (digestOf(expected) !== digestOf(value.coverage)) invalid('Repository context coverage counters disagree with evidence');
  if (Buffer.byteLength(JSON.stringify(value)) > 4_000_000) invalid('Encoded repository context exceeds 4MB');
});
export type RepositoryContext = z.infer<typeof RepositoryContextSchema>;
export type StoredRepositoryContext = { digest: string; context: RepositoryContext };
export const RepositoryContextPackageSchema = z.object({
  digest: GitDigestSchema, context: RepositoryContextSchema, receipt: SnapshotReceiptSchema.optional(),
}).strict().refine(value => digestOf(value.context) === value.digest, 'Repository context digest mismatch');
export function validateRepositoryContext(input: unknown): StoredRepositoryContext {
  const context = RepositoryContextSchema.parse(input);
  return { digest: digestOf(context), context };
}
function checkedContext(input: StoredRepositoryContext): StoredRepositoryContext {
  const value = validateRepositoryContext(input.context);
  if (value.digest !== input.digest) throw new Error('Stored repository context digest mismatch');
  return value;
}

/** Read at most 5MB+1 even if a package changes after stat; never follow package receipts as authority. */
export async function readRepositoryContextPackage(file: string) {
  // A FIFO must not block open() before its non-regular type can be rejected.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Repository context package must be a regular file');
    if (stat.size > REPOSITORY_CONTEXT_MAX_JSON_BYTES) throw new Error('Repository context package exceeds 5MB');
    const bytes = Buffer.alloc(REPOSITORY_CONTEXT_MAX_JSON_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > REPOSITORY_CONTEXT_MAX_JSON_BYTES) throw new Error('Repository context package exceeds 5MB');
    return RepositoryContextPackageSchema.parse(JSON.parse(gitUtf8(bytes.subarray(0, length))));
  } finally { await handle.close(); }
}

const CaptureInputSchema = z.object({
  repositoryPath: z.string().min(1), repositoryId: z.string().min(1).max(300), head: GitShaSchema,
  paths: z.array(GitPathSchema).min(1).max(128).refine(paths => new Set(paths).size === paths.length, 'Duplicate selected paths'),
  limits: RepositoryContextLimitsSchema.optional(),
}).strict();
export type CaptureRepositoryContextInput = z.infer<typeof CaptureInputSchema>;

/** No worktree reads, recursion, glob expansion, checkout, LFS, hooks, filters, submodule traversal or network. */
export async function captureRepositoryContext(input: CaptureRepositoryContextInput) {
  const deadline = Date.now() + 120_000;
  const options = CaptureInputSchema.parse(input), limits = options.limits ?? { ...DEFAULT_REPOSITORY_CONTEXT_LIMITS };
  if (options.paths.length > limits.maxPaths) throw new Error('Selected path count exceeds declared limit; no truncated context was produced');
  const { repositoryPath, gitCommonDirectory, gitBytes, git } = await openGitEvidenceRepository(options.repositoryPath, [options.head], deadline, 'Repository context');
  const entries: RepositoryContextEntry[] = [];
  let capturedBytes = 0, readBytes = 0;
  for (const path of [...options.paths].sort(pathOrder)) {
    // No -r: selecting a directory returns its tree entry, not its descendants.
    const record = await gitBytes('--literal-pathspecs', 'ls-tree', '--full-tree', '-z', options.head, '--', path);
    if (!record.length) { entries.push({ state: 'missing', path }); continue; }
    const text = gitUtf8(record);
    const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40})\t([^\0]+)\0$/.exec(text);
    if (!match || match[4] !== path) throw new Error('Git did not return exactly the selected literal repository path');
    const [, mode, type, objectId] = match;
    const base = { path, mode, objectId };
    const exclude = (reason: Extract<GitBlobSide, { state: 'excluded' }>['reason'], byteLength: number | null, sha256: string | null = null) =>
      entries.push({ ...base, state: 'excluded', reason, byteLength, sha256 });
    if (mode === '040000' && type === 'tree') {
      entries.push({ ...base, state: 'excluded', mode: '040000', reason: 'directory', byteLength: null, sha256: null }); continue;
    }
    if (mode === '160000' && type === 'commit') { exclude('submodule', null); continue; }
    if (type !== 'blob' || (await git('cat-file', '-t', objectId)).trim() !== 'blob') throw new Error('Selected entry did not identify a locally present blob');
    const sizeText = (await git('cat-file', '-s', objectId)).trim();
    if (!/^(0|[1-9][0-9]*)$/.test(sizeText)) throw new Error('Invalid Git blob size');
    const size = GitSizeSchema.parse(Number(sizeText));
    if (mode === '120000') { exclude('symlink', size); continue; }
    if (!['100644', '100755'].includes(mode)) { exclude('unsupported-mode', size); continue; }
    if (size > limits.maxBlobBytes) { exclude('oversize', size); continue; }
    if (capturedBytes + size > limits.maxTotalBytes) { exclude('total-byte-limit', size); continue; }
    if (readBytes + size > 8_388_608) throw new Error('Repository context blob-read budget exceeds 8MiB; no context was produced');
    const bytes = await gitBytes('cat-file', 'blob', objectId);
    readBytes += bytes.length;
    if (bytes.length !== size || gitBlobId(bytes) !== objectId) throw new Error('Committed context blob identity/size check failed');
    const sha256 = gitSha256(bytes);
    try { gitUtf8(bytes); if (bytes.includes(0)) { exclude('binary', size, sha256); continue; } }
    catch { exclude('binary', size, sha256); continue; }
    capturedBytes += size;
    entries.push({ ...base, mode: mode as '100644' | '100755', state: 'captured', byteLength: size, sha256, bytesBase64: bytes.toString('base64') });
  }
  const stored = validateRepositoryContext({
    schemaVersion: 1, kind: 'git-repository-context',
    repository: { id: options.repositoryId, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    head: options.head, selection: 'explicit-paths-at-head', limits, entries,
    coverage: { selectedPaths: entries.length, capturedPaths: entries.filter(entry => entry.state === 'captured').length,
      excludedPaths: entries.filter(entry => entry.state === 'excluded').length, missingPaths: entries.filter(entry => entry.state === 'missing').length,
      capturedBytes, scope: 'selected-paths-only', historicalAvailability: 'unproven' },
  });
  return { ...stored, receipt: SnapshotReceiptSchema.parse({ kind: 'local-git-check', checkedAt: new Date().toISOString(), repositoryPath, gitCommonDirectory }) };
}

/** Recompute from exact local Git objects. A receipt copied from an import is never enough. */
export async function verifyRepositoryContext(input: StoredRepositoryContext, repositoryPath: string) {
  const value = checkedContext(input);
  const checked = await captureRepositoryContext({ repositoryPath, repositoryId: value.context.repository.id,
    head: value.context.head, paths: value.context.entries.map(entry => entry.path), limits: value.context.limits });
  if (checked.digest !== value.digest) throw new Error('Repository context does not match the exact local Git commit/path bindings');
  return checked;
}

/** Preflight only, not semantic acceptance. Same bytes at a future/different commit are still forbidden. */
export function validateRepositoryContextForSnapshot(input: StoredRepositoryContext, snapshotInput: StoredChangeSnapshot) {
  const value = checkedContext(input), snapshot = validateChangeSnapshot(snapshotInput.snapshot);
  if (snapshot.digest !== snapshotInput.digest) throw new Error('Stored snapshot digest mismatch');
  if (value.context.head !== snapshot.snapshot.head || digestOf(value.context.repository) !== digestOf(snapshot.snapshot.repository)) {
    throw new Error('Repository context must bind to this exact snapshot repository and review head');
  }
  for (const entry of value.context.entries) {
    // A deleted path may also be the destination of an exact rename. Prefer its present head entry.
    const side = snapshot.snapshot.changes.map(change => change.after).find(side => side.state !== 'absent' && side.path === entry.path);
    if (!side || side.state === 'absent') {
      const removed = snapshot.snapshot.changes.some(change => change.before.state !== 'absent' && change.before.path === entry.path);
      if (removed && entry.state !== 'missing') throw new Error('Repository context conflicts with an absent snapshot head path');
    } else if (entry.state === 'missing' || side.mode !== entry.mode || side.objectId !== entry.objectId
      || (side.byteLength !== null && entry.byteLength !== null && side.byteLength !== entry.byteLength)
      || (side.sha256 !== null && entry.sha256 !== null && side.sha256 !== entry.sha256)
      || (side.state === 'captured' && entry.state === 'excluded' && entry.reason === 'binary')
      || (side.state === 'excluded' && side.reason === 'binary' && entry.state === 'captured')) {
      throw new Error('Repository context conflicts with a snapshot head entry');
    }
  }
  return { snapshotDigest: snapshot.digest, contextDigest: value.digest, repositoryId: value.context.repository.id, head: value.context.head };
}

/** Mirrors snapshot UTF-16, end-exclusive spans, with an explicitly different anchor kind. */
export const RepositoryContextAnchorSchema = z.object({
  kind: z.literal('repository-context'), contextDigest: GitDigestSchema, repositoryId: z.string().min(1).max(300), head: GitShaSchema,
  path: GitPathSchema, objectId: GitShaSchema, mode: z.enum(['100644', '100755']), sourceDigest: GitDigestSchema, span: SpanSchema,
}).strict();
export type RepositoryContextAnchor = z.infer<typeof RepositoryContextAnchorSchema>;
const ContextKind = z.string().min(1).max(16_384).refine(value => !!value.trim(), 'Expected nonblank context kind');
export const RepositoryContextEvidenceSchema = z.object({
  id: GitDigestSchema, kind: ContextKind, anchor: RepositoryContextAnchorSchema, content: z.string().min(1).max(262_144),
}).strict();
export type RepositoryContextEvidence = z.infer<typeof RepositoryContextEvidenceSchema>;
function capturedEntry(context: StoredRepositoryContext, path: string) {
  const entry = context.context.entries.find(entry => entry.path === path);
  if (!entry || entry.state !== 'captured') throw new Error('Repository context has no captured source at the selected path');
  return entry;
}
export function repositoryContextSource(input: StoredRepositoryContext, path: string): string {
  const context = checkedContext(input);
  return gitUtf8(Buffer.from(capturedEntry(context, path).bytesBase64, 'base64'));
}
export function validateRepositoryContextAnchor(input: RepositoryContextAnchor, contextInput: StoredRepositoryContext): string {
  const anchor = RepositoryContextAnchorSchema.parse(input), value = checkedContext(contextInput);
  const entry = capturedEntry(value, anchor.path);
  if (anchor.contextDigest !== value.digest || anchor.repositoryId !== value.context.repository.id || anchor.head !== value.context.head
    || anchor.sourceDigest !== entry.sha256 || anchor.objectId !== entry.objectId || anchor.mode !== entry.mode) throw new Error('Repository context anchor identity mismatch');
  const source = gitUtf8(Buffer.from(entry.bytesBase64, 'base64'));
  if (anchor.span.end.offset <= anchor.span.start.offset) throw new Error('Repository context anchor must be nonempty');
  for (const side of ['start', 'end'] as const) {
    if (digestOf(sourcePosition(source, anchor.span[side].offset)) !== digestOf(anchor.span[side])) throw new Error('Context anchor position does not match its exact source offset');
  }
  return source.slice(anchor.span.start.offset, anchor.span.end.offset);
}
export function makeRepositoryContextAnchor(input: StoredRepositoryContext, path: string, start: number, end: number): RepositoryContextAnchor {
  const value = checkedContext(input), entry = capturedEntry(value, path), source = gitUtf8(Buffer.from(entry.bytesBase64, 'base64'));
  const anchor: RepositoryContextAnchor = { kind: 'repository-context', contextDigest: value.digest, repositoryId: value.context.repository.id,
    head: value.context.head, path, objectId: entry.objectId, mode: entry.mode, sourceDigest: entry.sha256,
    span: { start: sourcePosition(source, start), end: sourcePosition(source, end) } };
  validateRepositoryContextAnchor(anchor, value);
  return anchor;
}
export function makeRepositoryContextEvidence(context: StoredRepositoryContext, anchor: RepositoryContextAnchor, kind: string): RepositoryContextEvidence {
  const value = { kind, anchor, content: validateRepositoryContextAnchor(anchor, context) };
  return RepositoryContextEvidenceSchema.parse({ id: digestOf(value), ...value });
}
export function validateRepositoryContextEvidence(input: RepositoryContextEvidence, context: StoredRepositoryContext): RepositoryContextEvidence {
  const value = RepositoryContextEvidenceSchema.parse(input), { id, ...identity } = value;
  if (validateRepositoryContextAnchor(value.anchor, context) !== value.content || digestOf(identity) !== id) throw new Error('Repository context evidence identity/excerpt mismatch');
  return value;
}
