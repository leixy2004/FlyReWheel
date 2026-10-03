import { mkdir, lstat, readFile, writeFile, rename, appendFile, realpath, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { digestOf } from '../core/identity.js';
import { EvaluationWorkspaceProvenanceSchema, verifyEvaluationWorkspace, verifyEvaluationPreparation, assertNotEvaluationBaseline } from './evaluation-checkout.js';
import { boundedProcess, workspaceGit as git, workspaceIndexFlags } from './process.js';

const Id = z.string().max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const WorkspaceShaSchema = z.string().regex(/^[a-f0-9]{40}$/, 'An immutable full SHA-1 commit is required');
const Sha = WorkspaceShaSchema;
const Identity = z.object({ repoPath: z.string().min(1), runId: Id, attemptId: Id }).strict();
const Prepare = Identity.extend({ baseSha: Sha, headSha: Sha.optional(), evaluation: EvaluationWorkspaceProvenanceSchema.optional() }).strict();
const Record = z.object({
  schemaVersion: z.literal(1), manager: z.literal('FlyReWheel/Sandcastle@0.12.0'),
  repoPath: z.string(), runId: Id, attemptId: Id, branch: z.string(), worktreePath: z.string(),
  baseSha: Sha, headSha: Sha, mergeBaseSha: Sha, initialHeadSha: Sha,
  status: z.enum(['allocating', 'ready', 'allocation-failed', 'preserved-dirty', 'closed-clean', 'cleanup-unverified']),
  createdAt: z.string(), updatedAt: z.string(), error: z.string().optional(),
  evaluation: EvaluationWorkspaceProvenanceSchema.optional(),
  lastCleanup: z.object({ at: z.string(), evidencePath: z.string(), headSha: Sha, worktreeStillExists: z.boolean(), branchRetained: z.boolean() }).strict().optional(),
}).strict();
export type WorkspaceRecord = z.infer<typeof Record>;
export type WorkspaceIdentity = z.infer<typeof Identity>;
export type PrepareWorkspaceInput = z.infer<typeof Prepare>;
const exists = async (path: string) => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

export async function workspaceDirectory(path: string, create = false) {
  if (create) await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`A real directory is required: ${path}`);
}
const directory = workspaceDirectory;

async function repository(input: string) {
  const repoPath = await realpath(input);
  if (await realpath((await git(repoPath, 'rev-parse', '--show-toplevel')).trim()) !== repoPath) throw new Error('Use the main repository root');
  await directory(join(repoPath, '.git')); // Do not allocate in another worktree, a bare repo, or a symlinked store.
  if ((await git(repoPath, 'rev-parse', '--is-shallow-repository')).trim() !== 'false') throw new Error('Full repository history required');
  const config = await git(repoPath, 'config', '--local', '--null', '--list');
  for (const entry of config.split('\0')) {
    const key = entry.split('\n')[0].toLowerCase();
    if (/^(filter\.|include\.|includeif\.|extensions\.(worktreeconfig|partialclone)$|remote\..*\.promisor$)/.test(key)) {
      throw new Error('Use a full dedicated trusted repository store without checkout filters, config includes, partial clone or worktree-specific config');
    }
  }
  await git(repoPath, 'rev-list', '--objects', '--all', '--quiet');
  return repoPath;
}

function paths(identity: WorkspaceIdentity) {
  const branch = `attempt/${identity.runId}--${identity.attemptId}`;
  const name = branch.replace('/', '-');
  const managed = join(identity.repoPath, '.sandcastle');
  const attempts = join(managed, 'flyrewheel-attempts');
  const lease = join(attempts, name);
  return { branch, name, managed, attempts, lease, manifest: join(lease, 'manifest.json'), worktrees: join(managed, 'worktrees'), worktreePath: join(managed, 'worktrees', name) };
}

async function managedDirectories(identity: WorkspaceIdentity, create: boolean) {
  const p = paths(identity);
  await directory(p.managed, create);
  await directory(p.attempts, create);
  if (await exists(p.worktrees)) await directory(p.worktrees);
  return p;
}

