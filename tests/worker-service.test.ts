import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applicationJobDigest, ApplicationJobSchema, type ApplicationJob, type ApplicationJobInput, type ApplicationJobResult } from '../src/application-job-contract.js';
import { createApplicationJobDispatcher } from '../src/application-dispatcher.js';
import { APPLICATION_QUEUE, REPLAY_QUEUE } from '../src/jobs.js';
import type { QualEvoStore } from '../src/storage/store.js';
import { startWorkerService } from '../src/worker-service.js';

// Preserve Node's other HTTP exports for transitive imports. These tests never
// bind a socket, connect a database, allocate a workspace, or execute a model.
vi.mock('node:http', async importOriginal => ({
  ...await importOriginal<typeof import('node:http')>(), createServer: vi.fn(),
}));
vi.mock('../src/application-dispatcher.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/application-dispatcher.js')>();
  return { ...actual, createApplicationJobDispatcher: vi.fn(actual.createApplicationJobDispatcher) };
});

type QueueCallback = (jobs: Array<{ data: unknown; signal: AbortSignal }>) => Promise<unknown>;
class AuthoredHealthServer extends EventEmitter {
  listen = vi.fn((_port: number, _host: string, callback: () => void) => { callback(); return this; });
  close = vi.fn((callback?: () => void) => { callback?.(); return this; });
}
const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'semantic-review', workspaceId: 'authored-workspace',
  ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) });
const blocked: ApplicationJobResult = { status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason: 'runtime_unavailable' };
const cleanups: Array<() => Promise<unknown>> = [];

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
  vi.clearAllTimers(); vi.useRealTimers();
});

function fixture() {
  const handlers = new Map<string, QueueCallback>();
  const boss = Object.assign(new EventEmitter(), {
    work: vi.fn(async (name: string, _options: unknown, callback: QueueCallback) => {
      handlers.set(name, callback); return `authored-${name}`;
    }),
    getQueue: vi.fn(async (name: string) => ({ name })),
    stop: vi.fn(async (_options?: unknown) => {}),
  });
  const store = {
    close: vi.fn(async () => {}),
    reconcileExpiredApplicationJobs: vi.fn(async () => 0),
    claimApplicationJob: vi.fn(async (_job: ApplicationJob, owner: string) => ({ state: 'claimed' as const, owner })),
    completeApplicationJob: vi.fn(async (input: ApplicationJob, _owner: string, result: ApplicationJobResult) => ({
      jobDigest: applicationJobDigest(input), job: input, state: 'finished' as const, result, attempts: 1,
    })),
  };
  const health = new AuthoredHealthServer(), report = vi.fn();
  vi.mocked(createServer).mockReturnValue(health as unknown as ReturnType<typeof createServer>);
  const options = { boss: boss as unknown as PgBoss, store: store as unknown as QualEvoStore,
    environment: {}, port: 12345, host: '127.0.0.1', onResult: report };
  const status = (url = '/readyz') => {
    const listener = vi.mocked(createServer).mock.calls[0][0] as unknown as RequestListener;
    const response = { writeHead: vi.fn(), end: vi.fn() };
    listener({ url } as IncomingMessage, response as unknown as ServerResponse);
    return { code: response.writeHead.mock.calls[0][0], body: JSON.parse(response.end.mock.calls[0][0] as string) };
  };
  const start = async () => { const service = await startWorkerService(options); cleanups.push(() => service.stop()); return service; };
  return { boss, store, health, handlers, report, options, status, start };
}

