import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { digestOf } from './core/identity.js';
import { DigestSchema } from './core/model.js';
import { prepareWorkspace, inspectWorkspace, cleanupWorkspace } from './workspace/index.js';
import { PreparedWorkspaceResolverConfigSchema, createPreparedWorkspaceResolver } from './prepared-workspace-resolver.js';

const Entry = PreparedWorkspaceResolverConfigSchema.shape.entries.element;
export const LocalDevelopmentWorkspaceInputSchema = z.object({ repoPath: Entry.shape.workspace.shape.repoPath, selection: Entry.shape.selection }).strict()
  .refine(value => value.selection.expectedSha === (value.selection.kind === 'pr-mining' ? value.selection.baseSha : value.selection.headSha), 'Selection checkout must match its operation');
const Receipt = z.object({ schemaVersion: z.literal(1), kind: z.literal('local-development-workspace'), ownerId: z.uuid(),
  workspace: Entry.shape.workspace, selection: Entry.shape.selection, preparedManifestDigest: DigestSchema, createdEvidenceDigest: DigestSchema,
  isolation: z.literal('none'), modelExecution: z.literal('not_run'), productionAuthority: z.literal('not_provided'),
}).strict().refine(value => value.workspace.runId === 'local-development' && value.workspace.attemptId === value.ownerId.replaceAll('-', ''), 'Invalid development-owned identity');
export const StoredLocalDevelopmentWorkspaceSchema = z.object({ digest: DigestSchema, receipt: Receipt }).strict()
  .refine(value => digestOf(value.receipt) === value.digest, 'Development receipt digest mismatch');
export type StoredLocalDevelopmentWorkspace = z.infer<typeof StoredLocalDevelopmentWorkspaceSchema>;
const limits = { evidenceBytes: 2_000_000 };
const leasePath = (value: StoredLocalDevelopmentWorkspace) => join(value.receipt.workspace.repoPath, '.sandcastle', 'flyrewheel-attempts',
  `attempt/${value.receipt.workspace.runId}--${value.receipt.workspace.attemptId}`.replace('/', '-'));
async function boundedJson(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limits.evidenceBytes) throw new Error('Development receipt/evidence must be a bounded regular file');
    const buffer = Buffer.alloc(limits.evidenceBytes + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limits.evidenceBytes) throw new Error('Development evidence exceeds limit');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await file.close(); }
}
async function evidence(directory: string, ownerId: string, operation: string, value: unknown) {
  const payload = { schemaVersion: 1, kind: 'local-development-workspace-evidence', ownerId, operation, value,
    assurance: 'content-integrity-only-not-a-frozen-external-snapshot' };
  const digest = digestOf(payload), bytes = JSON.stringify(payload);
  if (Buffer.byteLength(bytes) > limits.evidenceBytes) throw new Error('Development evidence exceeds limit; resources retained');
  const path = join(directory, `${digest}.json`);
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (digestOf(await boundedJson(path)) !== digest) throw new Error('Existing development evidence differs; resources retained');
  }
  return { digest, path };
}
async function owned(raw: StoredLocalDevelopmentWorkspace) {
  const value = StoredLocalDevelopmentWorkspaceSchema.parse(raw), workspace = value.receipt.workspace;
  if (await realpath(workspace.repoPath) !== workspace.repoPath) throw new Error('Development repository path changed');
  const lease = leasePath(value);
  if (await realpath(lease) !== lease || await realpath(join(lease, 'local-development-evidence')) !== join(lease, 'local-development-evidence'))
    throw new Error('Development ownership/evidence directory changed');
  const registered = StoredLocalDevelopmentWorkspaceSchema.parse(await boundedJson(join(lease, 'local-development-owner.json')));
  if (digestOf(registered) !== digestOf(value)) throw new Error('Development ownership receipt differs from the allocated resource');
  const observed = await inspectWorkspace(workspace);
  if (observed.record.baseSha !== value.receipt.selection.expectedSha || observed.record.initialHeadSha !== value.receipt.selection.expectedSha)
    throw new Error('Development workspace commit binding changed');
  await readEvidenceUnchecked(value, value.receipt.createdEvidenceDigest);
  return { value, observed, directory: join(lease, 'local-development-evidence') };
}
async function readEvidenceUnchecked(value: StoredLocalDevelopmentWorkspace, digest: string) {
  DigestSchema.parse(digest);
  const payload = await boundedJson(join(leasePath(value), 'local-development-evidence', `${digest}.json`));
  if (digestOf(payload) !== digest || payload.ownerId !== value.receipt.ownerId || payload.kind !== 'local-development-workspace-evidence')
    throw new Error('Development evidence identity/content mismatch');
  return payload;
}
/** Allocate only a newly generated identity in an explicitly supplied dedicated
 * trusted Git store. No repository program, model, credential or sandbox runs. */
