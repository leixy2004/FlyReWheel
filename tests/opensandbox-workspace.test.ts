import { describe, expect, it, vi } from 'vitest';
import type { SandboxCreateOptions, ServerStreamEvent } from '@alibaba-group/opensandbox';
import { createOpenSandboxWorkspaceBackend, type OpenSandboxWorkspaceConfig, type OpenSandboxClient,
  type OpenSandboxLifecycleAuthority } from '../src/adapters/opensandbox-workspace.js';
import type { CodexWorkspaceRequest } from '../src/workspace/codex-runner.js';
import type { WorkspaceRecord } from '../src/workspace/index.js';

const sha = 'a'.repeat(40);
const config: OpenSandboxWorkspaceConfig = { endpoint: 'https://sandbox.example.invalid', apiKey: 'AUTHORED-NOT-A-SECRET',
  image: `example.invalid/worker@sha256:${'b'.repeat(64)}`, cpu: '1', memory: '2Gi', maxBundleBytes: 1024,
  workerExecutable: '/opt/flyrewheel/worker', gatewayHost: 'gateway.example.invalid' };
const request: CodexWorkspaceRequest = { workspace: { repoPath: '/fixture', runId: 'run', attemptId: 'one' }, expectedSha: sha,
  model: 'authored-model', prompt: 'Authored fixture', toolPolicy: 'full-repo-shell-v1', historyPolicy: 'all-local-refs-v1',
  limits: { maxInputBytes: 8192, maxOutputBytes: 4096, maxArtifactBytes: 128, maxArtifacts: 2, timeoutMs: 1000, cleanupTimeoutMs: 500 } };
