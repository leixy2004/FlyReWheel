import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace, cleanupWorkspace, acquireWorkspaceExecutionLease } from '../src/workspace/index.js';
import { workspaceGit } from '../src/workspace/process.js';
import { CodexWorkspaceRequestSchema, createCodexWorkspaceRunner, type CodexWorkspaceRequest, type CodexWorkspaceBackend, type CodexWorkspaceRuntime } from '../src/workspace/codex-runner.js';

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-runner-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const git = async (cwd: string, ...args: string[]) => (await workspaceGit(cwd, ...args)).trim();
async function fixture(name: string) {
  const repoPath = join(root, name); await mkdir(repoPath);
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Authored Fixture');
  await git(repoPath, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n');
  await writeFile(join(repoPath, 'value.txt'), 'base\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'base');
  const expectedSha = await git(repoPath, 'rev-parse', 'HEAD');
  await writeFile(join(repoPath, 'value.txt'), 'future\n');
  await git(repoPath, 'add', '.'); await git(repoPath, 'commit', '-m', 'future');
  const headSha = await git(repoPath, 'rev-parse', 'HEAD');
  const workspace = { repoPath, runId: name, attemptId: 'one' };
  const prepared = await prepareWorkspace({ ...workspace, baseSha: expectedSha, headSha });
  const request: CodexWorkspaceRequest = { workspace, expectedSha, model: 'authored-test-model', prompt: 'Inspect the authored fixture',
    toolPolicy: 'full-repo-shell-v1', historyPolicy: 'all-local-refs-v1',
    limits: { maxInputBytes: 32_768, maxOutputBytes: 4096, maxArtifactBytes: 4096, maxArtifacts: 3, timeoutMs: 1000, cleanupTimeoutMs: 500 },
  };
  const calls: string[] = [];
  const runtime: CodexWorkspaceRuntime = {
    async prepare() { calls.push('prepare'); return { expectedSha, headSha: expectedSha, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
    async execute() { calls.push('execute'); return { summary: 'authored result' }; },
    async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
    async collect() { calls.push('collect'); return [{ name: 'report.json', bytes: Buffer.from('{"ok":true}') }]; },
    async destroy() { calls.push('destroy'); return { destroyed: true, verified: true }; },
  };
  const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve() { calls.push('reserve'); return runtime; } };
  return { request, prepared, calls, runtime, backend, headSha };
}

describe('bounded workspace lifecycle contract (injected authored backend, no production sandbox)', () => {
  it('checks base checkout (not headSha), collects after verified stop and destroys afterward', async () => {
    const f = await fixture('success');
    const result = await createCodexWorkspaceRunner(f.backend).run(f.request);
    expect(result).toMatchObject({ execution: 'succeeded', cleanup: 'verified', output: { summary: 'authored result' }, backend: 'authored-test-no-isolation' });
    expect(f.calls).toEqual(['reserve', 'prepare', 'execute', 'stop', 'collect', 'destroy']);
    expect(result.lifecycle).toContain('runtime-workspace-verified');
    expect(result.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(access(result.leasePath)).rejects.toThrow();
    expect(await git(f.prepared.record.worktreePath, 'show', `${f.headSha}:value.txt`)).toBe('future');
    expect((await cleanupWorkspace(f.request.workspace)).record.status).toBe('closed-clean');
  });
  it('fails closed without production backend or when credential/env fields enter the request', async () => {
    const f = await fixture('no-backend');
    await expect(createCodexWorkspaceRunner().run(f.request)).rejects.toThrow(/not configured/);
    await expect(createCodexWorkspaceRunner().run({ ...f.request, outputContract: 'pr-mining-v1' })).rejects.toThrow(/not configured/);
    await expect(createCodexWorkspaceRunner(f.backend).run({ ...f.request, env: { CODEX_API_KEY: 'not-a-key' } } as CodexWorkspaceRequest)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it('preserves the default request and carries the fixed mining selector in the reserved request and digest', async () => {
    const f = await fixture('mining-contract');
    expect(CodexWorkspaceRequestSchema.parse(f.request)).toEqual(f.request);
    const runner = createCodexWorkspaceRunner(f.backend), legacy = await runner.run(f.request);
    const reserve = f.backend.reserve;
    f.backend.reserve = (request, workspace) => {
      expect(request.outputContract).toBe('pr-mining-v1');
      return reserve(request, workspace);
    };
    const mining = await runner.run({ ...f.request, outputContract: 'pr-mining-v1' });
    expect(mining).toMatchObject({ execution: 'succeeded', cleanup: 'verified', backend: 'authored-test-no-isolation' });
    expect(mining.requestDigest).not.toBe(legacy.requestDigest);
    for (const patch of [{ outputContract: 'unrecognized' }, { outputContract: null }, { outputSchema: { type: 'object' } }]) {
      expect(CodexWorkspaceRequestSchema.safeParse({ ...f.request, ...patch }).success).toBe(false);
    }
  });
  it('refuses SHA mismatch and dirty workspace before runtime creation', async () => {
    const f = await fixture('preflight');
    await expect(createCodexWorkspaceRunner(f.backend).run({ ...f.request, expectedSha: f.headSha })).rejects.toThrow(/exact expected base SHA/);
    await writeFile(join(f.prepared.record.worktreePath, 'value.txt'), 'dirty\n');
    await expect(createCodexWorkspaceRunner(f.backend).run(f.request)).rejects.toThrow(/ready, clean/);
    expect(f.calls).toEqual([]);
  });
  it('protects cooperative cleanup and concurrent execution while the lease is held', async () => {
    const f = await fixture('lease');
    f.runtime.execute = async () => {
      await expect(cleanupWorkspace(f.request.workspace)).rejects.toThrow(/lease is active/);
      await expect(acquireWorkspaceExecutionLease(f.request.workspace, f.request.expectedSha)).rejects.toThrow(/lease is active/);
      return { verified: true };
    };
    expect((await createCodexWorkspaceRunner(f.backend).run(f.request)).cleanup).toBe('verified');
  });
  it('rejects Sandcastle env files without reading or forwarding their contents', async () => {
    const f = await fixture('env');
    await writeFile(join(f.request.workspace.repoPath, '.sandcastle', '.env'), 'CODEX_API_KEY=\n');
    const result = await createCodexWorkspaceRunner(f.backend).run(f.request);
    expect(result.errors[0]).toMatch(/env forwarding is forbidden/);
    expect(result.cleanup).toBe('verified');
    expect(f.calls).toEqual([]);
  });
  it('rejects a mismatched runtime checkout before worker launch and still cleans up', async () => {
    const f = await fixture('runtime-sha');
    f.runtime.prepare = async () => ({ expectedSha: f.request.expectedSha, headSha: f.headSha, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' });
    const result = await createCodexWorkspaceRunner(f.backend).run(f.request);
    expect(result.execution).toBe('failed'); expect(result.cleanup).toBe('verified');
    expect(f.calls).not.toContain('execute');
  });
  it.each(['cancelled', 'timed-out'] as const)('stops, collects, and destroys after %s', async status => {
    const f = await fixture(status);
    const controller = new AbortController();
    f.runtime.execute = async () => { if (status === 'cancelled') controller.abort(); return await new Promise(() => {}); };
    f.request.limits.timeoutMs = 30;
    const result = await createCodexWorkspaceRunner(f.backend).run(f.request, controller.signal);
    expect(result.execution).toBe(status); expect(result.cleanup).toBe('verified');
    expect(f.calls.slice(-3)).toEqual(['stop', 'collect', 'destroy']);
  });
  it.each(['stop', 'collect', 'destroy'] as const)('retains a blocking recovery lease after %s failure', async stage => {
    const f = await fixture(`failed-${stage}`);
    if (stage === 'stop') f.runtime.stop = async () => { f.calls.push('stop'); return { stopped: true, verified: false }; };
    if (stage === 'collect') f.runtime.collect = async () => { f.calls.push('collect'); throw new Error('artifact read failed'); };
    if (stage === 'destroy') f.runtime.destroy = async () => { f.calls.push('destroy'); return { destroyed: false, verified: false }; };
    const result = await createCodexWorkspaceRunner(f.backend).run(f.request);
    expect(result.execution).toBe('failed'); expect(result.cleanup).toBe('retained-for-recovery');
    await expect(access(result.leasePath)).resolves.toBeUndefined();
    await expect(cleanupWorkspace(f.request.workspace)).rejects.toThrow(/lease is active/);
    if (stage === 'stop') expect(f.calls).not.toContain('collect');
    if (stage !== 'destroy') expect(f.calls).not.toContain('destroy');
  });
  it.each(['count', 'bytes'] as const)('retains evidence on artifact %s overflow', async bound => {
    const f = await fixture('artifact-' + bound);
    f.runtime.collect = async () => bound === 'count'
      ? Array.from({length:4}, (_, i) => ({name:`item-${i}`,bytes:Buffer.from('x')}))
      : [{name:'large.txt',bytes:Buffer.alloc(4097)}];
    const result = await createCodexWorkspaceRunner(f.backend).run(f.request);
    expect(result.cleanup).toBe('retained-for-recovery'); expect(f.calls).not.toContain('destroy');
    expect(result.errors.join(' ')).toMatch(/Artifact (count|bytes) exceed/);
  });
  it('rejects output and artifact bounds and never destroys uncollected evidence', async () => {
    const f = await fixture('limits');
    f.runtime.execute = async () => 'x'.repeat(8192);
    f.runtime.collect = async () => [{ name: '../escape', bytes: Buffer.from('bad') }];
    const result = await createCodexWorkspaceRunner(f.backend).run(f.request);
    expect(result.errors.join('\n')).toMatch(/output exceeds/);
    expect(result.errors.join('\n')).toMatch(/Invalid or duplicate artifact/);
    expect(result.cleanup).toBe('retained-for-recovery'); expect(f.calls).not.toContain('destroy');
  });
});
