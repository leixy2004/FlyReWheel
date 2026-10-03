import { z } from 'zod';
import { digestOf } from './core/identity.js';
import { openGitEvidenceRepository } from './git-evidence-repository.js';
import { GitShaSchema as Sha, GitSizeSchema as Size, GitDigestSchema as Digest, GitPathSchema as Path, GitBlobSideSchema as Side,
  gitUtf8 as utf8, gitSha256 as sha256, gitBlobId as blobId, validateGitBlobSides, type GitBlobSide as SnapshotSide } from './git-object-evidence.js';

/** Deliberately bounded evidence, not a repository archive or a review result. */
export const SNAPSHOT_MAX_JSON_BYTES = 5_000_000;
const MAX_SNAPSHOT_CONTENT_JSON_BYTES = 4_000_000;
export const SnapshotLimitsSchema = z.object({
  maxChanges: z.number().int().min(1).max(500),
  maxBlobBytes: z.number().int().min(1).max(262_144),
  maxTotalBytes: z.number().int().min(1).max(2_097_152),
}).strict();
export const DEFAULT_SNAPSHOT_LIMITS = { maxChanges: 500, maxBlobBytes: 262_144, maxTotalBytes: 2_097_152 };
const Change = z.object({ status: z.enum(['A', 'D', 'M', 'T', 'R100']), before: Side, after: Side }).strict();
function changeOrder(a: z.infer<typeof Change>, b: z.infer<typeof Change>) {
  const keys = (change: z.infer<typeof Change>) => {
    const before = change.before.state === 'absent' ? '' : change.before.path;
    const after = change.after.state === 'absent' ? '' : change.after.path;
    return [after || before, change.status, before, after];
  };
  const left = keys(a), right = keys(b);
  for (let i = 0; i < left.length; i++) {
    const order = Buffer.compare(Buffer.from(left[i]), Buffer.from(right[i]));
    if (order) return order;
  }
  return 0;
}
const PrMetadata = z.object({
  verification: z.literal('caller-supplied-unverified'),
  provider: z.string().min(1).max(100), repository: z.string().min(1).max(300),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  url: z.string().url().max(2048).optional(),
  // A caller's timestamp is not evidence of what was visible at review time.
  declaredVisibleAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export const ChangeSnapshotSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('git-change-snapshot'),
  repository: z.object({ id: z.string().min(1).max(300), identityVerification: z.literal('caller-supplied-unverified'), objectFormat: z.literal('sha1') }).strict(),
  baseTip: Sha, mergeBase: Sha, head: Sha,
  comparison: z.literal('merge-base-to-head'), renamePolicy: z.literal('exact-content-only'),
  limits: SnapshotLimitsSchema, prMetadata: PrMetadata.optional(),
  changes: z.array(Change).max(500),
  coverage: z.object({
    changedPaths: Size.max(500), capturedSides: Size.max(1000), excludedSides: Size.max(1000), capturedBytes: Size.max(2_097_152),
    scope: z.literal('changed-entries-only'),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.changes.length > value.limits.maxChanges) invalid('Changed-entry limit exceeded');
  const oldPaths = new Set<string>(), newPaths = new Set<string>();
  let previousChange: z.infer<typeof Change> | undefined;
  for (const change of value.changes) {
    const before = change.before, after = change.after;
    const presentBefore = before.state !== 'absent', presentAfter = after.state !== 'absent';
    if ((change.status === 'A' && (presentBefore || !presentAfter)) ||
        (change.status === 'D' && (!presentBefore || presentAfter)) ||
        (!['A', 'D'].includes(change.status) && (!presentBefore || !presentAfter))) invalid('Status and side presence disagree');
    if (presentBefore && presentAfter) {
      if ((change.status === 'R100') !== (before.path !== after.path)) invalid('Only exact renames have differing paths');
      if (change.status === 'R100' && before.objectId !== after.objectId) invalid('Exact rename requires identical object IDs');
      const sameType = before.mode.slice(0, 3) === after.mode.slice(0, 3);
      if (change.status === 'R100' && !sameType) invalid('Exact rename requires matching Git object types');
      if (change.status === 'T' && sameType) invalid('Type change requires differing Git object types');
      if (change.status === 'M' && (!sameType || (before.mode === after.mode && before.objectId === after.objectId))) invalid('Modification must change content or regular-file mode');
    }
    if (previousChange && changeOrder(previousChange, change) >= 0) invalid('Changes must have canonical path/status ordering');
    previousChange = change;
    for (const [side, paths] of [[before, oldPaths], [after, newPaths]] as const) {
      if (side.state === 'absent') continue;
      if (paths.has(side.path)) invalid('Duplicate changed side path');
      paths.add(side.path);
    }
  }
  const { capturedSides, excludedSides, capturedBytes } = validateGitBlobSides(value.changes.flatMap(change => [change.before, change.after]), value.limits, invalid);
  const expected = { changedPaths: value.changes.length, capturedSides, excludedSides, capturedBytes, scope: 'changed-entries-only' };
  if (digestOf(expected) !== digestOf(value.coverage)) invalid('Coverage counters disagree with evidence');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SNAPSHOT_CONTENT_JSON_BYTES) invalid('Encoded snapshot content exceeds 4MB');
});
export type ChangeSnapshot = z.infer<typeof ChangeSnapshotSchema>;
export type StoredChangeSnapshot = { digest: string; snapshot: ChangeSnapshot };

