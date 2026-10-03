import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPostgresDatabase, type Database, type Queryable } from '../src/storage/database.js';

const pg = vi.hoisted(() => ({ Pool: vi.fn() }));
vi.mock('pg', () => ({ Pool: pg.Pool }));

const POSTGRES_URL = 'postgresql://authored-user:authored-secret@database.example.test/flyrewheel';
const PRIVATE_DETAIL = 'authored-secret SQL-input-private-detail';
const LOCK_SQL = 'SELECT pg_advisory_xact_lock(727413, 1)';
const SCHEMA_READ = "SELECT to_regclass('public.qe_schema_migrations')::text AS history";
const rawFailure = () => Object.assign(new Error(`${POSTGRES_URL}: ${PRIVATE_DETAIL}`), {
  detail: PRIVATE_DETAIL, query: 'private-sql',
});
const databases: Database[] = [];

beforeEach(() => { pg.Pool.mockReset(); });
afterEach(async () => {
  while (databases.length) await databases.pop()!.close().catch(() => {});
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as Record<string, unknown>[] })),
    release: vi.fn((_error?: Error) => {}),
  });
  const pool = Object.assign(new EventEmitter(), {
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as Record<string, unknown>[] })),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => {}),
  });
  pg.Pool.mockImplementationOnce(function () { return pool; });
  return { pool, client };
}

async function openDatabase() {
  const db = await openPostgresDatabase(POSTGRES_URL);
  databases.push(db);
  return db;
}

function expectSanitized(error: unknown, original: Error) {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBe(original);
  expect(String(error)).toMatch(/PostgreSQL|database/i);
  const failure = error as Error;
  const exposed = [String(failure), failure.stack, JSON.stringify(failure), String(failure.cause)].join('\n');
  for (const secret of [POSTGRES_URL, 'authored-secret', PRIVATE_DETAIL, 'private-sql']) {
    expect(exposed).not.toContain(secret);
  }
}

async function expectSafeFailure(operation: Promise<unknown>, original: Error) {
  const failure: unknown = await operation.then(() => undefined, error => error);
  expectSanitized(failure, original);
}

// This is an explicit simulation of the server's transaction-scoped advisory
// lock, shared by independent mocked Pool/PoolClient pairs. It tests adapter
// ordering and the concurrency contract, not PostgreSQL server lock behavior,
// real migrations, or external-server integration. No credentials or env reads.
function sharedLockFixture() {
  const events: string[] = [];
  let owner: string | undefined;
  const waiters: Array<{ name: string; grant: () => void }> = [];
  const contenderWaiting = deferred();
  function connection(name: string) {
    const f = fixture();
    let inTransaction = false;
    f.client.query.mockImplementation(async sql => {
      events.push(`${name}:${sql}`);
      if (sql === 'BEGIN') {
        expect(inTransaction).toBe(false);
        inTransaction = true;
      } else if (sql === LOCK_SQL) {
        expect(inTransaction).toBe(true);
        if (owner !== undefined) {
          await new Promise<void>(grant => {
            waiters.push({ name, grant });
            contenderWaiting.resolve();
          });
        } else {
          owner = name;
        }
        expect(owner).toBe(name);
        events.push(`${name}:lock-granted`);
      } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        expect(inTransaction).toBe(true);
        inTransaction = false;
        if (owner === name) {
          const next = waiters.shift();
          owner = next?.name;
          next?.grant();
        }
      } else {
        // Schema/history reads are illegal until this connection owns the lock.
        expect(inTransaction).toBe(true);
        expect(owner).toBe(name);
      }
      return { rows: [] };
    });
    return f;
  }
  return { first: connection('first'), second: connection('second'), events, contenderWaiting };
}

