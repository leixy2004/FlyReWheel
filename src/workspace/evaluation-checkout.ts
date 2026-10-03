import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { digestOf } from '../core/identity.js';
import { EvaluationWorkspaceBindingSchema, type EvaluationWorkspaceBinding } from './history-policy.js';
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
import { boundedProcessBytes, workspaceIndexFlags } from './process.js';

export const EVALUATION_CHECKOUT_LIMITS = Object.freeze({ heads: 64, objects: 100_000, outputBytes: 8_000_000,
  packBytes: 64_000_000, objectBytes: 64_000_000, expandedBytes: 256_000_000, manifestBytes: 100_000, timeoutMs: 120_000 });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Declarations are recorded, never promoted to proof by commit dates or by export. */
export const EvaluationVisibilityManifestSchema = z.object({
  schemaVersion: z.literal(1), repositoryId: z.string().min(1).max(300),
  classification: z.enum(['development-fixture', 'unverified-evaluation-input']),
  allowedHeads: z.array(Sha).min(1).max(EVALUATION_CHECKOUT_LIMITS.heads), checkoutSha: Sha,
  visibility: z.object({ basis: z.literal('caller-declared-exact-heads'),
    declaredAsOf: z.iso.datetime({ offset: true }).nullable(), evidenceDigests: z.array(Digest).max(64),
  }).strict(),
}).strict();
export type EvaluationVisibilityManifest = z.infer<typeof EvaluationVisibilityManifestSchema>;
const RecordSchema = z.object({
  schemaVersion: z.literal(1), policy: z.literal('exact-allowed-head-closure-v1'),
  request: EvaluationVisibilityManifestSchema, requestDigest: Digest, storageDigest: Digest,
  inventory: z.object({ count: z.number().int().positive(), expandedBytes: z.number().int().positive(), digest: Digest }).strict(),
  refs: z.array(z.object({ name: z.string(), sha: Sha }).strict()),
  historicalPublicAvailability: z.literal('unproven'), timestampsEstablishVisibility: z.literal(false),
  isolation: z.literal('standalone-git-object-closure-not-an-execution-sandbox'),
}).strict();
type ExportRecord = z.infer<typeof RecordSchema>;
type Git = (cwd: string, args: string[], input?: Uint8Array, maxBytes?: number) => Promise<string>;
const exists = (path: string) => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const inside = (parent: string, child: string) => { const rel = relative(parent, child); return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
function request(value: unknown) {
  const result = EvaluationVisibilityManifestSchema.parse(value);
  if (new Set(result.allowedHeads).size !== result.allowedHeads.length) throw new Error('Duplicate allowed head SHA');
  if (!result.allowedHeads.includes(result.checkoutSha)) throw new Error('Checkout SHA must be an explicitly allowed head');
  if (new Set(result.visibility.evidenceDigests).size !== result.visibility.evidenceDigests.length) throw new Error('Duplicate visibility evidence digest');
  result.allowedHeads.sort(); result.visibility.evidenceDigests.sort();
  return result;
}
function commands() {
  const deadline = Date.now() + EVALUATION_CHECKOUT_LIMITS.timeoutMs;
  const bytes = async (cwd: string, args: string[], input?: Uint8Array, maxBytes: number = EVALUATION_CHECKOUT_LIMITS.outputBytes) => {
    if (Date.now() >= deadline) throw new Error('Evaluation checkout operation deadline exceeded');
    return boundedProcessBytes('/usr/bin/git', ['-c', 'core.filemode=true', '-c', 'core.commitGraph=false', '-c', 'core.attributesFile=/dev/null', '-c', 'pack.writeReverseIndex=false', ...args], cwd, maxBytes, true, Math.max(1, deadline - Date.now()), input);
  };
  const git: Git = async (...args) => new TextDecoder('utf-8', { fatal: true }).decode(await bytes(...args));
  return { git, bytes };
}
async function canonicalDirectory(path: string, create = false) {
  if (!isAbsolute(path)) throw new Error('Evaluation paths must be absolute and canonical');
  if (create && !await exists(path)) {
    await canonicalDirectory(dirname(path));
    if (await realpath(dirname(path)) !== dirname(path)) throw new Error('Symlinked store parent refused');
    await mkdir(path, { mode: 0o700 });
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Evaluation path must be a real directory');
  if (await realpath(path) !== path) throw new Error('Symlinked evaluation path refused');
}
async function regular(path: string, maxBytes = Infinity) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error('Unsafe or oversized evaluation storage file');
}
async function walkStorage(path: string, exported: boolean) {
  let count = 0, totalBytes = 0;
  const files: { path: string; digest: string }[] = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir)) {
      if (++count > EVALUATION_CHECKOUT_LIMITS.objects * 3) throw new Error('Evaluation storage entry limit exceeded');
      const file = join(dir, entry), info = await lstat(file), rel = relative(path, file).split(sep).join('/');
      if (info.isSymbolicLink()) throw new Error('Symlinked Git storage refused');
      if (info.isDirectory()) {
        if (exported && !/^(refs|refs\/heads|refs\/tags|objects|objects\/pack|objects\/info|objects\/[a-f0-9]{2})$/.test(rel)) throw new Error('Unexpected exported Git storage directory');
        await visit(file);
      }
      else {
        await regular(file, exported ? EVALUATION_CHECKOUT_LIMITS.packBytes : Infinity);
        if (exported) {
          totalBytes += info.size;
          if (totalBytes > EVALUATION_CHECKOUT_LIMITS.packBytes * 2) throw new Error('Export storage byte limit exceeded');
          files.push({ path: rel, digest: createHash('sha256').update(await readFile(file)).digest('hex') });
        }
        if (entry.endsWith('.promisor')) throw new Error('Promisor storage refused');
        if (exported && !/^(HEAD|config|index|refs\/heads\/allowed-[a-f0-9]{40}|objects\/(pack\/pack-[a-f0-9]{40}\.(pack|idx|rev)|[a-f0-9]{2}\/[a-f0-9]{38}))$/.test(rel)) {
          throw new Error(`Unexpected exported Git storage file: ${rel}`);
        }
      }
    }
  }
  await visit(path);
  return digestOf(files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/** Reject unsafe/incomplete input before traversal. Nothing is fetched or repaired. */
async function repository(path: string, git: Git, exported = false) {
  await canonicalDirectory(path);
  for (const dir of ['.git', '.git/objects', '.git/refs']) await canonicalDirectory(join(path, dir));
  for (const file of ['HEAD', 'config']) await regular(join(path, '.git', file), EVALUATION_CHECKOUT_LIMITS.outputBytes);
  for (const file of ['shallow', 'commondir', 'config.worktree', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
    if (await exists(join(path, '.git', file))) throw new Error(`Unsupported Git storage: ${file}`);
  }
  const config = await git(path, ['config', '--no-includes', '--file', join(path, '.git/config'), '--null', '--list']);
  for (const entry of config.split('\0').filter(Boolean)) {
    const key = entry.split('\n')[0].toLowerCase();
    if (exported && !/^core\.(repositoryformatversion|filemode|bare|logallrefupdates)$/.test(key)) throw new Error('Unexpected exported Git configuration');
    if (!/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|user\.(name|email)|remote\.[^.]+\.(url|fetch)|branch\.[^\n]+\.(remote|merge))$/.test(key)) {
      throw new Error(`Unsupported evaluation repository configuration: ${key}`);
    }
  }
  if ((await git(path, ['rev-parse', '--show-toplevel'])).trim() !== path
    || (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() !== join(path, '.git')
    || (await git(path, ['rev-parse', '--show-object-format'])).trim() !== 'sha1'
    || (await git(path, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false'
    || (await git(path, ['for-each-ref', '--format=%(refname)', 'refs/replace'])).trim()) throw new Error('Full standalone SHA-1 repository without replacements required');
  if (!exported) await walkStorage(join(path, '.git/objects'), false);
}
function objectIds(text: string) {
  const ids = text.trim().split('\n');
  if (!text.trim() || ids.length > EVALUATION_CHECKOUT_LIMITS.objects || ids.some(id => !Sha.safeParse(id).success)) throw new Error('Invalid or oversized Git object closure');
  return [...new Set(ids)].sort();
}
async function closure(repo: string, heads: string[], git: Git) {
  for (const head of heads) if ((await git(repo, ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`])).trim() !== head) throw new Error('Allowed head must be an exact commit SHA');
  return objectIds(await git(repo, ['rev-list', '--objects', '--no-object-names', ...heads, '--']));
}
async function inventory(repo: string, ids: string[], git: Git, all = false) {
  const lines = (await git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', ...(all ? ['--batch-all-objects'] : [])],
    all ? undefined : Buffer.from(ids.join('\n') + '\n'))).trim().split('\n').sort();
  if (lines.length !== ids.length || lines.some((line, i) => !new RegExp(`^${ids[i]} (commit|tree|blob) [0-9]+$`).test(line))) throw new Error('Export object inventory differs from allowed reachable closure');
  if (lines.some(line => Number(line.split(' ')[2]) > EVALUATION_CHECKOUT_LIMITS.objectBytes)) throw new Error('Individual Git object byte limit exceeded');
  const expandedBytes = lines.reduce((sum, line) => sum + Number(line.split(' ')[2]), 0);
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > EVALUATION_CHECKOUT_LIMITS.expandedBytes) throw new Error('Expanded Git object byte limit exceeded');
  return { count: ids.length, expandedBytes, digest: digestOf(lines) };
}
async function tree(repo: string, sha: string, git: Git) {
  const entries = (await git(repo, ['ls-tree', '-r', '-z', '--full-tree', sha])).split('\0').filter(Boolean);
  if (entries.length > EVALUATION_CHECKOUT_LIMITS.objects) throw new Error('Checkout file count limit exceeded');
  const sizes = entries.length ? (await git(repo, ['cat-file', '--batch-check=%(objectsize)'], Buffer.from(entries.map(entry => entry.split('\t')[0].split(' ')[2]).join('\n') + '\n'))).trim().split('\n') : [];
  if (sizes.some(size => !/^[0-9]+$/.test(size)) || sizes.reduce((sum, size) => sum + Number(size), 0) > EVALUATION_CHECKOUT_LIMITS.expandedBytes) throw new Error('Checkout byte limit exceeded');
  return entries.map(entry => {
    const parsed = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!parsed) throw new Error('Evaluation checkout requires regular files; symlinks and submodules are refused');
    const [, mode, oid, path] = parsed;
    if (isAbsolute(path) || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) throw new Error('Unsafe checkout tree path');
    return { mode, oid, path };
  });
}
const refsFor = (manifest: EvaluationVisibilityManifest) => manifest.allowedHeads.map(sha => ({ name: `refs/heads/allowed-${sha}`, sha }));
async function verify(repo: string, record: ExportRecord, git: Git) {
  await canonicalDirectory(repo); await canonicalDirectory(join(repo, '.git'));
  if (await walkStorage(join(repo, '.git'), true) !== record.storageDigest) throw new Error('Export Git metadata/storage digest mismatch');
  await repository(repo, git, true);
  const ids = await closure(repo, record.request.allowedHeads, git);
  const actual = await inventory(repo, ids, git, true);
  if (digestOf(actual) !== digestOf(record.inventory)) throw new Error('Export inventory manifest mismatch');
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).trim().split('\n').filter(Boolean);
  if (digestOf(refs) !== digestOf(refsFor(record.request).map(ref => `${ref.name} ${ref.sha}`))) throw new Error('Export ref visibility mismatch');
  if ((await git(repo, ['rev-parse', '--verify', 'HEAD'])).trim() !== record.request.checkoutSha
    || (await readFile(join(repo, '.git/HEAD'), 'utf8')).trim() !== record.request.checkoutSha) throw new Error('Export checkout identity mismatch');
  await git(repo, ['fsck', '--full', '--strict', '--no-reflogs']);
  const flags = await workspaceIndexFlags(repo, async (cwd, ...args) => git(cwd, args));
  if (flags.assumeUnchangedPaths.length || flags.skipWorktreePaths.length
    || (await git(repo, ['status', '--porcelain=v1', '--untracked-files=all']))
    || (await git(repo, ['ls-files', '--others', '-z']))) throw new Error('Export checkout is not clean and complete');
  await verifyTreeBytes(repo, record.request.checkoutSha, git);
  return { objectClosureVerified: true as const, exactRefsVerified: true as const, fullCommittedTreeVerified: true as const,
    historicalPublicAvailability: 'unproven' as const, executionSandbox: false as const };
}
async function verifyTreeBytes(repo: string, sha: string, git: Git) {
  // Independently compare file bytes with Git blob IDs: attributes/encodings must
  // not silently alter the committed tree, even when status considers it clean.
  const committed = await tree(repo, sha, git);
  const expectedPaths = new Map<string, 'file' | 'directory'>();
  for (const file of committed) {
    expectedPaths.set(file.path, 'file');
    for (let parent = dirname(file.path); parent !== '.'; parent = dirname(parent)) expectedPaths.set(parent, 'directory');
  }
  let visited = 0;
  async function walkTree(path: string) {
    for (const name of await readdir(path)) {
      if (path === repo && name === '.git') continue;
      const child = join(path, name), kind = expectedPaths.get(relative(repo, child));
      if (++visited > expectedPaths.size || !kind) throw new Error('Unexpected checkout filesystem entry');
      const info = await lstat(child);
      if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) throw new Error('Unexpected checkout filesystem type');
      if (kind === 'directory') await walkTree(child);
    }
  }
  await walkTree(repo);
  if (visited !== expectedPaths.size) throw new Error('Missing checkout filesystem entry');
  for (const file of committed) {
    const path = join(repo, file.path);
    if (await realpath(path) !== path) throw new Error('Symlinked checkout path refused');
    await regular(path, EVALUATION_CHECKOUT_LIMITS.expandedBytes);
    const info = await lstat(path), bytes = await readFile(path);
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (oid !== file.oid || !!(info.mode & 0o111) !== (file.mode === '100755')) throw new Error('Checkout bytes or mode differ from committed tree');
  }
}
async function exportLocation(storePath: string, manifest: EvaluationVisibilityManifest, create = false) {
  await canonicalDirectory(storePath, create);
  // Never hide outputs inside an existing repository, including a worktree.
  for (let path = storePath; dirname(path) !== path; path = dirname(path)) {
    const metadata = join(path, '.git');
    if (await exists(metadata) && (!(await lstat(metadata)).isDirectory() || await exists(join(metadata, 'HEAD')))) throw new Error('Evaluation store must be outside existing repositories');
  }
  const requestDigest = digestOf(manifest), exportPath = join(storePath, `export-${requestDigest}`);
  return { requestDigest, exportPath, repoPath: join(exportPath, 'repo'), manifestPath: join(exportPath, 'manifest.json') };
}
export async function inspectEvaluationCheckout(input: { storePath: string; manifest: EvaluationVisibilityManifest }) {
  const { readEvaluationJson } = await import('../paired-evaluation.js');
  const manifest = request(input.manifest), location = await exportLocation(input.storePath, manifest);
  await canonicalDirectory(location.exportPath);
  if ((await readdir(location.exportPath)).sort().join('\0') !== ['manifest.json', 'repo', 'request.json'].join('\0')) throw new Error('Export incomplete or contains unexpected files; retained for manual recovery');
  for (const path of [location.manifestPath, join(location.exportPath, 'request.json')]) await regular(path, EVALUATION_CHECKOUT_LIMITS.manifestBytes);
  const record = RecordSchema.parse(await readEvaluationJson(location.manifestPath, EVALUATION_CHECKOUT_LIMITS.manifestBytes));
  const savedRequest = request(await readEvaluationJson(join(location.exportPath, 'request.json'), EVALUATION_CHECKOUT_LIMITS.manifestBytes));
  if (record.requestDigest !== location.requestDigest || digestOf(record.request) !== location.requestDigest
    || digestOf(savedRequest) !== location.requestDigest || digestOf(record.refs) !== digestOf(refsFor(manifest))) throw new Error('Export manifest identity mismatch');
  const observation = await verify(location.repoPath, record, commands().git);
  return { ...location, record, recordDigest: digestOf(record), observation };
}
/** Optional local export only. Does not alter source refs, worktrees, or production transfer policy. */
export async function exportEvaluationCheckout(input: { repoPath: string; storePath: string; manifest: EvaluationVisibilityManifest }) {
  const manifest = request(input.manifest), { git, bytes } = commands();
  await canonicalDirectory(input.repoPath);
  if (inside(input.repoPath, input.storePath) || inside(input.storePath, input.repoPath)) throw new Error('Evaluation store must be independent of source repository');
  await repository(input.repoPath, git);
  const ids = await closure(input.repoPath, manifest.allowedHeads, git);
  const expected = await inventory(input.repoPath, ids, git);
  await tree(input.repoPath, manifest.checkoutSha, git);
  const location = await exportLocation(input.storePath, manifest, true);
  if (await exists(location.exportPath)) {
    const prior = await inspectEvaluationCheckout({ storePath: input.storePath, manifest });
    if (digestOf(prior.record.inventory) !== digestOf(expected)) throw new Error('Source closure changed; export reuse refused');
    return prior;
  }
  // Atomic reservation. Interrupted/failed exports remain inspectable, never recycled.
  await mkdir(location.exportPath, { mode: 0o700 });
  await writeFile(join(location.exportPath, 'request.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await mkdir(location.repoPath, { mode: 0o700 });
  await git(location.repoPath, ['init', '--quiet', '--template=', '--object-format=sha1']);
  await git(location.repoPath, ['config', '--local', 'core.logAllRefUpdates', 'false']);
  const pack = await bytes(input.repoPath, ['pack-objects', '--stdout', '--no-reuse-delta', '--no-reuse-object', '--window=0', '--threads=1'],
    Buffer.from(ids.join('\n') + '\n'), EVALUATION_CHECKOUT_LIMITS.packBytes);
  await git(location.repoPath, ['index-pack', '--stdin', '--strict'], pack);
  const refs = refsFor(manifest);
  for (const ref of refs) await git(location.repoPath, ['update-ref', ref.name, ref.sha]);
  await git(location.repoPath, ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', manifest.checkoutSha, '--']);
  const record: ExportRecord = { schemaVersion: 1, policy: 'exact-allowed-head-closure-v1', request: manifest,
    requestDigest: location.requestDigest, storageDigest: await walkStorage(join(location.repoPath, '.git'), true), inventory: expected, refs, historicalPublicAvailability: 'unproven',
    timestampsEstablishVisibility: false, isolation: 'standalone-git-object-closure-not-an-execution-sandbox' };
  await verify(location.repoPath, record, git);
  // Manifest is the completion marker; it is written only after exact verification.
  await writeFile(location.manifestPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return inspectEvaluationCheckout({ storePath: input.storePath, manifest });
}

export const EvaluationWorkspaceProvenanceSchema = z.object({ binding: EvaluationWorkspaceBindingSchema,
  storePath: z.string().refine(isAbsolute), manifest: EvaluationVisibilityManifestSchema }).strict();
export type EvaluationWorkspaceProvenance = z.infer<typeof EvaluationWorkspaceProvenanceSchema>;
export function evaluationWorkspaceBinding(exportId: string, exported: Awaited<ReturnType<typeof inspectEvaluationCheckout>>) {
  return EvaluationWorkspaceBindingSchema.parse({ schemaVersion: 1, exportId, requestDigest: exported.requestDigest,
    recordDigest: exported.recordDigest, repositoryId: exported.record.request.repositoryId,
    checkoutSha: exported.record.request.checkoutSha, allowedHeads: exported.record.request.allowedHeads,
    inventory: exported.record.inventory });
}

/** Fresh, independent Git storage. No clone-local optimization, baseline writes or worktree manager. */
export async function deriveEvaluationRepository(input: EvaluationWorkspaceProvenance & { repoPath: string }) {
  const proof = EvaluationWorkspaceProvenanceSchema.parse({ binding: input.binding, storePath: input.storePath, manifest: input.manifest });
  const baseline = await inspectEvaluationCheckout(proof);
  if (digestOf(evaluationWorkspaceBinding(proof.binding.exportId, baseline)) !== digestOf(proof.binding)) throw new Error('Evaluation export binding mismatch');
  if (!isAbsolute(input.repoPath) || inside(input.repoPath, input.storePath) || inside(input.storePath, input.repoPath)) throw new Error('Derived repository must be independent of immutable export store');
  await canonicalDirectory(dirname(input.repoPath));
  for (let path = dirname(input.repoPath); dirname(path) !== path; path = dirname(path)) {
    const metadata = join(path, '.git');
    if (await exists(metadata) && (!(await lstat(metadata)).isDirectory() || await exists(join(metadata, 'HEAD')))) throw new Error('Derived repository must be outside existing repositories');
  }
  // Allocation is create-only. Interrupted derivations are retained and never recycled.
  await mkdir(input.repoPath, { mode: 0o700 });
  const { git, bytes } = commands();
  const ids = await closure(baseline.repoPath, proof.binding.allowedHeads, git);
  const pack = await bytes(baseline.repoPath, ['pack-objects', '--stdout', '--no-reuse-delta', '--no-reuse-object', '--window=0', '--threads=1'],
    Buffer.from(ids.join('\n') + '\n'), EVALUATION_CHECKOUT_LIMITS.packBytes);
  await git(input.repoPath, ['init', '--quiet', '--template=', '--object-format=sha1']);
  await git(input.repoPath, ['config', '--local', 'core.logAllRefUpdates', 'false']);
  await git(input.repoPath, ['index-pack', '--stdin', '--strict'], pack);
  for (const ref of baseline.record.refs) await git(input.repoPath, ['update-ref', ref.name, ref.sha]);
  await git(input.repoPath, ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', proof.binding.checkoutSha, '--']);
  await verifyEvaluationRepository(input.repoPath, proof.binding);
  await verifyTreeBytes(input.repoPath, proof.binding.checkoutSha, git);
  // Reinspection detects a changed baseline during derivation; never repairs it.
  const after = await inspectEvaluationCheckout(proof);
  if (after.recordDigest !== proof.binding.recordDigest) throw new Error('Evaluation baseline changed during derivation');
  return proof;
}

/** Verify ALL received objects (including unreachable), not merely current HEAD ancestry.
 * Runtime clone aliases are exact known Sandcastle/Git aliases, never arbitrary refs.
 */
export async function verifyEvaluationRepository(repoPath: string, raw: EvaluationWorkspaceBinding,
  attemptBranch?: string, runtime = false) {
  const binding = EvaluationWorkspaceBindingSchema.parse(raw), { git } = commands();
  await repository(repoPath, git);
  for (const file of ['index', 'packed-refs']) {
    if (await exists(join(repoPath, '.git', file))) await regular(join(repoPath, '.git', file), EVALUATION_CHECKOUT_LIMITS.outputBytes);
  }
  await walkStorage(join(repoPath, '.git/refs'), false);
  let storedBytes = 0, entries = 0;
  const packFiles = new Set<string>();
  async function objectStorage(path: string) {
    for (const name of await readdir(path)) {
      const child = join(path, name), rel = relative(join(repoPath, '.git/objects'), child).split(sep).join('/'), info = await lstat(child);
      if (++entries > EVALUATION_CHECKOUT_LIMITS.objects * 3) throw new Error('Evaluation storage entry limit exceeded');
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (!/^(pack|info|[a-f0-9]{2})$/.test(rel)) throw new Error('Unexpected evaluation object directory');
        await objectStorage(child);
      } else {
        await regular(child, EVALUATION_CHECKOUT_LIMITS.packBytes);
        storedBytes += info.size;
        if (storedBytes > EVALUATION_CHECKOUT_LIMITS.packBytes * 2 || !/^(pack\/pack-[a-f0-9]{40}\.(pack|idx|rev)|[a-f0-9]{2}\/[a-f0-9]{38})$/.test(rel)) throw new Error('Unexpected or oversized evaluation object storage');
        if (rel.startsWith('pack/')) packFiles.add(rel);
      }
    }
  }
  await objectStorage(join(repoPath, '.git/objects'));
  for (const file of packFiles) {
    const stem = file.replace(/\.(pack|idx|rev)$/, '');
    if (!packFiles.has(`${stem}.pack`) || !packFiles.has(`${stem}.idx`)) throw new Error('Evaluation pack/index pair is incomplete');
    // Git verifies existing pack/index/reverse-index bytes; --verify never repairs
    // them. Conditional --rev-index avoids creating an absent optimization file.
    if (file.endsWith('.pack')) await git(repoPath, ['index-pack', '--verify', '--strict',
      ...(packFiles.has(`${stem}.rev`) ? ['--rev-index'] : []), join(repoPath, '.git/objects', file)]);
  }
  const ids = await closure(repoPath, binding.allowedHeads, git);
  if (digestOf(await inventory(repoPath, ids, git, true)) !== digestOf(binding.inventory)) throw new Error('Evaluation object inventory binding mismatch');
  const refs = (await git(repoPath, ['for-each-ref', '--format=%(refname) %(objectname)'])).trim().split('\n').filter(Boolean);
  const expected = runtime ? [
    ...binding.allowedHeads.map(sha => `refs/remotes/origin/allowed-${sha} ${sha}`),
    `refs/remotes/origin/${attemptBranch} ${binding.checkoutSha}`, `refs/heads/${attemptBranch} ${binding.checkoutSha}`,
    `refs/remotes/origin/HEAD ${binding.checkoutSha}`,
  ] : [...binding.allowedHeads.map(sha => `refs/heads/allowed-${sha} ${sha}`),
    ...(attemptBranch ? [`refs/heads/${attemptBranch} ${binding.checkoutSha}`] : [])];
  if (digestOf(refs.sort()) !== digestOf(expected.sort())) throw new Error('Evaluation ref visibility mismatch');
  if (runtime && (await git(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim() !== `refs/remotes/origin/${attemptBranch}`) throw new Error('Evaluation origin HEAD alias mismatch');
  if ((await git(repoPath, ['rev-parse', '--verify', 'HEAD'])).trim() !== binding.checkoutSha) throw new Error('Evaluation checkout SHA mismatch');
  await git(repoPath, ['fsck', '--full', '--strict', '--no-reflogs']);
  if (runtime) await verifyTreeBytes(repoPath, binding.checkoutSha, git);
}

export async function verifyEvaluationWorkspace(record: { repoPath: string; worktreePath: string; branch: string;
  baseSha: string; evaluation?: EvaluationWorkspaceProvenance }) {
  if (!record.evaluation) return;
  const proof = EvaluationWorkspaceProvenanceSchema.parse(record.evaluation);
  const baseline = await inspectEvaluationCheckout(proof);
  if (digestOf(evaluationWorkspaceBinding(proof.binding.exportId, baseline)) !== digestOf(proof.binding)
    || record.baseSha !== proof.binding.checkoutSha || inside(proof.storePath, record.repoPath) || inside(record.repoPath, proof.storePath)) throw new Error('Evaluation workspace/export binding mismatch');
  await verifyEvaluationRepository(record.repoPath, proof.binding, record.branch);
  await verifyTreeBytes(record.worktreePath, proof.binding.checkoutSha, commands().git);
}

export async function assertNotEvaluationBaseline(repoPath: string) {
  const parent = dirname(repoPath), match = /(?:^|\/)export-([a-f0-9]{64})$/.exec(parent);
  if (!match || repoPath !== join(parent, 'repo') || !await exists(join(parent, 'manifest.json'))) return;
  const path = join(parent, 'manifest.json');
  await regular(path, EVALUATION_CHECKOUT_LIMITS.manifestBytes);
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { return; }
  const parsed = RecordSchema.safeParse(value);
  if (parsed.success && parsed.data.requestDigest === match[1]) throw new Error('Immutable evaluation baseline cannot host Sandcastle worktrees; derive an independent repository');
}
export async function verifyEvaluationPreparation(repoPath: string, raw: EvaluationWorkspaceProvenance, baseSha: string) {
  const proof = EvaluationWorkspaceProvenanceSchema.parse(raw), baseline = await inspectEvaluationCheckout(proof);
  if (digestOf(evaluationWorkspaceBinding(proof.binding.exportId, baseline)) !== digestOf(proof.binding)
    || baseSha !== proof.binding.checkoutSha || inside(proof.storePath, repoPath) || inside(repoPath, proof.storePath)) throw new Error('Evaluation preparation/export binding mismatch');
  await verifyEvaluationRepository(repoPath, proof.binding);
  await verifyTreeBytes(repoPath, baseSha, commands().git);
}