async function save(p: ReturnType<typeof paths>, record: WorkspaceRecord) {
  record.updatedAt = new Date().toISOString();
  Record.parse(record);
  // Append full state before replacing the current view. A partial failure remains inspectable.
  await appendFile(join(p.lease, 'history.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  const temporary = join(p.lease, `manifest-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, p.manifest);
}

async function read(identity: WorkspaceIdentity) {
  const p = await managedDirectories(identity, false);
  await directory(p.lease);
  const info = await lstat(p.manifest);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error('Invalid workspace manifest');
  const record = Record.parse(JSON.parse(await readFile(p.manifest, 'utf8')));
  for (const key of ['repoPath', 'runId', 'attemptId'] as const) if (record[key] !== identity[key]) throw new Error('Workspace manifest identity mismatch');
  if (record.branch !== p.branch || record.worktreePath !== p.worktreePath || record.initialHeadSha !== record.baseSha) throw new Error('Workspace manifest path/provenance mismatch');
  return { p, record };
}

async function withOperationLock<T>(identity: WorkspaceIdentity, action: () => Promise<T>): Promise<T> {
  const lock = join(paths(identity).managed, 'flyrewheel-operation.lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { await mkdir(lock); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Repository workspace operation locked; inspect the lock and any active process before manual recovery');
      await delay(25);
    }
  }
  try { return await action(); } finally { await rmdir(lock); }
}

/** Sandcastle prunes orphan directories. Refuse to let that destroy unregistered evidence. */
async function rejectOrphans(identity: WorkspaceIdentity) {
  const p = paths(identity);
  if (!await exists(p.worktrees)) return;
  await directory(p.worktrees);
  const listed = await git(identity.repoPath, 'worktree', 'list', '--porcelain', '-z');
  const registered = new Set(listed.split('\0').filter(part => part.startsWith('worktree ')).map(part => part.slice(9)));
  for (const entry of await readdir(p.worktrees)) {
    const path = join(p.worktrees, entry);
    await directory(path);
    if (!registered.has(path)) throw new Error(`Unregistered Sandcastle directory retained; explicit recovery required: ${path}`);
  }
}

