import { aroundEach, type TestContext } from 'vitest';
import { openPGliteDatabase, type Database } from '../../src/storage/database.js';
import { QualEvoStore } from '../../src/storage/store.js';

// The measured cold open took 8321ms, before migration or behavior. Keep the
// existing 10s hook budget separate from the unchanged 5s behavioral budget.
export const DATABASE_SETUP_TIMEOUT = 10_000;
export interface FreshPGlite { db: Database; store: QualEvoStore }

/** Register before awaiting a reopen. Teardown fences late delivery, waits for
 * the same operation and closes its result before directory cleanup can run. */
export function ownPendingResource<T>(ready: Promise<T>, close: (value: T) => Promise<void>) {
  let disposed = false, closing: Promise<void> | undefined;
  return {
    async value(): Promise<T> {
      const value = await ready;
      if (disposed) throw new Error('Resource completed after test teardown started');
      return value;
    },
    close(): Promise<void> {
      disposed = true;
      return closing ??= ready.then(value => close(value));
    },
  };
}

/** One owner even when initialize closes on failure, or a timed-out setup
 * eventually reaches Vitest's rejected runTest callback. Never close mid-setup. */
export async function withOwnedDatabase<T, R>(
  open: () => Promise<Database>, initialize: (db: Database) => Promise<T>,
  run: (resource: { db: Database; store: T }) => Promise<R>,
): Promise<R> {
  const raw = await open();
  let closing: Promise<void> | undefined;
  const db = { ...raw, close: () => closing ??= Promise.resolve().then(() => raw.close()) };
  return withCleanup(async () => {
    const store = await initialize(db);
    return run({ db, store });
  }, () => db.close());
}

export async function withCleanup<R>(run: () => Promise<R>, cleanup: () => Promise<void>): Promise<R> {
  let failed = false, primary: unknown;
  try { return await run(); }
  catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { await cleanup(); }
    catch (error) {
      if (failed && error !== primary) throw new AggregateError([primary, error], 'Database setup/behavior and cleanup both failed');
      throw error;
    }
  }
}

export function withFreshPGlite<R>(run: (resource: FreshPGlite) => Promise<R>, path?: string): Promise<R> {
  return withOwnedDatabase(() => openPGliteDatabase(path), db => QualEvoStore.initialize(db), run);
}

/** Register only inside the affected suite. Each task gets its own database.
 * aroundEach bounds setup and teardown separately; runTest keeps its own budget.
 * A setup timeout is not cancellation: late completion still reaches finally. */
export function useFreshPGlite(): (context: TestContext) => FreshPGlite {
  const resources = new WeakMap<TestContext['task'], FreshPGlite>();
  aroundEach(async (runTest, context) => {
    await withFreshPGlite(async resource => {
      resources.set(context.task, resource);
      try { await runTest(); }
      finally { resources.delete(context.task); }
    });
  }, DATABASE_SETUP_TIMEOUT);
  return context => {
    const resource = resources.get(context.task);
    if (!resource) throw new Error('Fresh PGlite setup did not complete for this test');
    return resource;
  };
}
