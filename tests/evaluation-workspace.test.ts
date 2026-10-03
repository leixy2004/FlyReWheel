import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportEvaluationCheckout, inspectEvaluationCheckout, type EvaluationVisibilityManifest } from '../src/workspace/evaluation-checkout.js';
import { prepareEvaluationWorkspace } from '../src/workspace/evaluation-workspace.js';
import { acquireWorkspaceExecutionLease, cleanupWorkspace, prepareWorkspace } from '../src/workspace/index.js';
import { CodexWorkspaceRequestSchema, createCodexWorkspaceRunner, type CodexWorkspaceBackend, type CodexWorkspaceRequest } from '../src/workspace/codex-runner.js';
import { verifyRuntimeCheckout } from '../src/workspace/runtime-checkout.js';
import { transferSandcastleWorkspace } from '../src/workspace/sandcastle-transfer.js';
import { workspaceEnvironment, workspaceGit } from '../src/workspace/process.js';

// DEVELOPMENT FIXTURES ONLY: author-controlled declarations and result, no model,
// live sandbox, repository program, or historical-public-availability claim.
const policy = 'exact-allowed-head-closure-v1' as const;
const authoredResult = { summary: 'Authored evaluation result; no model or target code executed' };
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
let root: string, sequence = 0;
const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('External fetch forbidden in authored evaluation fixture'); });
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-evaluation-workspace-')); });
afterAll(async () => { expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); await rm(root, { recursive: true, force: true }); });