async function commit(repoPath: string, sha: string) {
  if ((await git(repoPath, 'rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`)).trim() !== sha) throw new Error('Commit identity mismatch');
}

async function bridge(operation: 'prepare' | 'cleanup', record: WorkspaceRecord, expectedHead: string) {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const path = fileURLToPath(new URL(`./sandcastle-process.${extension}`, import.meta.url));
  await boundedProcess(process.execPath, [
    ...(extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : []), path, operation, record.repoPath,
    record.branch, record.baseSha, record.worktreePath, expectedHead,
  ], record.repoPath, 1_000_000);
}

async function observe(record: WorkspaceRecord) {
  const branchRefs = (await git(record.repoPath, 'for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${record.branch}`)).trim().split('\n');
  const branchHeadSha = branchRefs.find(ref => ref.startsWith(`refs/heads/${record.branch} `))?.split(' ')[1];
  const worktreeExists = await exists(record.worktreePath);
  if (!worktreeExists) return { worktreeExists, branchHeadSha, branchRetained: !!branchHeadSha, identityValid: true };
  await directory(record.worktreePath);
  if (await realpath(record.worktreePath) !== record.worktreePath) throw new Error('Workspace path changed');
  const common = (await git(record.worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
  const currentBranch = (await git(record.worktreePath, 'branch', '--show-current')).trim();
  const currentHeadSha = (await git(record.worktreePath, 'rev-parse', 'HEAD')).trim();
  const status = await git(record.worktreePath, 'status', '--porcelain=v1', '--untracked-files=all');
  // Unlike upstream close(), ignored untracked bytes also prevent deletion.
  const untracked = await git(record.worktreePath, 'ls-files', '--others', '-z');
  const indexFlags = await workspaceIndexFlags(record.worktreePath);
  const dirty = !!status.trim() || !!untracked;
  const preservationReasons = [
    ...(dirty ? ['Git reports tracked changes or untracked bytes'] : []),
    ...(indexFlags.assumeUnchangedPaths.length || indexFlags.skipWorktreePaths.length
      ? ['Git index assume-unchanged or skip-worktree flags prevent verifying tracked-file cleanliness'] : []),
  ];
  return {
    worktreeExists, branchHeadSha, branchRetained: !!branchHeadSha, currentBranch, currentHeadSha,
    identityValid: currentBranch === record.branch && common === join(record.repoPath, '.git') && branchHeadSha === currentHeadSha,
    dirty, status, untrackedPaths: untracked.split('\0').filter(Boolean), indexFlags,
    cleanlinessVerified: preservationReasons.length === 0, preservationReasons,
  };
}

export async function prepareWorkspace(input: PrepareWorkspaceInput) {
  const options = Prepare.parse(input);
  options.repoPath = await repository(options.repoPath);
  await assertNotEvaluationBaseline(options.repoPath);
  if (options.evaluation) await verifyEvaluationPreparation(options.repoPath, options.evaluation, options.baseSha);
  await commit(options.repoPath, options.baseSha);
  const headSha = options.headSha ?? options.baseSha;
  await commit(options.repoPath, headSha);
  const mergeBaseSha = Sha.parse((await git(options.repoPath, 'merge-base', options.baseSha, headSha)).trim());
  const p = await managedDirectories(options, true);
  try { await mkdir(p.lease); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Attempt already allocated; choose a new attempt ID, including after failure or cleanup');
    throw error;
  }
  const record: WorkspaceRecord = {
    schemaVersion: 1, manager: 'FlyReWheel/Sandcastle@0.12.0', repoPath: options.repoPath,
    runId: options.runId, attemptId: options.attemptId, branch: p.branch, worktreePath: p.worktreePath,
    baseSha: options.baseSha, headSha, mergeBaseSha, initialHeadSha: options.baseSha, status: 'allocating',
    ...(options.evaluation ? { evaluation: options.evaluation } : {}),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await save(p, record);
  try {
    await withOperationLock(options, async () => {
      await rejectOrphans(options);
      const refs = (await git(options.repoPath, 'for-each-ref', '--format=%(refname)', `refs/heads/${p.branch}`)).trim();
      if (refs || await exists(p.worktreePath)) throw new Error('Refuse existing branch or worktree; retained without reuse');
      await bridge('prepare', record, record.baseSha);
      const observation = await observe(record);
      if (!observation.worktreeExists || !observation.identityValid || observation.currentHeadSha !== record.baseSha) throw new Error('Allocated workspace identity mismatch');
      await verifyEvaluationWorkspace(record);
      record.status = 'ready';
      await save(p, record);
    });
    return { manifestPath: p.manifest, record };
  } catch (error) {
    record.status = 'allocation-failed'; record.error = String(error);
    await save(p, record);
    throw error;
  }
}

export async function inspectWorkspace(input: WorkspaceIdentity) {
  const identity = Identity.parse(input);
  identity.repoPath = await repository(identity.repoPath);
  const { p, record } = await read(identity);
  return { manifestPath: p.manifest, record, observation: await observe(record) };
}

/** Cooperative lifecycle lease. A crash leaves it in place for explicit recovery. */
export async function acquireWorkspaceExecutionLease(input: WorkspaceIdentity, expectedSha: string) {
  const identity = Identity.parse(input);
  Sha.parse(expectedSha);
  identity.repoPath = await repository(identity.repoPath);
  await managedDirectories(identity, false);
  return withOperationLock(identity, async () => {
    const { p, record } = await read(identity);
    const observation = await observe(record);
    if (record.status !== 'ready' || !observation.worktreeExists || !observation.identityValid
      || !observation.cleanlinessVerified || observation.currentHeadSha !== expectedSha
      || record.baseSha !== expectedSha || record.initialHeadSha !== expectedSha) {
      throw new Error('Execution requires a ready, clean, identity-verified workspace at the exact expected base SHA');
    }
    await verifyEvaluationWorkspace(record);
    const lock = join(p.lease, 'active-execution');
    try { await mkdir(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Workspace execution lease is active; inspect the owner before explicit recovery');
      throw error;
    }
    const token = randomUUID();
    // A write failure deliberately leaves the lock: ownership cannot be verified.
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ token, expectedSha, createdAt: new Date().toISOString() }), { mode: 0o600 });
    let released = false;
    return { record, observation, leasePath: lock, async release() {
      if (released) return;
      await withOperationLock(identity, async () => {
        await directory(lock);
        const ownerPath = join(lock, 'owner.json');
        const info = await lstat(ownerPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Execution lease ownership cannot be verified');
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (owner.token !== token) throw new Error('Execution lease ownership changed; explicit recovery required');
        await unlink(join(lock, 'owner.json'));
        await rmdir(lock);
        released = true;
      });
    } };
  });
}

/** Sandcastle's public reuse API still prunes worktrees. Keep that operation
 * under the same cooperative lock/orphan refusal as preparation and cleanup.
 * An active execution lease is required; this is not a filesystem sandbox.
 */
export async function withWorkspaceTransferGuard<T>(expected: Readonly<WorkspaceRecord>, action: () => Promise<T>): Promise<T> {
  const identity = Identity.parse({ repoPath: expected.repoPath, runId: expected.runId, attemptId: expected.attemptId });
  identity.repoPath = await repository(identity.repoPath);
  await managedDirectories(identity, false);
  return withOperationLock(identity, async () => {
    const { p, record } = await read(identity);
    await directory(join(p.lease, 'active-execution'));
    await rejectOrphans(identity);
    const check = async () => {
      const observation = await observe(record);
      if (digestOf(record.evaluation ?? null) !== digestOf(expected.evaluation ?? null)) throw new Error('Workspace evaluation binding changed before transfer');
      await verifyEvaluationWorkspace(record);
      if (record.status !== 'ready' || record.worktreePath !== expected.worktreePath || record.branch !== expected.branch
        || record.baseSha !== expected.baseSha || record.initialHeadSha !== expected.baseSha
        || !observation.worktreeExists || !observation.identityValid || !observation.cleanlinessVerified
        || observation.currentHeadSha !== expected.baseSha) throw new Error('Workspace changed before or during transfer');
    };
    await check();
    const result = await action();
    await check();
    return result;
  });
}

/** Preserve dirty/ignored bytes and unverifiable index state; never delete branches or recycle attempt IDs. */
export async function cleanupWorkspace(input: WorkspaceIdentity) {
  const identity = Identity.parse(input);
  identity.repoPath = await repository(identity.repoPath);
  await managedDirectories(identity, false);
  return withOperationLock(identity, async () => {
    const { p, record } = await read(identity);
    if (await exists(join(p.lease, 'active-execution'))) throw new Error('Workspace execution lease is active; cleanup refused');
    if (!['ready', 'preserved-dirty', 'closed-clean'].includes(record.status)) throw new Error('Attempt requires explicit recovery; automatic cleanup refused');
    const observation = await observe(record);
    if (!observation.worktreeExists && record.status === 'closed-clean' && observation.branchRetained) return { manifestPath: p.manifest, record, observation };
    if (!observation.worktreeExists || !observation.identityValid || !observation.currentHeadSha) throw new Error('Workspace identity changed or missing; cleanup refused');
    const evidencePath = join(p.lease, `cleanup-${randomUUID()}`);
    await directory(evidencePath, true);
    // Every invocation gets immutable evidence. Capture failure prevents the destructive step.
    await writeFile(join(evidencePath, 'status.txt'), observation.status ?? '', { mode: 0o600 });
    await writeFile(join(evidencePath, 'untracked.json'), JSON.stringify(observation.untrackedPaths), { mode: 0o600 });
    await writeFile(join(evidencePath, 'index-flags.json'), JSON.stringify(observation.indexFlags), { mode: 0o600 });
    await writeFile(join(evidencePath, 'changes.patch'), await git(record.worktreePath, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'), { mode: 0o600 });
    await writeFile(join(evidencePath, 'observation.json'), JSON.stringify(observation, null, 2), { mode: 0o600 });
    record.lastCleanup = { at: new Date().toISOString(), evidencePath, headSha: observation.currentHeadSha, worktreeStillExists: true, branchRetained: true };
    if (!observation.cleanlinessVerified) {
      record.status = 'preserved-dirty';
    } else {
      try {
        await rejectOrphans(identity);
        await bridge('cleanup', record, observation.currentHeadSha);
        const after = await observe(record);
        record.lastCleanup.worktreeStillExists = after.worktreeExists;
        record.lastCleanup.branchRetained = after.branchHeadSha === observation.currentHeadSha;
        if (after.worktreeExists || !record.lastCleanup.branchRetained) throw new Error('Sandcastle cleanup could not be independently verified');
        record.status = 'closed-clean';
      } catch (error) {
        record.status = 'cleanup-unverified'; record.error = String(error);
        await save(p, record);
        throw error;
      }
    }
    await save(p, record);
    return { manifestPath: p.manifest, record, observation: await observe(record) };
  });
}
