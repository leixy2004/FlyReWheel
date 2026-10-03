import type { PgBoss } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withSelectedQueue } from '../src/cli-database.js';
import { openQueue } from '../src/jobs.js';
import type { DatabaseSelection } from '../src/storage/connection.js';

vi.mock('../src/jobs.js', () => ({ openQueue: vi.fn() }));
const CONNECTION_STRING = 'postgresql://authored-user:authored-secret@database.example.test/flyrewheel?application_name=authored-private';
const selected: DatabaseSelection = { kind: 'postgres', connectionString: CONNECTION_STRING };
const rawFailure = () => Object.assign(new Error(`Driver failure at ${CONNECTION_STRING}`), { detail: 'authored-private-detail', cause: new Error('authored-private-cause') });
beforeEach(() => { vi.mocked(openQueue).mockReset(); });
function fixture() {
  const stop = vi.fn(async (_options?: unknown) => {});
  const boss = { stop } as unknown as PgBoss;
  vi.mocked(openQueue).mockResolvedValueOnce(boss);
  return { boss, stop };
}
async function expectSafeFailure(operation: Promise<unknown>, original: Error) {
  const failure: unknown = await operation.then(() => undefined, error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBe(original);
  expect(String(failure)).toMatch(/PostgreSQL queue operation failed/);
  expect((failure as Error).cause).toBeUndefined();
  const exposed = [String(failure), (failure as Error).stack, JSON.stringify(failure)].join('\n');
  for (const secret of [CONNECTION_STRING, 'authored-secret', 'authored-private']) expect(exposed).not.toContain(secret);
}

describe('CLI queue execution uses the already selected PostgreSQL destination', () => {
  it.each<DatabaseSelection>([{ kind: 'pglite' }, { kind: 'pglite', path: './authored-local' }])('rejects local selection before opening a queue: %j', async selection => {
    const action = vi.fn(async (_boss: PgBoss) => {});
    await expect(withSelectedQueue(selection, action)).rejects.toThrow(/--postgres/);
    expect(openQueue).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('forwards exactly the selected URL, returns the action result and stops gracefully afterward', async () => {
    const f = fixture(), result = { jobId: 'authored-job' }, action = vi.fn(async (_boss: PgBoss) => result);
    expect(await withSelectedQueue(selected, action)).toBe(result);
    expect(openQueue).toHaveBeenCalledExactlyOnceWith({ connectionString: CONNECTION_STRING });
    expect(action).toHaveBeenCalledExactlyOnceWith(f.boss);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true });
    expect(f.stop.mock.invocationCallOrder[0]).toBeGreaterThan(action.mock.invocationCallOrder[0]);
  });

  it('sanitizes opening failures without executing the action', async () => {
    const original = rawFailure(), action = vi.fn(async (_boss: PgBoss) => {});
    vi.mocked(openQueue).mockRejectedValueOnce(original);
    await expectSafeFailure(withSelectedQueue(selected, action), original);
    expect(action).not.toHaveBeenCalled();
  });

  it('sanitizes action failures and still stops the queue gracefully', async () => {
    const f = fixture(), original = rawFailure();
    await expectSafeFailure(withSelectedQueue(selected, async () => { throw original; }), original);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true });
  });

  it('sanitizes stop failures after a successful action', async () => {
    const f = fixture(), original = rawFailure(), action = vi.fn(async (_boss: PgBoss) => 'authored success');
    f.stop.mockRejectedValueOnce(original);
    await expectSafeFailure(withSelectedQueue(selected, action), original);
    expect(action).toHaveBeenCalledExactlyOnceWith(f.boss);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true });
  });

  it('exposes neither error when both action and cleanup fail', async () => {
    const f = fixture(), original = rawFailure();
    f.stop.mockRejectedValueOnce(rawFailure());
    await expectSafeFailure(withSelectedQueue(selected, async () => { throw original; }), original);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
});
