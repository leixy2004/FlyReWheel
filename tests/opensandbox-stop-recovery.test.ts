import { expect, it, vi } from 'vitest';
import type { SandboxCreateOptions } from '@alibaba-group/opensandbox';
import { createOpenSandboxWorkspaceBackend, type OpenSandboxWorkspaceConfig, type OpenSandboxClient,
  type OpenSandboxLifecycleAuthority } from '../src/adapters/opensandbox-workspace.js';
import type { CodexWorkspaceRequest } from '../src/workspace/codex-runner.js';
import type { WorkspaceRecord } from '../src/workspace/index.js';

// Authored SDK-shaped deferred operations only: these test orchestration, not runtime isolation.
const sha = 'a'.repeat(40);
const config: OpenSandboxWorkspaceConfig = { endpoint: 'https://sandbox.example.invalid', apiKey: 'AUTHORED',
  image: `example.invalid/worker@sha256:${'b'.repeat(64)}`, cpu: '1', memory: '2Gi', maxBundleBytes: 1024,
  workerExecutable: '/opt/flyrewheel/worker', gatewayHost: 'gateway.example.invalid' };
const request: CodexWorkspaceRequest = { workspace: { repoPath: '/authored', runId: 'run', attemptId: 'one' }, expectedSha: sha,
  model: 'authored-model', prompt: 'Authored', toolPolicy: 'full-repo-shell-v1', historyPolicy: 'all-local-refs-v1',
  limits: { maxInputBytes: 8192, maxOutputBytes: 4096, maxArtifactBytes: 128, maxArtifacts: 2, timeoutMs: 1000, cleanupTimeoutMs: 500 } };
const workspace = { ...request.workspace, branch: 'attempt/run--one', baseSha: sha, worktreePath: '/authored/worktree' } as WorkspaceRecord;
const observation = { expectedSha: sha, headSha: sha, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const authority: OpenSandboxLifecycleAuthority = {
    preflight: vi.fn(async () => {}),
    stopAndVerify: vi.fn(async () => ({ stopped: true, verified: true })),
    collectFrozen: vi.fn(async function* () {}),
    destroyAndVerify: vi.fn(async () => ({ destroyed: true, verified: true })),
  };
  const client = {
    id: 'authored-sandbox', commands: { runStream: vi.fn(async function* () {
      yield { type: 'stdout', text: JSON.stringify(observation) }; yield { type: 'execution_complete' };
    }) },
    files: { createDirectories: vi.fn(async () => {}), writeFiles: vi.fn(async () => {}) },
    kill: vi.fn(async () => {}), close: vi.fn(async () => {}),
  } as unknown as OpenSandboxClient;
  const create = vi.fn(async (_options: SandboxCreateOptions) => client);
  const transfer = vi.fn(async () => {});
  const runtime = createOpenSandboxWorkspaceBackend(config, { authority, createSandbox: create, transfer }).reserve(request, workspace);
  return { authority, client, create, transfer, runtime, controller: new AbortController() };
}
async function cannotCollectOrDestroy(f: ReturnType<typeof fixture>) {
  await expect(f.runtime.collect(request.limits)).rejects.toThrow(/verified stopped/);
  await expect(f.runtime.destroy()).rejects.toThrow(/stop/);
  expect(f.authority.collectFrozen).not.toHaveBeenCalled();
  expect(f.authority.destroyAndVerify).not.toHaveBeenCalled();
}

it('starts authoritative token reconciliation while create remains unresolved, and fences its late completion', async () => {
  const f = fixture(), gate = deferred<OpenSandboxClient>();
  f.create.mockImplementation(() => gate.promise);
  const preparation = f.runtime.prepare(f.controller.signal).catch(error => error);
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
  f.controller.abort();
  const stopping = f.runtime.stop();
  await vi.waitFor(() => expect(f.authority.stopAndVerify).toHaveBeenCalledOnce());
  const token = vi.mocked(f.authority.stopAndVerify).mock.calls[0][0];
  expect(token).toEqual({ allocationId: expect.any(String) });
  expect(Object.isFrozen(token)).toBe(true);
  expect(await stopping).toEqual({ stopped: true, verified: true });
  await f.runtime.collect(request.limits); await f.runtime.destroy();
  gate.resolve(f.client);
  expect(await preparation).toBeInstanceOf(Error);
  expect(f.transfer).not.toHaveBeenCalled();
  expect(f.client.close).toHaveBeenCalledOnce();
  expect(f.client.commands.runStream).not.toHaveBeenCalled();
  // The receipt promises token-wide fencing, including creates whose ID was initially unknown.
  expect(token).not.toHaveProperty('sandboxId');
});