export const SnapshotReceiptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('package-integrity-only') }).strict(),
  z.object({ kind: z.literal('local-git-check'), checkedAt: z.string().datetime(), repositoryPath: z.string().max(4096), gitCommonDirectory: z.string().max(4096) }).strict(),
]);
/** Receipts in files are untrusted declarations; an import never adopts their verification level. */
export const ChangeSnapshotPackageSchema = z.object({ digest: Digest, snapshot: ChangeSnapshotSchema, receipt: SnapshotReceiptSchema.optional() }).strict()
  .refine(value => digestOf(value.snapshot) === value.digest, 'Snapshot digest mismatch');
export function validateChangeSnapshot(input: unknown): StoredChangeSnapshot {
  const snapshot = ChangeSnapshotSchema.parse(input);
  return { digest: digestOf(snapshot), snapshot };
}
export const integrityReceipt = { kind: 'package-integrity-only' as const };

const CaptureInput = z.object({
  repositoryPath: z.string().min(1), repositoryId: z.string().min(1).max(300), baseTip: Sha, head: Sha,
  limits: SnapshotLimitsSchema.optional(), prMetadata: PrMetadata.optional(),
}).strict();
export type CaptureChangeSnapshotInput = z.infer<typeof CaptureInput>;

/** Reads only installed Git/object data. No worktree, hooks, external diff, checkout filters or network. */
export async function captureChangeSnapshot(input: CaptureChangeSnapshotInput) {
  const deadline = Date.now() + 120_000;
  const options = CaptureInput.parse(input), limits = options.limits ?? { ...DEFAULT_SNAPSHOT_LIMITS };
  const { repositoryPath, gitCommonDirectory, gitBytes, git } = await openGitEvidenceRepository(options.repositoryPath, [options.baseTip, options.head], deadline, 'Snapshot');
  const bases = (await git('merge-base', '--all', options.baseTip, options.head)).trim().split('\n');
  if (bases.length !== 1 || !Sha.safeParse(bases[0]).success) throw new Error('Snapshot requires exactly one common merge base');
  const mergeBase = bases[0];
  const raw = await gitBytes('-c', 'diff.renameLimit=500', 'diff-tree', '--no-commit-id', '--raw', '-z', '-r', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--find-renames=100%', mergeBase, options.head, '--');
  const tokens = utf8(raw).split('\0');
  if (tokens.pop() !== '' && raw.length) throw new Error('Incomplete Git diff inventory');
  const inventory: { status: z.infer<typeof Change>['status']; before: SnapshotSide; after: SnapshotSide }[] = [];
  while (tokens.length) {
    const header = tokens.shift()!;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) (A|D|M|T|R100)$/.exec(header);
    if (!match) throw new Error('Unsupported Git raw change record');
    const [, oldMode, newMode, oldId, newId, status] = match;
    const oldPath = Path.parse(tokens.shift()), newPath = status === 'R100' ? Path.parse(tokens.shift()) : oldPath;
    const side = (mode: string, objectId: string, path: string): SnapshotSide => mode === '000000'
      ? { state: 'absent' }
      : { state: 'excluded', path, mode, objectId, reason: 'unsupported-mode', byteLength: null, sha256: null };
    inventory.push({ status: status as z.infer<typeof Change>['status'], before: side(oldMode, oldId, oldPath), after: side(newMode, newId, newPath) });
    if (inventory.length > limits.maxChanges) throw new Error(`Change count exceeds ${limits.maxChanges}; no truncated snapshot was stored`);
  }
  inventory.sort(changeOrder);
  let capturedBytes = 0, readBytes = 0;
  const captureSide = async (side: SnapshotSide): Promise<SnapshotSide> => {
    if (side.state === 'absent') return side;
    const base = { path: side.path, mode: side.mode, objectId: side.objectId };
    const exclude = (reason: Extract<SnapshotSide, { state: 'excluded' }>['reason'], byteLength: number | null, digest: string | null = null): SnapshotSide =>
      ({ ...base, state: 'excluded', reason, byteLength, sha256: digest });
    if (side.mode === '160000') return exclude('submodule', null); // Gitlink target need not exist locally.
    if ((await git('cat-file', '-t', side.objectId)).trim() !== 'blob') throw new Error('Changed entry did not identify a locally present blob');
    const sizeText = (await git('cat-file', '-s', side.objectId)).trim();
    if (!/^(0|[1-9][0-9]*)$/.test(sizeText)) throw new Error('Invalid Git blob size');
    const size = Size.parse(Number(sizeText));
    if (side.mode === '120000') return exclude('symlink', size);
    if (!['100644', '100755'].includes(side.mode)) return exclude('unsupported-mode', size);
    if (size > limits.maxBlobBytes) return exclude('oversize', size);
    if (capturedBytes + size > limits.maxTotalBytes) return exclude('total-byte-limit', size);
    if (readBytes + size > 8_388_608) throw new Error('Snapshot blob-read budget exceeds 8MiB; no snapshot produced');
    const bytes = await gitBytes('cat-file', 'blob', side.objectId);
    readBytes += bytes.length;
    if (bytes.length !== size || blobId(bytes) !== side.objectId) throw new Error('Committed blob identity/size check failed');
    const digest = sha256(bytes);
    try { utf8(bytes); if (bytes.includes(0)) return exclude('binary', size, digest); }
    catch { return exclude('binary', size, digest); }
    capturedBytes += bytes.length;
    return { ...base, mode: side.mode as '100644' | '100755', state: 'captured', byteLength: bytes.length, sha256: digest, bytesBase64: bytes.toString('base64') };
  };
  for (const change of inventory) { change.before = await captureSide(change.before); change.after = await captureSide(change.after); }
  const sides = inventory.flatMap(change => [change.before, change.after]);
  const stored = validateChangeSnapshot({
    schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: options.repositoryId, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: options.baseTip, mergeBase, head: options.head, comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only',
    limits, ...(options.prMetadata ? { prMetadata: options.prMetadata } : {}), changes: inventory,
    coverage: { changedPaths: inventory.length, capturedSides: sides.filter(side => side.state === 'captured').length,
      excludedSides: sides.filter(side => side.state === 'excluded').length, capturedBytes, scope: 'changed-entries-only' },
  });
  return { ...stored, receipt: SnapshotReceiptSchema.parse({ kind: 'local-git-check', checkedAt: new Date().toISOString(), repositoryPath, gitCommonDirectory }) };
}