const workspace = { ...request.workspace, branch: 'attempt/run--one', baseSha: sha, worktreePath: '/fixture/worktree' } as WorkspaceRecord;
const observation = { expectedSha: sha, headSha: sha, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' };
const signal = () => new AbortController().signal;
function fixture(outputContract?: CodexWorkspaceRequest['outputContract']) {
  const calls: string[] = []; let events: ServerStreamEvent[] | undefined;
  const authority: OpenSandboxLifecycleAuthority = {
    preflight: vi.fn(async () => { calls.push('preflight'); }),
    stopAndVerify: vi.fn(async () => { calls.push('stop'); return { stopped: true, verified: true }; }),
    collectFrozen: vi.fn(async function* () { calls.push('collect'); yield { name: 'report.json', chunks: (async function* () { yield Buffer.from('evidence'); })() }; }),
    destroyAndVerify: vi.fn(async () => { calls.push('destroy'); return { destroyed: true, verified: true }; }),
  };
  const client = {
    id: 'authored-sandbox',
    commands: { runStream: vi.fn(async function* (command: string | string[]) {
      calls.push(Array.isArray(command) ? command[1] : 'command');
      if (events) { yield* events; return; }
      yield { type: 'stdout', text: JSON.stringify(Array.isArray(command) && command[1] === 'verify' ? observation : { authored: true }) };
      yield { type: 'execution_complete' };
    }) },
    files: { createDirectories: vi.fn(async () => { calls.push('mkdir'); }), writeFiles: vi.fn(async () => { calls.push('write'); }) },
    kill: vi.fn(async () => { calls.push('kill-ack'); }), close: vi.fn(async () => { calls.push('close-client'); }),
  } as unknown as OpenSandboxClient;
  const create = vi.fn(async (_options: SandboxCreateOptions) => { calls.push('create'); return client; });
  const transfer = vi.fn(async () => { calls.push('transfer'); });
  const backend = createOpenSandboxWorkspaceBackend(config, { authority, createSandbox: create, transfer });
  const runtime = backend.reserve({ ...request, ...(outputContract === undefined ? {} : { outputContract }) }, workspace);
  return { calls, authority, client, create, transfer, backend, runtime, setEvents(value: ServerStreamEvent[]) { events = value; } };
}

describe('official OpenSandbox-shaped client integration, no live cluster', () => {
  it.each([undefined, 'pr-mining-v1'] as const)('fails closed without authority before allocating and proves no-runtime cleanup (contract %s)', async outputContract => {
    const create = vi.fn();
    const runtime = createOpenSandboxWorkspaceBackend(config, { createSandbox: create }).reserve({ ...request, outputContract }, workspace);
    await expect(runtime.prepare(signal())).rejects.toThrow(/production blocked/);
    expect(create).not.toHaveBeenCalled();
    expect(await runtime.stop()).toEqual({ stopped: true, verified: true });
    expect(await runtime.collect(request.limits)).toEqual([]);
    expect(await runtime.destroy()).toEqual({ destroyed: true, verified: true });
  });
  it('uses explicit immutable config, secret-free sandbox data, bounded streams and authoritative receipts', async () => {
    const f = fixture(); expect(f.calls).toEqual([]);
    expect(await f.runtime.prepare(signal())).toEqual(observation);
    expect(await f.runtime.execute(signal())).toEqual({ authored: true });
    expect(await f.runtime.stop()).toEqual({ stopped: true, verified: true });
    expect(await f.runtime.collect(request.limits)).toEqual([{ name: 'report.json', bytes: Buffer.from('evidence') }]);
    expect(await f.runtime.destroy()).toEqual({ destroyed: true, verified: true });
    expect(f.calls).toEqual(['preflight', 'create', 'transfer', 'verify', 'mkdir', 'write', 'run', 'stop', 'collect', 'kill-ack', 'destroy', 'close-client']);
    const { connectionConfig, ...createData } = f.create.mock.calls[0][0];
    expect(createData).toMatchObject({ env: {}, volumes: [], image: config.image, resource: { cpu: '1', memory: '2Gi' },
      networkPolicy: { defaultAction: 'deny', egress: [{ action: 'allow', target: config.gatewayHost }] } });
    expect(JSON.stringify(createData)).not.toContain(config.apiKey);
    expect(f.authority.preflight).toHaveBeenCalledWith(expect.not.objectContaining({ apiKey: expect.anything() }), expect.objectContaining({ allocationId: expect.any(String) }));
    expect(f.client.files.writeFiles).toHaveBeenCalledWith([expect.objectContaining({ path: '/run/flyrewheel/request.json', mode: 600 })]);
    const data = vi.mocked(f.client.files.writeFiles).mock.calls[0][0][0].data;
    expect(JSON.stringify(data)).not.toContain(config.apiKey);
    expect(JSON.parse(data as string)).not.toHaveProperty('outputContract');
    expect(connectionConfig).toMatchObject({ disableMetrics: true, useServerProxy: true });
  });
  it('relays only the fixed mining selector in the authored client request, no live model or cluster', async () => {
    const f = fixture('pr-mining-v1');
    await f.runtime.prepare(signal()); await f.runtime.execute(signal());
    const data = vi.mocked(f.client.files.writeFiles).mock.calls[0][0][0].data;
    expect(JSON.parse(data as string)).toEqual({ workingDirectory: '/workspace/repo', model: request.model, prompt: request.prompt,
      outputContract: 'pr-mining-v1', toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits });
    await f.runtime.stop(); await f.runtime.collect(request.limits); await f.runtime.destroy();
  });
  it('cannot treat API kill acknowledgement as destruction proof', async () => {
    const f = fixture(); await f.runtime.prepare(signal()); await f.runtime.stop(); await f.runtime.collect(request.limits);
    f.authority.destroyAndVerify = async () => ({ destroyed: true, verified: false });
    expect(await f.runtime.destroy()).toEqual({ destroyed: false, verified: false });
    expect(f.client.kill).toHaveBeenCalled(); expect(f.client.close).not.toHaveBeenCalled();
  });
  it('does not collect or destroy when stop is unverified', async () => {
    const f = fixture(); await f.runtime.prepare(signal());
    f.authority.stopAndVerify = async () => ({ stopped: true, verified: false });
    expect(await f.runtime.stop()).toEqual({ stopped: false, verified: false });
    await expect(f.runtime.collect(request.limits)).rejects.toThrow(/verified stopped/);
    await expect(f.runtime.destroy()).rejects.toThrow(/stop/);
    expect(f.client.kill).not.toHaveBeenCalled();
  });
  it('fences a late create before transfer or worker launch and reconciles its allocation token', async () => {
    const f = fixture(); let finish!: (client: OpenSandboxClient) => void;
    f.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const preparation = f.runtime.prepare(signal()); await vi.waitFor(() => expect(finish).toBeDefined());
    const rejected = expect(preparation).rejects.toThrow(/preparation failed/);
    const stopping = f.runtime.stop(); finish(f.client); await rejected;
    expect(await stopping).toEqual({ stopped: true, verified: true });
    expect(f.transfer).not.toHaveBeenCalled(); expect(f.client.commands.runStream).not.toHaveBeenCalled();
    expect(f.authority.stopAndVerify).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'authored-sandbox', allocationId: expect.any(String) }));
  });
  it('reconciles unknown partial allocation on create failure and suppresses raw credential-bearing errors', async () => {
    const f = fixture(); f.create.mockRejectedValueOnce(new Error(config.apiKey));
    await expect(f.runtime.prepare(signal())).rejects.toThrow('OpenSandbox preparation failed; allocation requires authoritative reconciliation');
    await f.runtime.stop();
    expect(f.authority.stopAndVerify).toHaveBeenCalledWith({ allocationId: expect.any(String) });
  });
  it.each(['oversize', 'missing', 'duplicate', 'error', 'post-completion'] as const)('rejects %s output', async mode => {
    const f = fixture(); await f.runtime.prepare(signal());
    f.setEvents(mode === 'oversize' ? [{ type: 'stdout', text: 'x'.repeat(4097) }] : mode === 'missing' ? [] : mode === 'duplicate'
      ? [{ type: 'execution_complete' }, { type: 'execution_complete' }] : mode === 'error'
      ? [{ type: 'stdout', text: '{}' }, { type: 'error' }, { type: 'execution_complete' }]
      : [{ type: 'execution_complete' }, { type: 'stdout', text: '{}' }]);
    await expect(f.runtime.execute(signal())).rejects.toThrow(/failed or exceeded/);
    await f.runtime.stop();
  });
  it('rejects SHA mismatch before worker execution', async () => {
    const f = fixture(); f.setEvents([{ type: 'stdout', text: JSON.stringify({ ...observation, headSha: 'c'.repeat(40) }) }, { type: 'execution_complete' }]);
    await expect(f.runtime.prepare(signal())).rejects.toThrow(/preparation failed/);
    await expect(f.runtime.execute(signal())).rejects.toThrow(/not prepared/);
    await f.runtime.stop();
  });
  it.each(['bytes', 'count', 'path', 'duplicate'] as const)('preserves runtime on artifact %s failure', async mode => {
    const f = fixture(); await f.runtime.prepare(signal()); await f.runtime.stop();
    f.authority.collectFrozen = async function* () {
      const item = { name: mode === 'path' ? '../escape' : 'one', chunks: (async function* () { yield Buffer.alloc(mode === 'bytes' ? 129 : 1); })() };
      yield item;
      if (mode === 'count') yield { name: 'two', chunks: (async function* () {})() };
      if (mode === 'count' || mode === 'duplicate') yield { name: 'one', chunks: (async function* () {})() };
    };
    await expect(f.runtime.collect(request.limits)).rejects.toThrow();
    await expect(f.runtime.destroy()).rejects.toThrow(/successful collection/);
    expect(f.client.kill).not.toHaveBeenCalled();
  });
  it('rejects plaintext endpoints, mutable images and traversal executables', () => {
    for (const patch of [{ endpoint: 'http://sandbox.invalid' }, { image: 'worker:latest' }, { workerExecutable: '/opt/flyrewheel/../worker' }]) {
      expect(() => createOpenSandboxWorkspaceBackend({ ...config, ...patch })).toThrow();
    }
  });
});