it('stops during unresolved preflight without allocation, and prevents a late successful preflight from creating', async () => {
  const f = fixture(), gate = deferred<void>();
  vi.mocked(f.authority.preflight).mockImplementation(() => gate.promise);
  const preparation = f.runtime.prepare(f.controller.signal).catch(error => error);
  await vi.waitFor(() => expect(f.authority.preflight).toHaveBeenCalledOnce());
  f.controller.abort();
  expect(await f.runtime.stop()).toEqual({ stopped: true, verified: true });
  expect(f.authority.stopAndVerify).not.toHaveBeenCalled();
  expect(await f.runtime.collect(request.limits)).toEqual([]);
  expect(await f.runtime.destroy()).toEqual({ destroyed: true, verified: true });
  gate.resolve();
  expect(await preparation).toBeInstanceOf(Error);
  expect(f.create).not.toHaveBeenCalled();
});

it('does not wait for an abort-ignoring transfer before authority stop and cannot verify or execute afterward', async () => {
  const f = fixture(), gate = deferred<void>();
  f.transfer.mockImplementation(() => gate.promise);
  const preparation = f.runtime.prepare(f.controller.signal).catch(error => error);
  await vi.waitFor(() => expect(f.transfer).toHaveBeenCalledOnce());
  f.controller.abort();
  const stopping = f.runtime.stop();
  await vi.waitFor(() => expect(f.authority.stopAndVerify).toHaveBeenCalledOnce());
  expect(await stopping).toEqual({ stopped: true, verified: true });
  gate.resolve(); expect(await preparation).toBeInstanceOf(Error);
  expect(f.client.commands.runStream).not.toHaveBeenCalled();
  await expect(f.runtime.execute(new AbortController().signal)).rejects.toThrow(/not prepared|fenced/);
});

it('does not wait for an abort-ignoring execution stream or accept its late output', async () => {
  const f = fixture(), gate = deferred<void>();
  await f.runtime.prepare(f.controller.signal);
  vi.mocked(f.client.commands.runStream).mockImplementationOnce(async function* () {
    await gate.promise;
    yield { type: 'stdout', text: '{"authored":true}' }; yield { type: 'execution_complete' };
  });
  const execution = f.runtime.execute(f.controller.signal).catch(error => error);
  await vi.waitFor(() => expect(f.client.commands.runStream).toHaveBeenCalledTimes(2));
  f.controller.abort();
  const stopping = f.runtime.stop();
  await vi.waitFor(() => expect(f.authority.stopAndVerify).toHaveBeenCalledOnce());
  expect(await stopping).toEqual({ stopped: true, verified: true });
  gate.resolve(); expect(await execution).toBeInstanceOf(Error);
});

it.each([{ stopped: false, verified: false }, { stopped: true, verified: false }, { stopped: false, verified: true }])(
  'keeps collection and destruction closed for ambiguous stop receipt %j', async receipt => {
    const f = fixture(); await f.runtime.prepare(f.controller.signal);
    vi.mocked(f.authority.stopAndVerify).mockResolvedValue(receipt);
    expect(await f.runtime.stop()).toEqual({ stopped: false, verified: false });
    await cannotCollectOrDestroy(f);
    expect(await f.runtime.stop()).toEqual({ stopped: false, verified: false });
    expect(f.authority.stopAndVerify).toHaveBeenCalledOnce();
  });

it('shares concurrent stop work and blocks collection until the authoritative receipt resolves', async () => {
  const f = fixture(), gate = deferred<{ stopped: boolean; verified: boolean }>();
  await f.runtime.prepare(f.controller.signal);
  vi.mocked(f.authority.stopAndVerify).mockImplementation(() => gate.promise);
  const first = f.runtime.stop(), second = f.runtime.stop();
  expect(first).toBe(second);
  await vi.waitFor(() => expect(f.authority.stopAndVerify).toHaveBeenCalledOnce());
  await cannotCollectOrDestroy(f);
  gate.resolve({ stopped: true, verified: true });
  expect(await first).toEqual({ stopped: true, verified: true });
  expect(await second).toEqual({ stopped: true, verified: true });
  await f.runtime.collect(request.limits);
  expect(await f.runtime.destroy()).toEqual({ destroyed: true, verified: true });
});

