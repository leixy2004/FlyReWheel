import { expect, it, vi } from 'vitest';
import type { Database } from '../src/storage/database.js';
import { ownPendingResource, withCleanup, withOwnedDatabase } from './helpers/fresh-pglite.js';

// Authored lifecycle doubles: no database behavior is simulated or certified.
function database() {
  const close = vi.fn(async () => {});
  return { db: { close } as unknown as Database, close };
}
it('owns separate resources and closes each exactly once after behavior, including explicit close', async () => {
  const first = database(), second = database();
  await Promise.all([first, second].map(({ db }) => withOwnedDatabase(async () => db, async owned => owned, async ({ store }) => {
    await store.close(); await store.close();
  })));
  expect(first.close).toHaveBeenCalledTimes(1); expect(second.close).toHaveBeenCalledTimes(1);
});
it('preserves initialization failure and does not close twice when initialization already closed', async () => {
  const { db, close } = database(), error = new Error('migration failed'), body = vi.fn();
  await expect(withOwnedDatabase(async () => db, async owned => { await owned.close(); throw error; }, body)).rejects.toBe(error);
  expect(body).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
});
it('keeps both the primary failure and a synchronous close failure without retrying close', async () => {
  const { db, close } = database(), primary = new Error('migration failed'), cleanup = new Error('close failed');
  close.mockImplementation(() => { throw cleanup; });
  await expect(withOwnedDatabase(async () => db, async owned => {
    try { await owned.close(); } catch { /* Same error-preservation contract as initialize. */ }
    throw primary;
  }, vi.fn())).rejects.toMatchObject({ errors: [primary, cleanup] });
  expect(close).toHaveBeenCalledTimes(1);
});
it('waits for late setup before cleanup when the runner rejects entry to an expired test', async () => {
  const { db, close } = database(), expired = new Error('runner rejected expired setup');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let initialized = false;
  const pending = withOwnedDatabase(async () => db, async () => { await gate; initialized = true; return db; }, async () => { throw expired; });
  const rejection = expect(pending).rejects.toBe(expired);
  await Promise.resolve(); expect(initialized).toBe(false); expect(close).not.toHaveBeenCalled();
  release(); await rejection; expect(initialized).toBe(true); expect(close).toHaveBeenCalledTimes(1);
});
it('surfaces cleanup failure after otherwise successful behavior', async () => {
  const { db, close } = database(), cleanup = new Error('close failed'); close.mockRejectedValue(cleanup);
  await expect(withOwnedDatabase(async () => db, async () => db, async () => 'done')).rejects.toBe(cleanup);
  expect(close).toHaveBeenCalledTimes(1);
});
it('fences a pending reopen and waits for its single close before directory removal', async () => {
  let finishOpen!: (value: object) => void;
  const ready = new Promise<object>(resolve => { finishOpen = resolve; }), events: string[] = [];
  const close = vi.fn(async () => { events.push('closed'); });
  const owned = ownPendingResource(ready, close);
  const delivery = expect(owned.value()).rejects.toThrow('after test teardown');
  const closing = owned.close();
  expect(owned.close()).toBe(closing);
  const teardown = withCleanup(() => closing, async () => { events.push('directory removed'); });
  await Promise.resolve(); expect(events).toEqual([]);
  finishOpen({}); await delivery; await teardown;
  expect(close).toHaveBeenCalledTimes(1); expect(events).toEqual(['closed', 'directory removed']);
});