describe('PostgreSQL migration transaction adapter contract', () => {
  it('pins BEGIN, advisory lock, schema reads, migration SQL and COMMIT to one acquired client', async () => {
    const f = fixture(), db = await openDatabase(), output = { migrated: true };
    const migrationSql = 'CREATE TABLE authored_migration (id text); INSERT INTO authored_migration VALUES (\'first\');';
    const callback = vi.fn(async (tx: Queryable) => {
      expect(tx).not.toBe(db);
      expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', LOCK_SQL]);
      await tx.query(SCHEMA_READ);
      await tx.query(migrationSql);
      await tx.query('SELECT id FROM authored_migration WHERE id=$1', ['first']);
      return output;
    });
    expect(await db.migrationTransaction(callback)).toBe(output);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.pool.connect).toHaveBeenCalledTimes(1);
    expect(f.pool.query).not.toHaveBeenCalled();
    expect(f.client.query.mock.calls).toEqual([
      ['BEGIN', undefined], [LOCK_SQL, undefined], [SCHEMA_READ, undefined],
      [migrationSql, undefined], ['SELECT id FROM authored_migration WHERE id=$1', ['first']], ['COMMIT', undefined],
    ]);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.client.release.mock.invocationCallOrder[0]).toBeGreaterThan(f.client.query.mock.invocationCallOrder.at(-1)!);
    expect(f.client.listenerCount('error')).toBe(0);
  });

  it.each(['COMMIT', 'ROLLBACK'] as const)('blocks a separate adapter callback until the lock owner ends with %s in the server simulation', async ending => {
    const f = sharedLockFixture(), firstDb = await openDatabase(), secondDb = await openDatabase();
    const firstEntered = deferred(), finishFirst = deferred();
    const rejection = new Error('Authored migration callback rejected');
    const first = firstDb.migrationTransaction(async tx => {
      f.events.push('first:callback');
      await tx.query(SCHEMA_READ);
      firstEntered.resolve();
      await finishFirst.promise;
      if (ending === 'ROLLBACK') throw rejection;
      return 'first committed';
    }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await firstEntered.promise;
    const secondCallback = vi.fn(async (tx: Queryable) => {
      f.events.push('second:callback');
      await tx.query(SCHEMA_READ);
      return 'second committed';
    });
    const second = secondDb.migrationTransaction(secondCallback);
    try {
      // Wait for a real contention signal from the mock, not a timing/sleep guess.
      await f.contenderWaiting.promise;
      expect(secondCallback).not.toHaveBeenCalled();
      expect(f.second.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', LOCK_SQL]);
      expect(f.first.client.release).not.toHaveBeenCalled();
      expect(f.second.client.release).not.toHaveBeenCalled();
    } finally {
      finishFirst.resolve();
      // Settle both transactions even if an assertion fails, avoiding pending work.
      await Promise.allSettled([first, second]);
    }
    expect(await first).toEqual(ending === 'ROLLBACK'
      ? { value: undefined, error: rejection } : { value: 'first committed', error: undefined });
    expect(await second).toBe('second committed');
    expect(secondCallback).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf('first:lock-granted')).toBeLessThan(f.events.indexOf('first:callback'));
    expect(f.events.indexOf(`first:${ending}`)).toBeLessThan(f.events.indexOf('second:lock-granted'));
    expect(f.events.indexOf('second:lock-granted')).toBeLessThan(f.events.indexOf('second:callback'));
    expect(f.events.indexOf('second:callback')).toBeLessThan(f.events.indexOf(`second:${SCHEMA_READ}`));
    expect(pg.Pool).toHaveBeenCalledTimes(2);
    expect(f.first.pool).not.toBe(f.second.pool);
    expect(f.first.client).not.toBe(f.second.client);
    for (const connection of [f.first, f.second]) {
      expect(connection.pool.connect).toHaveBeenCalledTimes(1);
      expect(connection.pool.query).not.toHaveBeenCalled();
      expect(connection.client.release).toHaveBeenCalledTimes(1);
    }
  });

  it('sanitizes acquisition failure without invoking the migration or releasing an unacquired client', async () => {
    const f = fixture(), db = await openDatabase(), original = rawFailure(), callback = vi.fn(async () => {});
    f.pool.connect.mockRejectedValueOnce(original);
    await expectSafeFailure(db.migrationTransaction(callback), original);
    expect(callback).not.toHaveBeenCalled();
    expect(f.client.query).not.toHaveBeenCalled();
    expect(f.client.release).not.toHaveBeenCalled();
  });

  it.each(['BEGIN', LOCK_SQL, SCHEMA_READ, 'COMMIT'])('sanitizes driver failure at %s, rolls back and safely releases', async failingSql => {
    const f = fixture(), db = await openDatabase(), original = rawFailure();
    f.client.query.mockImplementation(async sql => { if (sql === failingSql) throw original; return { rows: [] }; });
    const callback = vi.fn(async (tx: Queryable) => { await tx.query(SCHEMA_READ); });
    await expectSafeFailure(db.migrationTransaction(callback), original);
    expect(callback).toHaveBeenCalledTimes(failingSql === 'BEGIN' || failingSql === LOCK_SQL ? 0 : 1);
    const statements = f.client.query.mock.calls.map(([sql]) => sql);
    expect(statements.at(-1)).toBe('ROLLBACK');
    if (failingSql !== 'COMMIT') expect(statements).not.toContain('COMMIT');
    expect(f.pool.query).not.toHaveBeenCalled();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expectSanitized(f.client.release.mock.calls[0][0], original);
    expect(f.client.listenerCount('error')).toBe(0);
  });

  it.each(['ROLLBACK', 'release'] as const)('preserves a migration callback error even when cleanup fails at %s', async failingCleanup => {
    const f = fixture(), db = await openDatabase(), original = rawFailure();
    const callbackError = new Error('Authored migration rejected');
    if (failingCleanup === 'ROLLBACK') {
      f.client.query.mockImplementation(async sql => { if (sql === 'ROLLBACK') throw original; return { rows: [] }; });
    } else {
      f.client.release.mockImplementationOnce(() => { throw original; });
    }
    await expect(db.migrationTransaction(async () => { throw callbackError; })).rejects.toBe(callbackError);
    expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', LOCK_SQL, 'ROLLBACK']);
    expect(f.client.release).toHaveBeenCalledTimes(1);
    if (failingCleanup === 'ROLLBACK') expectSanitized(f.client.release.mock.calls[0][0], original);
  });

  it('sanitizes a release failure after a successfully committed migration', async () => {
    const f = fixture(), db = await openDatabase(), original = rawFailure();
    f.client.release.mockImplementationOnce(() => { throw original; });
    await expectSafeFailure(db.migrationTransaction(async () => 'migrated'), original);
    expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', LOCK_SQL, 'COMMIT']);
    expect(f.client.release).toHaveBeenCalledTimes(1);
  });

  it('handles a checked-out client error without committing or exposing driver secrets', async () => {
    const f = fixture(), db = await openDatabase(), original = rawFailure();
    await expectSafeFailure(db.migrationTransaction(async tx => {
      await tx.query(SCHEMA_READ);
      expect(() => f.client.emit('error', original)).not.toThrow();
      return 'must not commit';
    }), original);
    expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', LOCK_SQL, SCHEMA_READ]);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expectSanitized(f.client.release.mock.calls[0][0], original);
    expect(f.client.listenerCount('error')).toBe(0);
  });
});
