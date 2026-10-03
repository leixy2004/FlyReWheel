import { createHash } from 'node:crypto';
import { z } from 'zod';

export const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const GitDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const GitSizeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const gitUtf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
export const gitSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const gitBlobId = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
export const GitPathSchema = z.string().min(1).max(4096).refine(path =>
  Buffer.byteLength(path) <= 4096 && !path.includes('\0') && !path.includes('\\') &&
  !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..') &&
  gitUtf8(Buffer.from(path)) === path, 'Unsupported or non-normalized UTF-8 repository-relative path');
const ExistingSide = z.object({ path: GitPathSchema, mode: z.string().regex(/^[0-7]{6}$/), objectId: GitShaSchema });
export const GitBlobSideSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('absent') }).strict(),
  ExistingSide.extend({
    state: z.literal('captured'), mode: z.enum(['100644', '100755']),
    byteLength: GitSizeSchema.max(262_144), sha256: GitDigestSchema, bytesBase64: z.string().max(349_528),
  }).strict(),
  ExistingSide.extend({
    state: z.literal('excluded'),
    reason: z.enum(['binary', 'oversize', 'total-byte-limit', 'symlink', 'submodule', 'unsupported-mode']),
    byteLength: GitSizeSchema.nullable(), sha256: GitDigestSchema.nullable(),
  }).strict(),
]);
export type GitBlobSide = z.infer<typeof GitBlobSideSchema>;

/** Object identity consistency independent of per-package capture order and limits. */
export function validateGitObjectDeclarations(sides: readonly GitBlobSide[], invalid: (message: string) => void) {
  const objects = new Map<string, { type: string; size: number | null; digest: string | null; text: boolean; binary: boolean }>();
  for (const side of sides) {
    if (side.state === 'absent') continue;
    const known = objects.get(side.objectId);
    const observed = { type: side.mode === '160000' ? 'commit' : 'blob', size: side.byteLength, digest: side.sha256,
      text: side.state === 'captured', binary: side.state === 'excluded' && side.reason === 'binary' };
    if (known && (known.type !== observed.type || known.size !== observed.size ||
        (known.digest !== null && observed.digest !== null && known.digest !== observed.digest) ||
        (known.text && observed.binary) || (known.binary && observed.text))) invalid('Contradictory declarations for one Git object ID');
    objects.set(side.objectId, { ...observed, digest: observed.digest ?? known?.digest ?? null,
      text: observed.text || !!known?.text, binary: observed.binary || !!known?.binary });
  }
}

/** Shared snapshot/context byte invariants, applied in canonical capture order. */
export function validateGitBlobSides(
  sides: readonly GitBlobSide[], limits: { maxBlobBytes: number; maxTotalBytes: number }, invalid: (message: string) => void,
) {
  let capturedSides = 0, excludedSides = 0, capturedBytes = 0;
  validateGitObjectDeclarations(sides, invalid);
  for (const side of sides) {
    if (side.state === 'absent') continue;
    if (/^0+$/.test(side.objectId) || side.mode === '000000') invalid('Present side needs a real Git object and mode');
    if (side.state === 'captured') {
      capturedSides++; capturedBytes += side.byteLength;
      const bytes = Buffer.from(side.bytesBase64, 'base64');
      if (bytes.toString('base64') !== side.bytesBase64 || bytes.length !== side.byteLength ||
          gitSha256(bytes) !== side.sha256 || gitBlobId(bytes) !== side.objectId) invalid('Captured blob integrity check failed');
      try { gitUtf8(bytes); if (bytes.includes(0)) invalid('Binary bytes cannot be labeled captured UTF-8 text'); }
      catch { invalid('Captured text must be strict UTF-8'); }
      if (side.byteLength > limits.maxBlobBytes) invalid('Captured blob exceeds declared byte limit');
    } else {
      excludedSides++;
      const regular = ['100644', '100755'].includes(side.mode);
      if (side.reason === 'submodule') {
        if (side.mode !== '160000' || side.byteLength !== null || side.sha256 !== null) invalid('Submodule coverage cannot claim blob bytes');
      } else {
        if (side.byteLength === null) invalid('Excluded blob size must be known');
        if (side.reason === 'symlink' && side.mode !== '120000') invalid('Symlink exclusion requires symlink mode');
        if (['binary', 'oversize', 'total-byte-limit'].includes(side.reason) && !regular) invalid('Regular-file exclusion requires regular mode');
        if (side.reason === 'unsupported-mode' && ['100644', '100755', '120000', '160000'].includes(side.mode)) invalid('Known mode cannot be labeled unsupported');
        if (side.reason === 'oversize' && side.byteLength! <= limits.maxBlobBytes) invalid('Oversize exclusion is below declared limit');
        if (['binary', 'total-byte-limit'].includes(side.reason) && side.byteLength! > limits.maxBlobBytes) invalid('Exclusion exceeds per-blob limit');
        if (side.reason === 'total-byte-limit' && capturedBytes + side.byteLength! <= limits.maxTotalBytes) invalid('Budget exclusion fits declared remaining byte budget');
        if (side.reason !== 'binary' && side.sha256 !== null) invalid('Unread excluded bytes cannot claim a SHA-256');
        if (side.reason === 'binary' && side.sha256 === null) invalid('Read binary bytes require their computed SHA-256');
      }
    }
  }
  if (capturedBytes > limits.maxTotalBytes) invalid('Total captured-byte limit exceeded');
  return { capturedSides, excludedSides, capturedBytes };
}
