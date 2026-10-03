import { expect, it, vi } from 'vitest';
import type { SandboxCreateOptions, ServerStreamEvent } from '@alibaba-group/opensandbox';
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

it.each(['execute', 'prepare'] as const)('%s rejects completed output when EOF arrives after authoritative cleanup', async phase => {
  const f = fixture(), eof = deferred<void>(), atEof = deferred<void>();
  if (phase === 'execute') await f.runtime.prepare(f.controller.signal);
  vi.mocked(f.client.commands.runStream).mockImplementationOnce(async function* () {
    yield { type: 'stdout', text: JSON.stringify(phase === 'prepare' ? observation : { authored: true }) };
    yield { type: 'execution_complete' };
    atEof.resolve(); await eof.promise;
  });
  const pending = (phase === 'prepare' ? f.runtime.prepare(f.controller.signal) : f.runtime.execute(f.controller.signal))
    .then(value => ({ accepted: true, value }), error => ({ accepted: false, error }));
  await atEof.promise;
  expect(await f.runtime.stop()).toEqual({ stopped: true, verified: true });
  await f.runtime.collect(request.limits);
  expect(await f.runtime.destroy()).toEqual({ destroyed: true, verified: true });
  eof.resolve();
  expect(await pending).toMatchObject({ accepted: false, error: expect.any(Error) });
  expect(f.authority.stopAndVerify).toHaveBeenCalledOnce();
  expect(f.authority.destroyAndVerify).toHaveBeenCalledOnce();
  await expect(f.runtime.execute(new AbortController().signal)).rejects.toThrow(/not prepared|fenced/);
});

it.each(['execute', 'prepare'] as const)('%s rejects a delayed iterator done result on abort without stop', async phase => {
  const f = fixture(), eof = deferred<IteratorResult<ServerStreamEvent>>(), atEof = deferred<void>();
  if (phase === 'execute') await f.runtime.prepare(f.controller.signal);
  let index = 0;
  const iterable: AsyncIterable<ServerStreamEvent> = { [Symbol.asyncIterator]() { return {
    next() {
      if (index++ === 0) return Promise.resolve({ done: false as const, value: { type: 'stdout' as const,
        text: JSON.stringify(phase === 'prepare' ? observation : { authored: true }) } });
      if (index === 2) return Promise.resolve({ done: false as const, value: { type: 'execution_complete' as const } });
      atEof.resolve(); return eof.promise;
    },
  }; } };
  vi.mocked(f.client.commands.runStream).mockReturnValueOnce(iterable);
  const pending = (phase === 'prepare' ? f.runtime.prepare(f.controller.signal) : f.runtime.execute(f.controller.signal))
    .then(value => ({ accepted: true, value }), error => ({ accepted: false, error }));
  await atEof.promise;
  f.controller.abort();
  expect(f.authority.stopAndVerify).not.toHaveBeenCalled();
  eof.resolve({ done: true, value: undefined });
  expect(await pending).toMatchObject({ accepted: false, error: expect.any(Error) });
  await f.runtime.stop(); await f.runtime.collect(request.limits); await f.runtime.destroy();
});

it.each(['execute', 'prepare'] as const)('%s handles late EOF rejection after cleanup without an unhandled rejection', async phase => {
  const f = fixture(), eof = deferred<void>(), atEof = deferred<void>();
  if (phase === 'execute') await f.runtime.prepare(f.controller.signal);
  vi.mocked(f.client.commands.runStream).mockImplementationOnce(async function* () {
    yield { type: 'stdout', text: JSON.stringify(phase === 'prepare' ? observation : { authored: true }) };
    yield { type: 'execution_complete' };
    atEof.resolve(); await eof.promise;
  });
  const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
  try {
    const pending = (phase === 'prepare' ? f.runtime.prepare(f.controller.signal) : f.runtime.execute(f.controller.signal))
      .then(value => ({ accepted: true, value }), error => ({ accepted: false, error }));
    await atEof.promise;
    await f.runtime.stop(); await f.runtime.collect(request.limits); await f.runtime.destroy();
    eof.reject(new Error('AUTHORED_PRIVATE_EOF_FAILURE'));
    const result = await pending;
    expect(result).toMatchObject({ accepted: false, error: expect.any(Error) });
    if ('error' in result) expect(String(result.error)).not.toContain('AUTHORED_PRIVATE_EOF_FAILURE');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
    expect(f.authority.destroyAndVerify).toHaveBeenCalledOnce();
  } finally { process.removeListener('unhandledRejection', unhandled); }
});

it.each(['pending', 'false', 'reject'] as const)('rejects late execution EOF while stop authority is %s and keeps cleanup gated', async mode => {
  const f = fixture(), eof = deferred<void>(), atEof = deferred<void>();
  const stopReceipt = deferred<{ stopped: boolean; verified: boolean }>();
  await f.runtime.prepare(f.controller.signal);
  vi.mocked(f.client.commands.runStream).mockImplementationOnce(async function* () {
    yield { type: 'stdout', text: '{"authored":true}' }; yield { type: 'execution_complete' };
    atEof.resolve(); await eof.promise;
  });
  vi.mocked(f.authority.stopAndVerify).mockImplementation(() => stopReceipt.promise);
  const pending = f.runtime.execute(f.controller.signal).then(value => ({ accepted: true, value }), error => ({ accepted: false, error }));
  await atEof.promise;
  let stopSettled = false;
  const stopping = f.runtime.stop().then(value => { stopSettled = true; return { value }; }, error => { stopSettled = true; return { error }; });
  await vi.waitFor(() => expect(f.authority.stopAndVerify).toHaveBeenCalledOnce());
  if (mode === 'false') stopReceipt.resolve({ stopped: true, verified: false });
  if (mode === 'reject') stopReceipt.reject(new Error('authored stop rejection'));
  eof.resolve();
  expect(await pending).toMatchObject({ accepted: false, error: expect.any(Error) });
  if (mode === 'pending') expect(stopSettled).toBe(false);
  else await stopping;
  await expect(f.runtime.collect(request.limits)).rejects.toThrow(/verified stopped/);
  await expect(f.runtime.destroy()).rejects.toThrow(/stop/);
  expect(f.authority.collectFrozen).not.toHaveBeenCalled();
  expect(f.authority.destroyAndVerify).not.toHaveBeenCalled();
  if (mode === 'pending') {
    stopReceipt.resolve({ stopped: true, verified: true }); await stopping;
    await f.runtime.collect(request.limits); await f.runtime.destroy();
  }
});
