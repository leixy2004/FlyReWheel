import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationJobSchema, applicationJobDigest, applicationJobId, type ApplicationJobResult } from '../src/application-job-contract.js';
import type { ProblemCase, SemanticRuleVersion } from '../src/core/index.js';
import { openPGliteDatabase, openPostgresDatabase, type Database } from '../src/storage/database.js';
import { DomainError, QualEvoStore } from '../src/storage/store.js';

const pg = vi.hoisted(() => ({ Pool: vi.fn() }));
vi.mock('pg', () => ({ Pool: pg.Pool }));

const POSTGRES_URL = 'postgresql://authored-user:authored-secret@database.example.test/flyrewheel';
const PRIVATE_DETAIL = 'authored-secret SQL-input-private-detail';
const rawFailure = () => Object.assign(new Error(`${POSTGRES_URL}: ${PRIVATE_DETAIL}`), { detail: PRIVATE_DETAIL, query: 'private-sql' });
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => { pg.Pool.mockReset(); });
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
  vi.restoreAllMocks();
});

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as Record<string, unknown>[] })),
    release: vi.fn(),
  });
  const pool = Object.assign(new EventEmitter(), {
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as Record<string, unknown>[] })),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => {}),
  });
  pg.Pool.mockImplementation(function () { return pool; });
  return { pool, client };
}
async function expectSafeFailure(operation: Promise<unknown>, original: Error): Promise<void> {
  const failure: unknown = await operation.then(() => undefined, error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBe(original);
  expect(String(failure)).toMatch(/PostgreSQL|database/i);
  const error = failure as Error;
  const exposed = [String(error), error.stack, JSON.stringify(error), String(error.cause)].join('\n');
  expect(exposed).not.toContain(POSTGRES_URL);
  expect(exposed).not.toContain('authored-secret');
  expect(exposed).not.toContain(PRIVATE_DETAIL);
  expect(exposed).not.toContain('private-sql');
}

// This suite mocks pg's public Pool/PoolClient boundary. It does not connect to
// PostgreSQL, inspect process.env, or claim external-server integration coverage.
describe('PostgreSQL database adapter through the pg Pool contract', () => {
  it('requires an explicit connection string before constructing a pool', async () => {
    await expect(openPostgresDatabase('')).rejects.toThrow(/explicit|connection|PostgreSQL/i);
    expect(pg.Pool).not.toHaveBeenCalled();
  });

  it('sanitizes synchronous pool construction errors', async () => {
    const original = rawFailure();
    pg.Pool.mockImplementation(function () { throw original; });
    await expectSafeFailure(openPostgresDatabase(POSTGRES_URL), original);
  });

  it('uses the supplied URL, forwards parameterized queries, and closes its pool', async () => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL);
    expect(pg.Pool).toHaveBeenCalledExactlyOnceWith({ connectionString: POSTGRES_URL, max: 5 });
    const rows = [{ id: 'authored-record', payload: { valid: true } }], params = ['authored-record'];
    f.pool.query.mockResolvedValueOnce({ rows });
    expect(await db.query('SELECT id, payload FROM records WHERE id=$1', params)).toEqual({ rows });
    expect(f.pool.query).toHaveBeenCalledWith('SELECT id, payload FROM records WHERE id=$1', params);
    await db.exec('CREATE TABLE authored_table (id text)');
    expect(f.pool.query).toHaveBeenCalledWith('CREATE TABLE authored_table (id text)');
    await db.close();
    expect(f.pool.end).toHaveBeenCalledTimes(1);
  });

  it('runs BEGIN, callback queries and COMMIT on one acquired client and then releases it', async () => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL), output = { committed: true };
    const result = await db.transaction(async tx => {
      expect(tx).not.toBe(db);
      await tx.query('INSERT INTO authored_table (id) VALUES ($1)', ['authored-id']);
      return output;
    });
    expect(result).toBe(output);
    expect(f.pool.connect).toHaveBeenCalledTimes(1);
    expect(f.pool.query).not.toHaveBeenCalled();
    expect(f.client.query.mock.calls.map(([sql, params]) => [sql, params])).toEqual([
      ['BEGIN', undefined], ['INSERT INTO authored_table (id) VALUES ($1)', ['authored-id']], ['COMMIT', undefined],
    ]);
    expect(f.client.release).toHaveBeenCalledTimes(1);
    expect(f.client.release.mock.invocationCallOrder[0]).toBeGreaterThan(f.client.query.mock.invocationCallOrder.at(-1)!);
    await db.close();
  });

  it('preserves domain callback errors, rolls back, and always releases the client', async () => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL);
    const domainError = new DomainError('IMMUTABLE_CONFLICT', 'Authored immutable conflict');
    await expect(db.transaction(async tx => {
      await tx.query('SELECT id FROM authored_table WHERE id=$1', ['authored-id']);
      throw domainError;
    })).rejects.toBe(domainError);
    expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT id FROM authored_table WHERE id=$1', 'ROLLBACK']);
    expect(f.client.release).toHaveBeenCalledTimes(1);
    await db.close();
  });

  it('does not replace a domain callback error or skip release when rollback fails', async () => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL), domainError = new DomainError('SOURCE_MISMATCH', 'Authored source mismatch');
    f.client.query.mockImplementation(async sql => { if (sql === 'ROLLBACK') throw rawFailure(); return { rows: [] }; });
    await expect(db.transaction(async () => { throw domainError; })).rejects.toBe(domainError);
    expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(f.client.release).toHaveBeenCalledTimes(1);
    await db.close();
  });

  it('preserves a domain error if releasing the client also fails', async () => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL), domainError = new DomainError('SOURCE_MISMATCH', 'Authored source mismatch');
    f.client.release.mockImplementationOnce(() => { throw rawFailure(); });
    await expect(db.transaction(async () => { throw domainError; })).rejects.toBe(domainError);
    expect(f.client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(f.client.release).toHaveBeenCalledTimes(1);
    await db.close();
  });

  it('sanitizes a release failure after an otherwise successful transaction', async () => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL), original = rawFailure();
    f.client.release.mockImplementationOnce(() => { throw original; });
    await expectSafeFailure(db.transaction(async () => 'authored success'), original);
    await db.close();
  });

  it.each(['query', 'exec', 'close'] as const)('sanitizes raw driver failures from %s', async operation => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL), original = rawFailure();
    if (operation === 'close') f.pool.end.mockRejectedValueOnce(original);
    else f.pool.query.mockRejectedValueOnce(original);
    await expectSafeFailure(operation === 'query' ? db.query('SELECT private_sql') : operation === 'exec' ? db.exec('private migration') : db.close(), original);
    if (operation !== 'close') await db.close();
  });

  it('sanitizes pool acquisition errors without invoking the callback or releasing an unacquired client', async () => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL), original = rawFailure(), callback = vi.fn(async () => {});
    f.pool.connect.mockRejectedValueOnce(original);
    await expectSafeFailure(db.transaction(callback), original);
    expect(callback).not.toHaveBeenCalled();
    expect(f.client.query).not.toHaveBeenCalled();
    expect(f.client.release).not.toHaveBeenCalled();
    await db.close();
  });

  it.each(['BEGIN', 'SELECT private_sql', 'COMMIT'])('sanitizes failure at %s, rolls back, and releases', async failingSql => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL), original = rawFailure();
    f.client.query.mockImplementation(async sql => { if (sql === failingSql) throw original; return { rows: [] }; });
    await expectSafeFailure(db.transaction(async tx => { await tx.query('SELECT private_sql'); }), original);
    expect(f.client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(f.client.release).toHaveBeenCalledTimes(1);
    await db.close();
  });

  it.each(['next query', 'commit'] as const)('handles checked-out client errors before %s and discards the client safely', async phase => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL), original = rawFailure();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(f.client.listenerCount('error')).toBe(0);
    f.client.release.mockImplementationOnce(() => {
      expect(f.client.listenerCount('error')).toBeGreaterThan(0);
      expect(() => f.client.emit('error', rawFailure())).not.toThrow();
    });
    await expectSafeFailure(db.transaction(async tx => {
      await tx.query('SELECT authored_first');
      expect(f.client.listenerCount('error')).toBeGreaterThan(0);
      expect(() => f.client.emit('error', original)).not.toThrow();
      if (phase === 'next query') await tx.query('SELECT authored_second');
      return 'must never be committed';
    }), original);
    const statements = f.client.query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('SELECT authored_first');
    expect(statements).not.toContain('SELECT authored_second');
    expect(statements).not.toContain('COMMIT');
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    const discardError = f.client.release.mock.calls[0][0] as Error;
    expect(String(discardError)).toMatch(/PostgreSQL|database/i);
    expect(discardError.cause).toBeUndefined();
    expect(f.client.listenerCount('error')).toBe(0);
    const exposed = [String(discardError), discardError.stack, JSON.stringify(discardError),
      ...stderr.mock.calls.flat(), ...errorLog.mock.calls.flat(), ...warningLog.mock.calls.flat()].map(String).join('\n');
    expect(exposed).not.toContain('authored-secret');
    expect(exposed).not.toContain(PRIVATE_DETAIL);
    await db.close();
  });

  it('handles idle pool errors without an uncaught exception or logging driver secrets', async () => {
    const f = fixture(), db = await openPostgresDatabase(POSTGRES_URL);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(f.pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() => f.pool.emit('error', rawFailure())).not.toThrow();
    const logged = [...errorLog.mock.calls, ...warningLog.mock.calls, ...log.mock.calls, ...stderr.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toContain('authored-secret');
    expect(logged).not.toContain(PRIVATE_DETAIL);
    await db.close();
  });
});

