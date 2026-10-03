import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = import.meta.resolve('tsx');
// Authored fixture only. All children block sockets/fetch; no live PostgreSQL is needed.
const sentinelUrl = 'postgresql://selector-fixture:authored-only@database-selection.invalid/fixture';
const digest = 'a'.repeat(64), sha = 'b'.repeat(40);
let directory: string, guard: string, networkMarker: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'database-selection-cli-'));
  guard = join(directory, 'offline-guard.mjs');
  networkMarker = join(directory, 'forbidden-network-attempt');
  await writeFile(guard, `import { Socket } from 'node:net';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
const tsxPipe = join(tmpdir(), 'tsx-' + (process.geteuid?.() ?? userInfo().username), process.ppid + '.pipe');
const reject = () => {
  appendFileSync(${JSON.stringify(networkMarker)}, 'attempt\\n');
  throw new Error('DATABASE_SELECTION_TEST_FORBIDS_NETWORK');
};
// tsx probes its parent's local IPC pipe during import. Block it too, but it is not a network service.
Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof options === 'string' ? options : options?.path;
  if (path === tsxPipe) throw new Error('Source runner local IPC disabled by offline fixture');
  return reject();
};
globalThis.fetch = reject;
`, { flag: 'wx' });
});
afterEach(async () => { await expect(stat(networkMarker)).rejects.toMatchObject({ code: 'ENOENT' }); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function run(args: string[], databaseUrl: string | null = sentinelUrl, cwd = root, entry = 'cli.ts') {
  // Deliberately do not inherit ambient database/provider/queue credentials.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
    NODE_ENV: 'test', QE_ENABLE_MODEL: 'false', QE_CODEX_AUTH_MODE: 'not-configured' };
  if (databaseUrl !== null) env.DATABASE_URL = databaseUrl;
  return exec(process.execPath, ['--import', pathToFileURL(guard).href, '--import', tsx, join(root, 'src', entry), ...args],
    { cwd, env, timeout: 30_000, maxBuffer: 4_000_000 });
}
async function rejectsBeforeAcquisition(args: string[], pattern: RegExp, databaseUrl: string | null = sentinelUrl) {
  const result = await run(args, databaseUrl).then(value => ({ code: 0, ...value }), error => error as { code: number; stdout: string; stderr: string });
  expect(result.code, JSON.stringify(args)).toBe(1);
  expect(result.stdout, JSON.stringify(args)).toBe('');
  expect(result.stderr, JSON.stringify(args)).toMatch(pattern);
  expect(result.stderr, JSON.stringify(args)).not.toMatch(/ENOENT|not a git repository|DATABASE_SELECTION_TEST_FORBIDS_NETWORK|ECONNREFUSED|ENOTFOUND/);
}

// Every durable domain leaf must advertise the same opt-in PostgreSQL selector.
const domainCommands = [
  ['github-pr', 'capture'], ['github-pr', 'import'], ['github-pr', 'show'],
  ['github-pr', 'history', 'import'], ['github-pr', 'history', 'show'], ['github-pr', 'history', 'list'],
  ['github-pr', 'history', 'capture'], ['github-pr', 'history', 'mining-request'],
  ['mining', 'request'], ['mining', 'show'], ['mining', 'list'], ['mining', 'supply'], ['mining', 'candidate'], ['mining', 'candidates'],
  ['contexts', 'capture'], ['contexts', 'import'], ['contexts', 'show'], ['contexts', 'verify'], ['contexts', 'cite'], ['contexts', 'list'],
  ['snapshots', 'capture'], ['snapshots', 'import'], ['snapshots', 'show'], ['snapshots', 'list'],
  ['reviews', 'demo'], ['reviews', 'run'], ['reviews', 'show'], ['reviews', 'list'], ['reviews', 'finding'],
  ['feedback', 'add'],
  ['revisions', 'request'], ['revisions', 'show'], ['revisions', 'list'], ['revisions', 'demo'], ['revisions', 'compare'],
  ['revisions', 'candidate'], ['revisions', 'candidates'], ['revisions', 'outcome'], ['revisions', 'outcomes'],
  ['revisions', 'comparison'], ['revisions', 'comparisons'], ['revisions', 'decide'], ['revisions', 'decision'], ['revisions', 'decisions'],
  ['rules', 'import'], ['rules', 'show'], ['rules', 'list'],
  ['rules', 'governance', 'apply'], ['rules', 'governance', 'show'], ['rules', 'governance', 'history'], ['rules', 'governance', 'select'],
  ['application-jobs', 'status'], ['demo'], ['replay'],
];
it.each(domainCommands.map(command => [command.join(' '), command] as const))('%s help exposes both explicit database selectors', async (_name, command) => {
  const { stdout } = await run([...command, '--help']);
  expect(stdout).toContain('--db <directory>');
  expect(stdout).toMatch(/--postgres(?:\s|$)/);
  expect(stdout).not.toMatch(/--postgres\s+[<[]/);
}, 30_000);
it.each([['enqueue'], ['application-jobs', 'enqueue']])('%s help exposes explicit PostgreSQL opt-in', async (...command) => {
  expect((await run([...command, '--help'])).stdout).toMatch(/--postgres(?:\s|$)/);
}, 30_000);

function acquisitionCommands() {
  const missing = join(directory, 'missing-input.json'), repo = join(directory, 'missing-repository');
  return [
    ['rules', 'import', '--rule', missing],
    ['snapshots', 'import', '--file', missing],
    ['snapshots', 'capture', '--repo', repo, '--repository-id', 'authored:selector', '--base-tip', sha, '--head', sha],
    ['contexts', 'import', '--file', missing],
    ['contexts', 'capture', '--repo', repo, '--repository-id', 'authored:selector', '--head', sha, '--path', 'src/missing.ts'],
    ['github-pr', 'capture', '--repository', 'authored-selector/never-contacted', '--number', '1'],
    ['github-pr', 'import', '--file', missing],
    ['github-pr', 'history', 'import', '--file', missing],
    ['github-pr', 'history', 'mining-request', '--batch', digest, '--number', '1', '--file', missing],
    ['mining', 'request', '--file', missing], ['mining', 'supply', '--file', missing],
    ['reviews', 'run', '--rule-digest', digest, '--snapshot-digest', digest, '--offline-fixtures', missing],
    ['feedback', 'add', '--file', missing], ['revisions', 'request', '--file', missing],
    ['revisions', 'compare', '--file', missing], ['revisions', 'decide', '--file', missing],
    ['rules', 'governance', 'apply', '--file', missing],
    ['application-jobs', 'status', '--file', missing],
  ];
}
it('rejects missing selectors before file, Git, or GitHub acquisition even with ambient DATABASE_URL', async () => {
  for (const args of acquisitionCommands()) await rejectsBeforeAcquisition(args, /--db.*--postgres|--postgres.*--db/);
}, 120_000);
it('rejects conflicting selectors before input acquisition or local database/output creation', async () => {
  const db = join(directory, 'conflict-db'), out = join(directory, 'conflict-output.json');
  for (const args of acquisitionCommands()) {
    await rejectsBeforeAcquisition([...args, '--db', db, '--postgres', '--out', out], /--db.*--postgres|--postgres.*--db/);
  }
  await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
}, 120_000);
it('rejects PostgreSQL without configuration before file, Git, or GitHub acquisition', async () => {
  for (const args of acquisitionCommands()) await rejectsBeforeAcquisition([...args, '--postgres'], /DATABASE_URL/, '');
}, 120_000);
it('rejects ephemeral or empty --db selectors before input acquisition', async () => {
  const missing = join(directory, 'missing-local-rule.json'), out = join(directory, 'invalid-local-output.json');
  for (const db of ['memory://', 'MeMoRy://authored', 'idb://', 'IDB://authored',
    'opfs-ahp://', 'OPFS-AHP://authored', 'file://', 'file:// \t ', '', ' \t ']) {
    await rejectsBeforeAcquisition(['rules', 'import', '--rule', missing, '--db', db, '--out', out], /--db.*(?:persistent|nonempty).*directory/);
  }
  await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);
it.each([
  null, '', ' \t ', 'not-a-url', 'https://database-selection.invalid/fixture',
  'postgresql:///fixture', 'postgresql://database-selection.invalid', 'postgresql://database-selection.invalid/', 'postgresql://database-selection.invalid/%20',
])('rejects invalid explicit PostgreSQL configuration %j without touching inputs or services', async value => {
  await rejectsBeforeAcquisition(['rules', 'import', '--rule', join(directory, 'missing-rule.json'), '--postgres'], /DATABASE_URL|PostgreSQL|postgres/i, value);
}, 30_000);
it('requires PostgreSQL opt-in for both queue entrypoints despite ambient DATABASE_URL', async () => {
  const missing = join(directory, 'missing-job.json');
  for (const args of [
    ['enqueue', '--bundle', missing, '--dataset', missing],
    ['application-jobs', 'enqueue', '--file', missing],
  ]) {
    await rejectsBeforeAcquisition(args, /--postgres/);
    await rejectsBeforeAcquisition([...args, '--postgres'], /DATABASE_URL/, '');
    await rejectsBeforeAcquisition([...args, '--postgres'], /DATABASE_URL|PostgreSQL|postgres/i, 'postgresql:///fixture');
  }
}, 60_000);
it('does not accept a connection URL as the --postgres option value', async () => {
  await rejectsBeforeAcquisition(['rules', 'list', '--postgres', sentinelUrl], /too many arguments|unexpected argument/i);
}, 30_000);

it('preserves explicit local import/show and application-job status across separate processes with ambient DATABASE_URL', async () => {
  const db = join(directory, 'local-db');
  const rule = join(root, 'examples/semantic-rule-v2.json'), cases = join(root, 'examples/semantic-rule-cases.json');
  const imported = JSON.parse((await run(['rules', 'import', '--rule', rule, '--cases', cases, '--db', db])).stdout);
  expect(imported.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse((await run(['rules', 'show', '--digest', imported.digest, '--db', db])).stdout)).toEqual(imported);
  // An invalid ambient URL must be irrelevant when --db explicitly selects local storage.
  expect(JSON.parse((await run(['rules', 'list', '--db', db], 'not-a-database-url')).stdout)).toEqual([imported]);
  const job = join(directory, 'local-job.json');
  await writeFile(job, JSON.stringify({ schemaVersion: 1, kind: 'semantic-review', workspaceId: 'authored-selector',
    ruleDigest: imported.digest, snapshotDigest: digest }), { flag: 'wx' });
  const first = JSON.parse((await run(['application-jobs', 'status', '--file', job, '--db', db])).stdout);
  expect(first).toMatchObject({ state: 'not_started', attempts: 0, queueState: null, result: null });
  expect(JSON.parse((await run(['application-jobs', 'status', '--file', job, '--db', db])).stdout)).toEqual(first);
}, 90_000);
it('retains in-memory demo/replay defaults despite ambient DATABASE_URL', async () => {
  const cwd = join(directory, 'memory-defaults');
  await mkdir(cwd);
  const demo = JSON.parse((await run(['demo'], sentinelUrl, cwd)).stdout);
  expect(demo).toMatchObject({ mode: 'offline_fixture', feedbackExample: { resolveRecorded: true } });
  const replay = JSON.parse((await run(['replay', '--bundle', join(root, 'examples/deadline-bundle.json'),
    '--dataset', join(root, 'examples/deadline-dataset.json')], sentinelUrl, cwd)).stdout);
  expect(replay).toMatchObject({ mode: 'offline_fixture', modelIdentity: null });
  expect(await readdir(cwd)).toEqual([]);
}, 60_000);
it('keeps the dedicated closed-loop demo local and rejects --postgres before output creation', async () => {
  const help = (await run(['closed-loop', 'demo', '--help'])).stdout;
  expect(help).toContain('--db <directory>');
  expect(help).not.toContain('--postgres');
  const out = join(directory, 'never-created-closed-loop');
  await rejectsBeforeAcquisition(['closed-loop', 'demo', '--out-dir', out, '--postgres'], /unknown option.*--postgres/);
  await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
}, 30_000);
it('keeps worker --check service-free with an authored PostgreSQL URL', async () => {
  const result = JSON.parse((await run(['--check'], sentinelUrl, root, 'worker.ts')).stdout);
  expect(result).toMatchObject({ status: 'checked', queues: ['replay', 'application'], applicationRuntime: 'blocked' });
}, 30_000);

it.each([null, '', 'not-a-url', 'postgresql://selector-fixture:authored-only@database-selection.invalid/'])(
  'rejects worker startup with invalid DATABASE_URL %j without opening services or exposing configuration', async databaseUrl => {
    const result = await run([], databaseUrl, root, 'worker.ts').then(value => ({ code: 0, ...value }),
      error => error as { code: number; stdout: string; stderr: string });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Worker startup failed');
    expect(result.stderr).toContain('DATABASE_URL');
    expect(result.stderr).not.toMatch(/selector-fixture|authored-only|database-selection\.invalid|not-a-url|DATABASE_SELECTION_TEST_FORBIDS_NETWORK/);
  }, 30_000);