it('retains rejection and cannot convert a failed authority call into successful cleanup on retry', async () => {
  const f = fixture(); await f.runtime.prepare(f.controller.signal);
  vi.mocked(f.authority.stopAndVerify).mockRejectedValue(new Error('authored authority unavailable'));
  await expect(f.runtime.stop()).rejects.toThrow('authored authority unavailable');
  await cannotCollectOrDestroy(f);
  await expect(f.runtime.stop()).rejects.toThrow('authored authority unavailable');
  expect(f.authority.stopAndVerify).toHaveBeenCalledOnce();
});

it('reaches authoritative destruction despite never-settling SDK kill and close implementations', async () => {
  const f = fixture();
  vi.mocked(f.client.kill).mockImplementation(() => new Promise<void>(() => {}));
  vi.mocked(f.client.close).mockImplementation(() => new Promise<void>(() => {}));
  await f.runtime.prepare(f.controller.signal); await f.runtime.stop(); await f.runtime.collect(request.limits);
  expect(await f.runtime.destroy()).toEqual({ destroyed: true, verified: true });
  expect(f.authority.destroyAndVerify).toHaveBeenCalledOnce();
  expect(f.client.kill).not.toHaveBeenCalled();
  expect(f.client.close).toHaveBeenCalledOnce();
  expect(await f.runtime.destroy()).toEqual({ destroyed: true, verified: true });
  expect(f.authority.destroyAndVerify).toHaveBeenCalledOnce();
});

it.each(['reject', 'throw'] as const)('does not downgrade destruction proof for local close %s', async mode => {
  const f = fixture();
  vi.mocked(f.client.close).mockImplementation(() => {
    if (mode === 'throw') throw new Error('authored local close failure');
    return Promise.reject(new Error('authored local close rejection'));
  });
  await f.runtime.prepare(f.controller.signal); await f.runtime.stop(); await f.runtime.collect(request.limits);
  expect(await f.runtime.destroy()).toEqual({ destroyed: true, verified: true });
  expect(f.authority.destroyAndVerify).toHaveBeenCalledOnce();
});

it.each([{ destroyed: true, verified: false }, { destroyed: false, verified: true }])(
  'never treats an ambiguous authority destroy receipt as successful cleanup %j', async receipt => {
    const f = fixture(); await f.runtime.prepare(f.controller.signal); await f.runtime.stop(); await f.runtime.collect(request.limits);
    vi.mocked(f.authority.destroyAndVerify).mockResolvedValue(receipt);
    expect(await f.runtime.destroy()).toEqual({ destroyed: false, verified: false });
    expect(f.client.close).not.toHaveBeenCalled();
    expect(f.client.kill).not.toHaveBeenCalled();
    expect(await f.runtime.destroy()).toEqual({ destroyed: false, verified: false });
    expect(f.authority.destroyAndVerify).toHaveBeenCalledOnce();
  });

it('publishes the stop promise before synchronous abort listeners can reenter stop', async () => {
  const f = fixture(); await f.runtime.prepare(f.controller.signal);
  const internalSignal = f.create.mock.calls[0][0].signal!;
  let reentrant: ReturnType<typeof f.runtime.stop> | undefined;
  internalSignal.addEventListener('abort', () => { reentrant = f.runtime.stop(); }, { once: true });
  const first = f.runtime.stop();
  expect(reentrant).toBe(first);
  expect(await first).toEqual({ stopped: true, verified: true });
  expect(f.authority.stopAndVerify).toHaveBeenCalledOnce();
});

it('publishes the destroy promise before a synchronous authority callback can reenter destroy', async () => {
  const f = fixture(); await f.runtime.prepare(f.controller.signal); await f.runtime.stop(); await f.runtime.collect(request.limits);
  let reentrant: ReturnType<typeof f.runtime.destroy> | undefined, entered = false;
  vi.mocked(f.authority.destroyAndVerify).mockImplementation(async () => {
    if (!entered) { entered = true; reentrant = f.runtime.destroy(); }
    return { destroyed: true, verified: true };
  });
  const first = f.runtime.destroy();
  await first;
  expect(reentrant).toBe(first);
  expect(f.authority.destroyAndVerify).toHaveBeenCalledOnce();
});
