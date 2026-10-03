import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_QUEUE, openQueue, QUEUE_POLICY, REPLAY_QUEUE } from '../src/jobs.js';

const queue = vi.hoisted(() => ({ PgBoss: vi.fn() }));
vi.mock('pg-boss', () => ({ PgBoss: queue.PgBoss }));
const CONNECTION_STRING = 'postgresql://authored-user:authored-secret@database.example.test/flyrewheel';
const rawFailure = () => Object.assign(new Error(`Queue driver failure at ${CONNECTION_STRING}`), {
  detail: 'authored-private-query', cause: new Error('authored-private-cause'),
});
beforeEach(() => { queue.PgBoss.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });
function fixture() {
  const boss = Object.assign(new EventEmitter(), {
    start: vi.fn(async () => {}),
    createQueue: vi.fn(async (_name: string, _options: unknown) => {}),
    updateQueue: vi.fn(async (_name: string, _options: unknown) => {}),
    stop: vi.fn(async (_options?: unknown) => {}),
  });
  queue.PgBoss.mockImplementation(function () { return boss; });
  return boss;
}
async function expectSafeInitializationFailure(operation: Promise<unknown>, original: Error) {
  const failure: unknown = await operation.then(() => undefined, error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBe(original);
  expect(String(failure)).toMatch(/PostgreSQL queue initialization failed/);
  expect((failure as Error).cause).toBeUndefined();
  const exposed = [String(failure), (failure as Error).stack, JSON.stringify(failure)].join('\n');
  for (const secret of [CONNECTION_STRING, 'authored-secret', 'authored-private']) expect(exposed).not.toContain(secret);
}

// A public-constructor double only: no pg-boss scheduler, sockets or database.
describe('queue initialization cleanup and secret-safe diagnostics', () => {
  it('passes explicit options, initializes both queues with the existing policies and returns the live queue', async () => {
    const boss = fixture(), options = { connectionString: CONNECTION_STRING, schedule: false };
    expect(await openQueue(options)).toBe(boss);
    expect(queue.PgBoss).toHaveBeenCalledExactlyOnceWith(options);
    expect(boss.start).toHaveBeenCalledTimes(1);
    expect(boss.createQueue.mock.calls).toEqual([[REPLAY_QUEUE, QUEUE_POLICY], [APPLICATION_QUEUE, QUEUE_POLICY]]);
    const { policy: _policy, ...mutablePolicy } = QUEUE_POLICY;
    expect(boss.updateQueue.mock.calls).toEqual([[REPLAY_QUEUE, mutablePolicy], [APPLICATION_QUEUE, mutablePolicy]]);
    expect(boss.start.mock.invocationCallOrder[0]).toBeLessThan(boss.createQueue.mock.invocationCallOrder[0]);
    expect(boss.updateQueue.mock.invocationCallOrder[0]).toBeLessThan(boss.createQueue.mock.invocationCallOrder[1]);
    expect(boss.stop).not.toHaveBeenCalled();
  });

  it('sanitizes constructor failure before a queue instance exists', async () => {
    const original = rawFailure();
    queue.PgBoss.mockImplementation(function () { throw original; });
    await expectSafeInitializationFailure(openQueue({ connectionString: CONNECTION_STRING }), original);
    expect(queue.PgBoss).toHaveBeenCalledTimes(1);
  });

  it.each([
    { method: 'start' as const, occurrence: 1 },
    { method: 'createQueue' as const, occurrence: 1 },
    { method: 'createQueue' as const, occurrence: 2 },
    { method: 'updateQueue' as const, occurrence: 1 },
    { method: 'updateQueue' as const, occurrence: 2 },
  ])('stops gracefully and redacts a $method failure at call $occurrence', async ({ method, occurrence }) => {
    const boss = fixture(), original = rawFailure();
    if (occurrence === 2) boss[method].mockResolvedValueOnce(undefined);
    boss[method].mockRejectedValueOnce(original);
    await expectSafeInitializationFailure(openQueue({ connectionString: CONNECTION_STRING }), original);
    expect(boss[method]).toHaveBeenCalledTimes(occurrence);
    expect(boss.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true });
  });

  it('preserves the safe initialization diagnostic even if cleanup also fails', async () => {
    const boss = fixture(), original = rawFailure();
    boss.createQueue.mockRejectedValueOnce(original);
    boss.stop.mockRejectedValueOnce(rawFailure());
    await expectSafeInitializationFailure(openQueue({ connectionString: CONNECTION_STRING }), original);
    expect(boss.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true });
  });

  it('installs a safe error listener before startup and never prints emitted driver details', async () => {
    const boss = fixture(), stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    boss.start.mockImplementationOnce(async () => { boss.emit('error', rawFailure()); });
    await openQueue({ connectionString: CONNECTION_STRING });
    expect(boss.listenerCount('error')).toBeGreaterThan(0);
    expect(() => boss.emit('error', rawFailure())).not.toThrow();
    expect(stderr).toHaveBeenCalledTimes(2);
    const output = stderr.mock.calls.map(([data]) => String(data)).join('\n');
    expect(output).toMatch(/queue database error/);
    for (const secret of [CONNECTION_STRING, 'authored-secret', 'authored-private']) expect(output).not.toContain(secret);
  });
});