async function mockPostgresWithEmbeddedSql(): Promise<Database> {
  const f = fixture(), embedded = new PGlite();
  await embedded.waitReady;
  const execute = async (sql: string, params?: unknown[]) => params === undefined
    ? (await embedded.exec(sql)).at(-1) ?? { rows: [] }
    : embedded.query<Record<string, unknown>>(sql, params);
  f.pool.query.mockImplementation(execute);
  f.client.query.mockImplementation(execute);
  f.pool.end.mockImplementation(() => embedded.close());
  return openPostgresDatabase(POSTGRES_URL);
}

async function semanticStoreOutcomes(db: Database) {
  const rule = JSON.parse(await readFile(new URL('../examples/semantic-rule-v2.json', import.meta.url), 'utf8')) as SemanticRuleVersion;
  const problem = (JSON.parse(await readFile(new URL('../examples/semantic-rule-cases.json', import.meta.url), 'utf8')) as ProblemCase[])[0];
  const store = await QualEvoStore.initialize(db);
  cleanups.push(() => store.close());
  const mismatched = structuredClone(rule);
  mismatched.provenance.sourceCases[0].commit = 'b'.repeat(40);
  await expect(store.importRuleVersion(mismatched, [problem])).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
  await expect(store.getProblemCase(problem.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await db.query('SELECT id FROM qe_case_lineages')).rows).toEqual([]);
  expect(await store.listRuleVersions()).toEqual([]);
  const imported = await store.importRuleVersion(rule, [problem]);
  expect(await store.importRuleVersion(rule, [problem])).toEqual(imported);
  await expect(store.importRuleVersion({ ...rule, semantics: { ...rule.semantics, expectedBehavior: 'Conflicting authored behavior' } }))
    .rejects.toMatchObject({ code: 'IMMUTABLE_CONFLICT' });
  expect(await store.getRuleVersion(imported.digest)).toEqual(imported);
  const job = ApplicationJobSchema.parse({ schemaVersion: 1, kind: 'semantic-review', workspaceId: 'authored-workspace',
    ruleDigest: imported.digest, snapshotDigest: 'b'.repeat(64) });
  const jobDigest = applicationJobDigest(job), jobId = applicationJobId(job);
  const owner = '00000000-0000-4000-8000-000000000001', contender = '00000000-0000-4000-8000-000000000002';
  expect(await store.getApplicationJob(jobDigest)).toBeNull();
  const claimed = await store.claimApplicationJob(job, owner);
  expect(claimed).toEqual({ state: 'claimed', owner });
  expect(await store.claimApplicationJob(job, contender)).toEqual({ state: 'busy' });
  const running = await store.getApplicationJob(jobDigest);
  expect(running).toEqual({ jobDigest, job, state: 'running', result: null, attempts: 1 });
  const blocked: ApplicationJobResult = { status: 'blocked', modelExecution: 'not_run', cleanup: 'not_started', reason: 'runtime_unavailable' };
  await expect(store.completeApplicationJob(job, contender, blocked)).rejects.toMatchObject({ code: 'APPLICATION_JOB_FENCED' });
  const terminal = await store.completeApplicationJob(job, owner, blocked);
  expect(await store.getApplicationJob(jobDigest)).toEqual(terminal);
  expect(await store.claimApplicationJob(job, contender)).toEqual({ state: 'finished', record: terminal });
  return {
    application: { jobDigest, jobId, claimed, running, terminal },
    imported,
    read: await store.getRuleVersion(imported.digest),
    list: await store.listRuleVersions(rule.ruleId),
    source: await store.getProblemCase(problem.id),
    active: await store.getActive(rule.ruleId),
  };
}

describe('shared domain behavior through both database adapters', () => {
  it('uses the same migrations, rule inputs, immutable outcomes, rollback and application job identities with a SQL-backed pg double', async () => {
    const embedded = await semanticStoreOutcomes(await openPGliteDatabase());
    const postgresAdapter = await semanticStoreOutcomes(await mockPostgresWithEmbeddedSql());
    expect(postgresAdapter).toEqual(embedded);
  }, 30_000);
});