it('carries the exact evaluation binding through the fixed verifier and worker input (authored client only)', async () => {
  const f = fixture();
  const evaluation = { schemaVersion: 1 as const, exportId: 'evaluation-fixture', requestDigest: 'c'.repeat(64), recordDigest: 'd'.repeat(64),
    repositoryId: 'fixture', checkoutSha: sha, allowedHeads: [sha], inventory: { count: 3, expandedBytes: 100, digest: 'e'.repeat(64) } };
  const runtime = f.backend.reserve({ ...request, historyPolicy: 'exact-allowed-head-closure-v1', evaluation },
    { ...workspace, evaluation: { binding: evaluation } } as WorkspaceRecord);
  f.setEvents([{ type: 'stdout', text: JSON.stringify({ ...observation, historyPolicy: 'exact-allowed-head-closure-v1', evaluation }) },
    { type: 'execution_complete' }]);
  expect(await runtime.prepare(signal())).toMatchObject({ historyPolicy: 'exact-allowed-head-closure-v1', evaluation });
  expect(f.client.commands.runStream).toHaveBeenCalledWith([config.workerExecutable, 'verify', sha, workspace.branch,
    'exact-allowed-head-closure-v1', JSON.stringify(evaluation)], expect.anything(), expect.anything());
  await runtime.execute(signal());
  const data = vi.mocked(f.client.files.writeFiles).mock.calls[0][0][0].data;
  expect(JSON.parse(data as string)).toMatchObject({ evaluation, evaluationBranch: workspace.branch, historyPolicy: 'exact-allowed-head-closure-v1' });
  expect(JSON.stringify(data)).not.toContain('storePath');
  await runtime.stop(); await runtime.collect(request.limits); await runtime.destroy();
});

it('rejects an old or mismatched evaluation observation before worker execution', async () => {
  const f = fixture();
  const evaluation = { schemaVersion: 1 as const, exportId: 'evaluation-fixture', requestDigest: 'c'.repeat(64), recordDigest: 'd'.repeat(64),
    repositoryId: 'fixture', checkoutSha: sha, allowedHeads: [sha], inventory: { count: 3, expandedBytes: 100, digest: 'e'.repeat(64) } };
  const runtime = f.backend.reserve({ ...request, historyPolicy: 'exact-allowed-head-closure-v1', evaluation },
    { ...workspace, evaluation: { binding: evaluation } } as WorkspaceRecord);
  await expect(runtime.prepare(signal())).rejects.toThrow('preparation failed');
  await expect(runtime.execute(signal())).rejects.toThrow('not prepared');
  expect(f.calls).not.toContain('run');
  await runtime.stop(); await runtime.collect(request.limits); await runtime.destroy();
  expect(() => f.backend.reserve({ ...request, historyPolicy: 'exact-allowed-head-closure-v1', evaluation }, workspace))
    .toThrow('binding mismatch');
});
