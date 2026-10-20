// Real managed-worktree operations on a fresh authored repository only.
// No model, credential, network, runtime allocation or production authority.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { workspaceGit } from '../dist/workspace/process.js';
import { inspectWorkspace } from '../dist/workspace/index.js';
import { createLocalDevelopmentResolver } from '../dist/local-development-workspace.js';
const directory = resolve(process.argv[2] ?? '/tmp/flyrewheel-local-development'), exec = promisify(execFile);
await mkdir(directory); const repoPath = join(directory, 'authored-repository'); await mkdir(repoPath);
const git = async (...args) => (await workspaceGit(repoPath, ...args)).trim();
await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Authored Lifecycle Verification');
await git('config', 'user.email', 'fixture@example.invalid');
await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\nignored/\n'); await writeFile(join(repoPath, 'source.txt'), 'before\n');
await git('add', '.'); await git('commit', '-m', 'authored before'); const baseSha = await git('rev-parse', 'HEAD');
await writeFile(join(repoPath, 'source.txt'), 'after\n'); await git('add', '.'); await git('commit', '-m', 'authored after'); const headSha = await git('rev-parse', 'HEAD');
const selection = { workspaceId: 'development-verification', jobDigest: 'a'.repeat(64), repository: 'fixture:development-lifecycle', kind: 'semantic-review', baseSha, headSha, expectedSha: headSha };
const save = async (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n');
await save('input.json', { repoPath, selection });
const commands = [];
const invoke = async (binary, args, name, expected = 0) => {
  const command = [binary, ...args], result = await exec(process.execPath, command, { timeout: 30_000, maxBuffer: 4_000_000 })
    .then(value => ({ ...value, code: 0 }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  assert.equal(result.code, expected, result.stderr); commands.push({ command: ['node', ...command], exitCode: result.code });
  if (name) await writeFile(join(directory, name), result.stdout);
  return result.stdout ? JSON.parse(result.stdout) : null;
};
const created = await invoke('dist/cli.js', ['workspace', 'local', 'create', '--file', join(directory, 'input.json')], 'receipt.json');
const file = join(directory, 'receipt.json');
const status = await invoke('dist/cli.js', ['workspace', 'local', 'status', '--file', file], 'ready.json');
assert.equal(status.localDevelopment, 'ready'); assert.equal(status.productionReady, false);
const resolver = await createLocalDevelopmentResolver(created);
assert.deepEqual(await resolver(selection, new AbortController().signal), created.receipt.workspace);
const localWorker = await invoke('dist/worker.js', ['--check', '--local-development', file], 'worker-local-preflight.json');
await invoke('dist/worker.js', ['--local-development', file], null, 1);
assert.equal(localWorker.localDevelopment, 'ready'); assert.equal(localWorker.workerExecution, 'not_supported_by_development_adapter');
const config = JSON.parse(await readFile('examples/worker/preflight-only.json', 'utf8')); config.preparedWorkspaces = status.preparedWorkspaces;
await save('production-preflight-only.json', config);
const production = await invoke('dist/worker.js', ['--check', '--config', join(directory, 'production-preflight-only.json')], 'worker-production-preflight.json');
assert.equal(production.status, 'blocked'); assert.ok(production.issues.some(issue => issue.code === 'lifecycle_authority_required'));
const initialEvidence = await invoke('dist/cli.js', ['workspace', 'local', 'evidence', '--file', file, '--digest', created.receipt.createdEvidenceDigest], 'initial-evidence.json');
const cleaned = await invoke('dist/cli.js', ['workspace', 'local', 'cleanup', '--file', file], 'cleanup.json');
assert.equal(cleaned.cleanup, 'owned-clean-worktree-removed'); assert.equal(cleaned.worktreeExists, false);
assert.equal(cleaned.physicalDestruction, 'unsupported-not-claimed');
const afterRestart = await invoke('dist/worker.js', ['--check', '--local-development', file], 'worker-after-cleanup.json');
assert.equal(afterRestart.localDevelopment, 'not_ready');
assert.deepEqual(await invoke('dist/cli.js', ['workspace', 'local', 'evidence', '--file', file, '--digest', created.receipt.createdEvidenceDigest]), initialEvidence);
await invoke('dist/cli.js', ['workspace', 'local', 'evidence', '--file', file, '--digest', cleaned.afterEvidence.digest], 'cleanup-evidence.json');
assert.equal(await git('rev-parse', 'HEAD'), headSha); assert.equal(await readFile(join(repoPath, 'source.txt'), 'utf8'), 'after\n');
// A second independent allocation is deliberately changed; CLI cleanup must retain it.
const dirty = await invoke('dist/cli.js', ['workspace', 'local', 'create', '--file', join(directory, 'input.json')], 'dirty-receipt.json');
assert.notEqual(dirty.receipt.workspace.attemptId, created.receipt.workspace.attemptId);
const dirtyObservation = await inspectWorkspace(dirty.receipt.workspace);
await writeFile(join(dirtyObservation.record.worktreePath, 'source.txt'), 'retain this authored user change\n');
const retained = await invoke('dist/cli.js', ['workspace', 'local', 'cleanup', '--file', join(directory, 'dirty-receipt.json')], 'dirty-cleanup.json', 2);
assert.equal(retained.cleanup, 'retained'); assert.equal(retained.worktreeExists, true);
assert.equal(await readFile(join(dirtyObservation.record.worktreePath, 'source.txt'), 'utf8'), 'retain this authored user change\n');
const evidence = { status: 'passed', source: 'fresh authored local Git repository only', directory, commands,
  checks: { fixedHead: headSha, exactResolverBinding: true, crossProcessReadback: true, cleanOwnedWorktreeRemoved: true,
    sourceFilesAndMainHeadUnchanged: true, dirtyWorktreeRetained: true, evidenceReadableAfterCleanup: true,
    localPreflight: 'ready-before-cleanup-not-ready-after', productionPreflight: 'blocked-lifecycle-authority-required' },
  guaranteesNotProvided: ['security isolation', 'arbitrary repository program execution', 'whole-runtime stop', 'externally frozen snapshot', 'physical resource destruction'],
  preserved: ['source repository', 'attempt branches', 'manifest/history', 'content-addressed evidence', 'dirty worktree'],
  modelExecution: 'not_run', sandboxAllocation: 'not_performed', credentialAccess: 'none', W1: 'not_read', productionReady: false };
await save('verification.json', evidence); console.log(JSON.stringify(evidence, null, 2));