async function snapshot(path: string) {
  const entries: Record<string, { mode: number; sha256: string }> = {};
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), stat = await lstat(file);
      expect(stat.isSymbolicLink()).toBe(false);
      if (stat.isDirectory()) await visit(file);
      else entries[relative(path, file)] = { mode: stat.mode, sha256: createHash('sha256').update(await readFile(file)).digest('hex') };
    }
  }
  await visit(path); return entries;
}
async function sourceFixture() {
  const fixtureRoot = join(root, String(++sequence)); await mkdir(fixtureRoot);
  const source = join(fixtureRoot, 'source'), storePath = join(fixtureRoot, 'store'); await mkdir(source);
  await git(source, 'init', '--quiet', '--template=', '--initial-branch=main');
  await git(source, 'config', 'user.name', 'Authored Fixture'); await git(source, 'config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(source, 'src')); await mkdir(join(source, 'tests'));
  await writeFile(join(source, '.gitignore'), '.sandcastle/\n');
  await writeFile(join(source, 'src/value.ts'), 'export const value = "unknown";\n');
  await writeFile(join(source, 'tests/value.test.ts'), '// Full committed tests retained without executing them\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Allowed authored fixture');
  const allowed = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'checkout', '-qb', 'future-answer');
  await writeFile(join(source, 'src/value.ts'), 'export const value = "FUTURE_ANSWER";\n');
  await writeFile(join(source, 'answer.txt'), 'FUTURE_ANSWER\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Future authored answer');
  const future = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'tag', '-am', 'Future answer', 'future-answer');
  const futureTag = await git(source, 'rev-parse', 'refs/tags/future-answer');
  const danglingPath = join(fixtureRoot, 'dangling.txt'); await writeFile(danglingPath, 'DANGLING_FUTURE_ANSWER\n');
  const dangling = await git(source, 'hash-object', '-w', danglingPath);
  await git(source, 'repack', '-ad');
  const manifest: EvaluationVisibilityManifest = { schemaVersion: 1, repositoryId: 'authored/evaluation-workspace', classification: 'development-fixture',
    allowedHeads: [allowed], checkoutSha: allowed, visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: null, evidenceDigests: [] } };
  return { fixtureRoot, source, storePath, allowed, future, futureTag, dangling, manifest,
    workspace: { repoPath: join(fixtureRoot, 'derived'), runId: `evaluation-${sequence}`, attemptId: 'one' }, exportId: 'authored-export' };
}
async function fixture() {
  const source = await sourceFixture();
  const baseline = await exportEvaluationCheckout({ repoPath: source.source, storePath: source.storePath, manifest: source.manifest });
  const originalBaseline = await snapshot(baseline.exportPath);
  const prepared = await prepareEvaluationWorkspace({ ...source.workspace, exportId: source.exportId, storePath: source.storePath, manifest: source.manifest });
  const request: CodexWorkspaceRequest = { workspace: source.workspace, expectedSha: source.allowed, model: 'authored-model',
    toolPolicy: 'full-repo-shell-v1', historyPolicy: policy, evaluation: prepared.evaluation, prompt: 'Inspect authored fixture only',
    limits: { maxInputBytes: 32_768, maxOutputBytes: 4096, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 20_000, cleanupTimeoutMs: 2000 } };
  return { ...source, baseline, originalBaseline, prepared, request };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function authoredBackend(f: Fixture, tamper?: 'object' | 'ref' | 'remote-ref' | 'remote-head' | 'binding' | 'observation-binding') {
  const calls: string[] = [], commands: string[] = [];
  const runtimeRepo = join(f.fixtureRoot, 'runtime'), bundle = join(f.fixtureRoot, 'transferred.bundle');
  let bundleBytes = Buffer.alloc(0);
  const runtimeRefs: string[] = [];
  const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve(request, record) {
    calls.push('reserve');
    return {
      async prepare(signal) {
        calls.push('prepare');
        await transferSandcastleWorkspace(record, {
          async exec(command, cwd) {
            commands.push(command); expect(cwd === undefined || cwd === '/workspace/repo').toBe(true);
            return { stdout: command === 'mktemp -d -t sandcastle-XXXXXX' ? '/tmp/sandcastle-AUTHORED\n'
              : command === 'git rev-parse HEAD' ? record.baseSha + '\n' : '', stderr: '', exitCode: 0 };
          },
          async upload(path, chunks) {
            expect(path).toBe('/tmp/sandcastle-AUTHORED/repo.bundle');
            for await (const chunk of chunks) bundleBytes = Buffer.concat([bundleBytes, chunk]);
          },
        }, { maxBundleBytes: 1_000_000, signal });
        await writeFile(bundle, bundleBytes);
        // Clone only the actual transferred bundle; no source/store access, shared
        // object directory, local clone shortcut, fetch, or copied object fixture.
        await promisify(execFile)('/usr/bin/git', ['clone', '--no-local', bundle, runtimeRepo], { cwd: f.fixtureRoot,
          env: { ...workspaceEnvironment(), GIT_ALLOW_PROTOCOL: 'file' }, timeout: 10_000 });
        await git(runtimeRepo, 'checkout', record.branch);
        runtimeRefs.push(...(await git(runtimeRepo, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)')).split('\n'));
        expect(await git(runtimeRepo, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(join(runtimeRepo, '.git'));
        await expect(access(join(runtimeRepo, '.git/objects/info/alternates'))).rejects.toThrow();
        for (const oid of [f.future, f.futureTag, f.dangling]) await expect(git(runtimeRepo, 'cat-file', '-e', oid)).rejects.toThrow();
        if (tamper === 'object') await git(runtimeRepo, 'hash-object', '-w', join(f.fixtureRoot, 'dangling.txt'));
        if (tamper === 'ref') await git(runtimeRepo, 'update-ref', 'refs/heads/injected', f.allowed);
        if (tamper === 'remote-ref') await git(runtimeRepo, 'update-ref', 'refs/remotes/untrusted/allowed', f.allowed);
        if (tamper === 'remote-head') await git(runtimeRepo, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/allowed-${f.allowed}`);
        const evaluation = tamper === 'binding' ? { ...request.evaluation!, inventory: { ...request.evaluation!.inventory, digest: '0'.repeat(64) } } : request.evaluation;
        const observed = await verifyRuntimeCheckout(runtimeRepo, request.expectedSha, record.branch, request.historyPolicy, f.fixtureRoot, evaluation);
        return tamper === 'observation-binding' ? { ...observed, evaluation: { ...evaluation!, recordDigest: '0'.repeat(64) } } : observed;
      },
      async execute() { calls.push('execute'); return authoredResult; },
      async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
      async collect() { calls.push('collect'); return []; },
      async destroy() { calls.push('destroy'); await rm(runtimeRepo, { recursive: true, force: true }); return { destroyed: true, verified: true }; },
    };
  } };
  return { backend, calls, commands, runtimeRepo, bundle, runtimeRefs };
}
async function assertBaselineUnchanged(f: Fixture) {
  expect(await inspectEvaluationCheckout({ storePath: f.storePath, manifest: f.manifest })).toEqual(f.baseline);
  expect(await snapshot(f.baseline.exportPath)).toEqual(f.originalBaseline);
}

describe('optional exact-head evaluation workspace with authored execution only', () => {
  it('uses the real Sandcastle bundle, verifies a standalone runtime, and never mutates immutable export metadata', async () => {
    const f = await fixture(), backend = authoredBackend(f);
    await assertBaselineUnchanged(f);
    expect(f.prepared.record.repoPath).not.toBe(f.baseline.repoPath);
    expect(f.prepared.evaluation.recordDigest).toBe(f.baseline.recordDigest);
    const sourceRefs = await git(f.source, 'show-ref');
    const result = await createCodexWorkspaceRunner(backend.backend).run(f.request);
    expect(result, result.errors.join(' ') + '\nActual runtime refs: ' + backend.runtimeRefs.join('\n')).toMatchObject({ execution: 'succeeded', cleanup: 'verified', output: authoredResult, backend: 'authored-test-no-isolation' });
    expect(backend.calls).toEqual(['reserve', 'prepare', 'execute', 'stop', 'collect', 'destroy']);
    expect(backend.commands).toContain('git clone "/tmp/sandcastle-AUTHORED/repo.bundle" "/workspace/repo_clone"');
    expect(backend.commands).toContain(`git checkout "${f.prepared.record.branch}"`);
    const bundleRefs = await git(f.workspace.repoPath, 'bundle', 'list-heads', backend.bundle);
    expect(bundleRefs).toContain(f.allowed); expect(bundleRefs).not.toContain(f.future); expect(bundleRefs).not.toContain('future-answer');
    expect(await readFile(join(f.prepared.record.worktreePath, 'src/value.ts'), 'utf8')).toContain('"unknown"');
    expect(await readFile(join(f.prepared.record.worktreePath, 'tests/value.test.ts'), 'utf8')).toContain('Full committed tests');
    await expect(access(result.leasePath)).rejects.toThrow();
    await assertBaselineUnchanged(f);
    expect((await cleanupWorkspace(f.workspace)).record.status).toBe('closed-clean');
    await assertBaselineUnchanged(f);
    expect(await git(f.source, 'show-ref')).toBe(sourceRefs);
  }, 30_000);

  it.each(['object', 'ref'] as const)('rejects added derived %s before backend reservation', async tamper => {
    const f = await fixture(), backend = authoredBackend(f);
    if (tamper === 'object') await git(f.workspace.repoPath, 'hash-object', '-w', join(f.fixtureRoot, 'dangling.txt'));
    else await git(f.workspace.repoPath, 'update-ref', 'refs/heads/injected', f.allowed);
    await expect(createCodexWorkspaceRunner(backend.backend).run(f.request)).rejects.toThrow(/inventory|ref visibility/);
    expect(backend.calls).toEqual([]); await assertBaselineUnchanged(f);
  }, 30_000);

  it.each(['object', 'ref', 'remote-ref', 'remote-head', 'binding', 'observation-binding'] as const)('rejects runtime %s tampering before execute and still runs cleanup', async tamper => {
    const f = await fixture(), backend = authoredBackend(f, tamper);
    const result = await createCodexWorkspaceRunner(backend.backend).run(f.request);
    expect(result).toMatchObject({ execution: 'failed', cleanup: 'verified', output: null });
    expect(backend.calls).toEqual(['reserve', 'prepare', 'stop', 'collect', 'destroy']);
    expect(result.errors.join(' ')).toMatch(tamper === 'object' ? /inventory/ : ['ref', 'remote-ref', 'remote-head'].includes(tamper) ? /ref visibility|alias/
      : tamper === 'binding' ? /inventory binding/ : /history-policy/);
    await expect(access(result.leasePath)).rejects.toThrow();
    await assertBaselineUnchanged(f);
  }, 30_000);

  it('requires a previously exported baseline and refuses workspaces inside that immutable store', async () => {
    const f = await sourceFixture(); await mkdir(f.storePath);
    await expect(prepareEvaluationWorkspace({ ...f.workspace, exportId: f.exportId, storePath: f.storePath, manifest: f.manifest })).rejects.toThrow();
    await expect(access(f.workspace.repoPath)).rejects.toThrow();
    const baseline = await exportEvaluationCheckout({ repoPath: f.source, storePath: f.storePath, manifest: f.manifest });
    await expect(prepareEvaluationWorkspace({ ...f.workspace, repoPath: join(f.storePath, 'derived'), exportId: f.exportId, storePath: f.storePath, manifest: f.manifest })).rejects.toThrow(/independent/);
    await expect(prepareWorkspace({ ...f.workspace, repoPath: baseline.repoPath, baseSha: f.allowed })).rejects.toThrow(/baseline|immutable|evaluation/i);
    expect(await inspectEvaluationCheckout({ storePath: f.storePath, manifest: f.manifest })).toEqual(baseline);
  }, 30_000);

  it('rejects missing or mismatched export binding before runtime reservation', async () => {
    const f = await fixture(), backend = authoredBackend(f), runner = createCodexWorkspaceRunner(backend.backend);
    const { evaluation: _evaluation, ...missing } = f.request;
    await expect(runner.run(missing)).rejects.toThrow(/binding/);
    await expect(runner.run({ ...f.request, historyPolicy: 'all-local-refs-v1' })).rejects.toThrow(/binding/);
    for (const patch of [{ recordDigest: '0'.repeat(64) }, { exportId: 'different-export' }, { requestDigest: '0'.repeat(64) }]) {
      const result = await runner.run({ ...f.request, evaluation: { ...f.prepared.evaluation, ...patch } });
      expect(result).toMatchObject({ execution: 'failed', cleanup: 'verified' });
      expect(result.errors.join(' ')).toMatch(/binding mismatch/);
      await expect(access(result.leasePath)).rejects.toThrow();
    }
    expect(backend.calls).toEqual([]);
  }, 30_000);

  it('revalidates immutable baseline at launch before backend reservation', async () => {
    const f = await fixture(), backend = authoredBackend(f);
    await writeFile(join(f.baseline.repoPath, '.git/config'), (await readFile(join(f.baseline.repoPath, '.git/config'), 'utf8')) + '\n');
    await expect(createCodexWorkspaceRunner(backend.backend).run(f.request)).rejects.toThrow(/metadata\/storage digest/);
    expect(backend.calls).toEqual([]);
  }, 30_000);

  it('rejects derived ref mutation during the real transfer before any worker can execute', async () => {
    const f = await fixture(), lease = await acquireWorkspaceExecutionLease(f.workspace, f.allowed);
    let uploads = 0;
    try {
      await expect(transferSandcastleWorkspace(f.prepared.record, {
        async exec(command) { return { stdout: command === 'mktemp -d -t sandcastle-XXXXXX' ? '/tmp/sandcastle-AUTHORED\n'
          : command === 'git rev-parse HEAD' ? f.allowed + '\n' : '', stderr: '', exitCode: 0 }; },
        async upload(_path, chunks) { for await (const _chunk of chunks) { /* Consume real bounded bundle */ } uploads++;
          await git(f.workspace.repoPath, 'update-ref', 'refs/heads/injected-during-transfer', f.allowed); },
      }, { maxBundleBytes: 1_000_000, signal: new AbortController().signal })).rejects.toThrow(/ref visibility/);
      expect(uploads).toBe(1); await assertBaselineUnchanged(f);
    } finally { await lease.release(); }
  }, 30_000);

  it('keeps legacy all-local-refs request JSON and request digest unchanged with no evaluation field', async () => {
    const f = await sourceFixture();
    const legacyWorkspace = { repoPath: f.source, runId: 'legacy', attemptId: 'one' };
    const prepared = await prepareWorkspace({ ...legacyWorkspace, baseSha: f.allowed });
    const request: CodexWorkspaceRequest = { workspace: legacyWorkspace, expectedSha: f.allowed, model: 'authored-model',
      toolPolicy: 'full-repo-shell-v1', historyPolicy: 'all-local-refs-v1', prompt: 'Legacy authored fixture',
      limits: { maxInputBytes: 32_768, maxOutputBytes: 4096, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 20_000, cleanupTimeoutMs: 2000 } };
    const legacyJson = JSON.stringify(request), digest = createHash('sha256').update(legacyJson).digest('hex');
    expect(JSON.stringify(CodexWorkspaceRequestSchema.parse(request))).toBe(legacyJson);
    expect(prepared.record).not.toHaveProperty('evaluation');
    const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve(parsed) {
      expect(parsed).not.toHaveProperty('evaluation');
      return { async prepare() { return { expectedSha: f.allowed, headSha: f.allowed, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
        async execute() { return authoredResult; }, async stop() { return { stopped: true, verified: true }; },
        async collect() { return []; }, async destroy() { return { destroyed: true, verified: true }; } };
    } };
    expect(await createCodexWorkspaceRunner(backend).run(request)).toMatchObject({ execution: 'succeeded', cleanup: 'verified', requestDigest: digest });
    expect(await git(prepared.record.worktreePath, 'cat-file', '-t', f.future)).toBe('commit');
    await cleanupWorkspace(legacyWorkspace);
  }, 30_000);
});
