import { describe, expect, it, vi } from 'vitest';
import { openSelectedStore, resolveDatabaseSelection, type DatabaseOptions } from '../src/storage/connection.js';
import type { QualEvoStore } from '../src/storage/store.js';

const POSTGRES_URL = 'postgresql://authored-user:authored-password@database.example.test:5432/flyrewheel?sslmode=require';
function unreadableEnvironment(): NodeJS.ProcessEnv {
  return Object.defineProperty({}, 'DATABASE_URL', { get() { throw new Error('DATABASE_URL must not be read'); } });
}
function fakeOpeners() {
  const local = { close: vi.fn(async () => {}) } as unknown as QualEvoStore;
  const remote = { close: vi.fn(async () => {}) } as unknown as QualEvoStore;
  return { local, remote, openers: {
    pglite: vi.fn(async (_path?: string) => local),
    postgres: vi.fn(async (_connectionString: string) => remote),
  } };
}

describe('explicit database selection', () => {
  it.each(['./data/authored-db', '/tmp/authored-db', 'data with spaces'])('selects the exact local path %s without reading DATABASE_URL', path => {
    expect(resolveDatabaseSelection({ db: path }, unreadableEnvironment())).toEqual({ kind: 'pglite', path });
  });

  it('does not let ambient PostgreSQL configuration override an explicit local database', () => {
    expect(resolveDatabaseSelection({ db: './local' }, { DATABASE_URL: POSTGRES_URL })).toEqual({ kind: 'pglite', path: './local' });
  });

  it('allows an in-memory default only when the caller explicitly permits it', () => {
    expect(resolveDatabaseSelection({}, unreadableEnvironment(), { allowMemory: true })).toEqual({ kind: 'pglite' });
    expect(resolveDatabaseSelection({ postgres: false }, unreadableEnvironment(), { allowMemory: true })).toEqual({ kind: 'pglite' });
    expect(() => resolveDatabaseSelection({}, unreadableEnvironment())).toThrow(/--db|--postgres/);
  });

  it.each<DatabaseOptions>([{ db: './local', postgres: true }, { db: '', postgres: true }])('rejects ambiguous selections before reading DATABASE_URL: %j', options => {
    expect(() => resolveDatabaseSelection(options, unreadableEnvironment())).toThrow(/--db|--postgres/);
  });

  it.each(['', ' ', '\t\n'])('rejects an empty local database rather than silently choosing memory: %j', db => {
    expect(() => resolveDatabaseSelection({ db }, unreadableEnvironment(), { allowMemory: true })).toThrow(/--db|path|empty/i);
  });

  it.each([
    'memory://', 'memory://authored-name', 'MEMORY://authored-name',
    'idb://', 'idb://authored-name', 'IdB://authored-name',
    'opfs-ahp://', 'opfs-ahp://authored-name', 'OPFS-AHP://authored-name',
    'file://', 'file:// ', 'file://\t\n',
  ])('rejects a virtual or empty file database route without reading DATABASE_URL: %j', db => {
    expect(() => resolveDatabaseSelection({ db }, unreadableEnvironment())).toThrow(/--db|local|directory|PGlite/i);
    expect(() => resolveDatabaseSelection({ db }, unreadableEnvironment(), { allowMemory: true })).toThrow(/--db|local|directory|PGlite/i);
  });

  it.each(['file://./authored-db', 'file:///tmp/authored-db', 'FILE://./authored-db'])('preserves a nonempty explicit file database route: %s', path => {
    expect(resolveDatabaseSelection({ db: path }, unreadableEnvironment())).toEqual({ kind: 'pglite', path });
  });

  it.each(['postgres://database.example.test/flyrewheel', POSTGRES_URL])('selects PostgreSQL only on explicit opt-in and preserves its URL', connectionString => {
    expect(resolveDatabaseSelection({ postgres: true }, { DATABASE_URL: connectionString })).toEqual({ kind: 'postgres', connectionString });
  });

  it.each([undefined, '', ' ', '\t\n'])('rejects absent or blank DATABASE_URL: %j', DATABASE_URL => {
    expect(() => resolveDatabaseSelection({ postgres: true }, { DATABASE_URL })).toThrow(/DATABASE_URL|PostgreSQL/i);
  });

  it.each([
    'https://authored-user:authored-password@database.example.test/flyrewheel',
    'postgres://authored-user:authored-password@database.example.test',
    'postgres://authored-user:authored-password@database.example.test/',
    'postgres:///flyrewheel',
    'postgres://database.example.test/%20%20',
    'postgres://database.example.test/%09%0A',
    'postgres://authored-user:authored-password@/flyrewheel',
    'host=database.example.test dbname=flyrewheel password=authored-password',
    'not-a-database-url',
  ])('rejects a malformed or incomplete PostgreSQL URL without disclosing it: %j', DATABASE_URL => {
    let failure: unknown;
    try { resolveDatabaseSelection({ postgres: true }, { DATABASE_URL }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/DATABASE_URL|PostgreSQL/i);
    expect(String(failure)).not.toContain(DATABASE_URL);
    expect(String(failure)).not.toContain('authored-password');
  });

  it('requires explicit PostgreSQL for queue/worker callers, even when memory is allowed', () => {
    for (const options of [{}, { db: './local' }, { postgres: false }]) {
      expect(() => resolveDatabaseSelection(options, unreadableEnvironment(), { postgresOnly: true, allowMemory: true })).toThrow(/--postgres|PostgreSQL/i);
    }
    expect(resolveDatabaseSelection({ postgres: true }, { DATABASE_URL: POSTGRES_URL }, { postgresOnly: true }))
      .toEqual({ kind: 'postgres', connectionString: POSTGRES_URL });
  });
});

describe('opening the selected existing store backend', () => {
  it('passes only the local path to PGlite', async () => {
    const f = fakeOpeners();
    expect(await openSelectedStore({ kind: 'pglite', path: './authored-local-db' }, f.openers)).toBe(f.local);
    expect(f.openers.pglite).toHaveBeenCalledExactlyOnceWith('./authored-local-db');
    expect(f.openers.postgres).not.toHaveBeenCalled();
  });

  it('opens the safe memory store without invoking PostgreSQL', async () => {
    const f = fakeOpeners();
    expect(await openSelectedStore({ kind: 'pglite' }, f.openers)).toBe(f.local);
    expect(f.openers.pglite).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.openers.postgres).not.toHaveBeenCalled();
  });

  it('passes only the explicitly selected connection string to PostgreSQL', async () => {
    const f = fakeOpeners();
    expect(await openSelectedStore({ kind: 'postgres', connectionString: POSTGRES_URL }, f.openers)).toBe(f.remote);
    expect(f.openers.postgres).toHaveBeenCalledExactlyOnceWith(POSTGRES_URL);
    expect(f.openers.pglite).not.toHaveBeenCalled();
  });

  it('does not silently fall back to local storage when PostgreSQL opening fails', async () => {
    const f = fakeOpeners(), failure = new Error('Authored PostgreSQL unavailable');
    f.openers.postgres.mockRejectedValueOnce(failure);
    await expect(openSelectedStore({ kind: 'postgres', connectionString: POSTGRES_URL }, f.openers)).rejects.toBe(failure);
    expect(f.openers.pglite).not.toHaveBeenCalled();
  });
});