describe('worker service lifecycle with in-memory services only', () => {
  it('registers both queues, exposes explicitly blocked runtime, and handles application jobs without runtime work', async () => {
    const f = fixture(), service = await f.start();
    expect(f.boss.work.mock.calls.map(([name]) => name)).toEqual([REPLAY_QUEUE, APPLICATION_QUEUE]);
    for (const [, options] of f.boss.work.mock.calls) expect(options).toMatchObject({ batchSize: 1, localConcurrency: 1, groupConcurrency: 1 });
    expect(service.applicationRuntime).toBe('blocked');
    expect(f.status()).toEqual({ code: 200, body: { status: 'ok', applicationRuntime: 'blocked' } });
    expect(f.health.listen).toHaveBeenCalledWith(12345, '127.0.0.1', expect.any(Function));
    expect(f.store.reconcileExpiredApplicationJobs).toHaveBeenCalledTimes(1);
    expect(await f.handlers.get(APPLICATION_QUEUE)!([{ data: job, signal: new AbortController().signal }])).toEqual(blocked);
    expect(f.report).toHaveBeenCalledWith({ kind: 'semantic-review', ...blocked });
    expect(f.store.completeApplicationJob).toHaveBeenCalledWith(job, expect.any(String), blocked, undefined, undefined, undefined);
    await service.stop();
    expect(f.status().code).toBe(503);
    expect(f.boss.stop).toHaveBeenCalledTimes(1); expect(f.store.close).toHaveBeenCalledTimes(1);
    expect(f.health.close).toHaveBeenCalledTimes(1); expect(f.boss.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts the in-flight application callback before closing services and makes repeated stop idempotent', async () => {
    const f = fixture();
    let observed: AbortSignal | undefined, release: (() => void) | undefined;
    const dispatch = vi.fn(async (_job: ApplicationJobInput, signal: AbortSignal) => {
      observed = signal;
      await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
      return blocked;
    });
    vi.mocked(createApplicationJobDispatcher).mockReturnValueOnce(dispatch);
    const service = await f.start();
    const callback = f.handlers.get(APPLICATION_QUEUE)!([{ data: job, signal: new AbortController().signal }]);
    expect(observed?.aborted).toBe(false);
    f.boss.stop.mockImplementationOnce(async () => {
      expect(observed?.aborted).toBe(true);
      expect(f.store.close).not.toHaveBeenCalled();
      await callback;
    });
    const first = service.stop(), second = service.stop();
    expect(second).toBe(first); await first; release?.();
    expect(observed?.aborted).toBe(true);
    expect(f.boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 150_000 });
    expect(f.boss.stop).toHaveBeenCalledTimes(1); expect(f.store.close).toHaveBeenCalledTimes(1);
    expect(f.health.close).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('still closes the store and HTTP server when startup fails and boss.stop also rejects', async () => {
    const f = fixture(), startupError = new Error('Authored listen failure');
    f.health.listen.mockImplementation(() => { f.health.emit('error', startupError); return f.health; });
    f.boss.stop.mockRejectedValueOnce(new Error('Authored queue stop failure'));
    await expect(startWorkerService(f.options)).rejects.toBe(startupError);
    expect(f.boss.stop).toHaveBeenCalledTimes(1); expect(f.store.close).toHaveBeenCalledTimes(1);
    expect(f.health.close).toHaveBeenCalledTimes(1); expect(f.boss.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still closes HTTP and removes listeners when store.close rejects during normal shutdown', async () => {
    const f = fixture(), service = await f.start(), closeError = new Error('Authored store close failure');
    f.store.close.mockRejectedValueOnce(closeError);
    await expect(service.stop()).rejects.toBe(closeError);
    expect(f.status().code).toBe(503);
    expect(f.boss.stop).toHaveBeenCalledTimes(1); expect(f.store.close).toHaveBeenCalledTimes(1);
    expect(f.health.close).toHaveBeenCalledTimes(1); expect(f.boss.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers readiness after a transient database error only after the periodic health probe succeeds', async () => {
    const f = fixture(), service = await f.start();
    f.boss.emit('error', new Error('Authored transient database failure'));
    expect(f.status().code).toBe(503);
    f.boss.getQueue.mockRejectedValue(new Error('Authored database still unavailable'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.status().code).toBe(503);
    f.boss.getQueue.mockImplementation(async name => ({ name }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.boss.getQueue).toHaveBeenCalledWith(APPLICATION_QUEUE);
    expect(f.status()).toEqual({ code: 200, body: { status: 'ok', applicationRuntime: 'blocked' } });
    expect(f.store.reconcileExpiredApplicationJobs.mock.calls.length).toBeGreaterThan(1);
    await service.stop();
    const calls = f.boss.getQueue.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.boss.getQueue).toHaveBeenCalledTimes(calls);
  });
});