export async function createLocalDevelopmentWorkspace(raw: z.input<typeof LocalDevelopmentWorkspaceInputSchema>): Promise<StoredLocalDevelopmentWorkspace> {
  const input = LocalDevelopmentWorkspaceInputSchema.parse(raw), ownerId = randomUUID();
  const repoPath = await realpath(input.repoPath), workspace = { repoPath, runId: 'local-development', attemptId: ownerId.replaceAll('-', '') };
  const prepared = await prepareWorkspace({ ...workspace, baseSha: input.selection.expectedSha });
  const directory = join(dirname(prepared.manifestPath), 'local-development-evidence'); await mkdir(directory);
  const initial = await evidence(directory, ownerId, 'created', await inspectWorkspace(workspace));
  const receipt = Receipt.parse({ schemaVersion: 1, kind: 'local-development-workspace', ownerId, workspace, selection: input.selection,
    preparedManifestDigest: digestOf(prepared.record), createdEvidenceDigest: initial.digest,
    isolation: 'none', modelExecution: 'not_run', productionAuthority: 'not_provided' });
  const value = { digest: digestOf(receipt), receipt };
  await writeFile(join(dirname(prepared.manifestPath), 'local-development-owner.json'), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  return value;
}
export async function inspectLocalDevelopmentWorkspace(raw: StoredLocalDevelopmentWorkspace) {
  const { value, observed } = await owned(raw);
  const ready = observed.record.status === 'ready' && observed.observation.identityValid && observed.observation.cleanlinessVerified
    && observed.observation.currentHeadSha === value.receipt.selection.expectedSha && digestOf(observed.record) === value.receipt.preparedManifestDigest;
  const preparedWorkspaces = PreparedWorkspaceResolverConfigSchema.parse({ schemaVersion: 1, entries: [{ selection: value.receipt.selection,
    workspace: value.receipt.workspace, manifestDigest: value.receipt.preparedManifestDigest }] });
  return { receiptDigest: value.digest, state: observed.record.status, localDevelopment: ready ? 'ready' : 'not_ready',
    fixedCommit: value.receipt.selection.expectedSha, observedHead: observed.observation.currentHeadSha,
    worktreeExists: observed.observation.worktreeExists, evidence: { digest: value.receipt.createdEvidenceDigest, verification: 'passed-content-integrity-only' },
    preparedWorkspaces: ready ? preparedWorkspaces : null,
    capabilities: { managedWorktree: true, fixedCommit: true, contentHashedEvidence: true, cleanOwnedWorktreeCleanup: true,
      arbitraryProgramExecution: false, wholeRuntimeStop: 'unsupported', frozenExternalSnapshot: 'unsupported', physicalResourceDestruction: 'unsupported' },
    productionReady: false, productionAuthority: 'not_provided', isolation: 'none', modelExecution: 'not_run' };
}
/** Returns only the existing exact-selection resolver, never a runtime/authority. */
export async function createLocalDevelopmentResolver(raw: StoredLocalDevelopmentWorkspace) {
  const inspection = await inspectLocalDevelopmentWorkspace(raw);
  if (!inspection.preparedWorkspaces) throw new Error('Development workspace is not ready for resolution');
  return createPreparedWorkspaceResolver(inspection.preparedWorkspaces);
}
export async function cleanupLocalDevelopmentWorkspace(raw: StoredLocalDevelopmentWorkspace) {
  const { value, observed, directory } = await owned(raw);
  const before = await evidence(directory, value.receipt.ownerId, 'before-cleanup', observed);
  // Existing lifecycle refuses active leases and preserves dirty/ignored/untracked
  // data. It removes a worktree only; never force-deletes source, branches or history.
  const result = await cleanupWorkspace(value.receipt.workspace);
  const after = await evidence(directory, value.receipt.ownerId, 'after-cleanup', result);
  return { ...await inspectLocalDevelopmentWorkspace(value), cleanup: result.record.status === 'closed-clean' ? 'owned-clean-worktree-removed' : 'retained',
    beforeEvidence: before, afterEvidence: after, retained: ['source-repository', 'attempt-branch', 'manifest-history', 'evidence'],
    physicalDestruction: 'unsupported-not-claimed' };
}
export async function readLocalDevelopmentEvidence(raw: StoredLocalDevelopmentWorkspace, digest: string) {
  const { value } = await owned(raw); return readEvidenceUnchecked(value, digest);
}
