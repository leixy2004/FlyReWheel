import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run after npm run build. Compiled artifacts only; no provider credentials,
// network, queue server, or live PostgreSQL are needed or permitted.
const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist/cli.js'), worker = join(root, 'dist/worker.js');
await Promise.all([access(cli), access(worker)]);
const directory = await mkdtemp(join(tmpdir(), 'compiled-database-selection-'));
const sentinelUrl = 'postgresql://selector-fixture:authored-only@database-selection.invalid/fixture';
const guard = join(directory, 'offline-guard.mjs'), marker = join(directory, 'forbidden-network-attempt');
let checks = 0;
async function absent(path) {
  await assert.rejects(access(path), error => error.code === 'ENOENT', `Unexpected file or network effect: ${path}`);
}
async function invoke(args, databaseUrl = sentinelUrl, entry = cli, cwd = root) {
  const result = await exec(process.execPath, ['--import', pathToFileURL(guard).href, entry, ...args], {
    cwd, timeout: 30_000, maxBuffer: 4_000_000,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, NODE_ENV: 'test',
      QE_ENABLE_MODEL: 'false', QE_CODEX_AUTH_MODE: 'not-configured', ...(databaseUrl === null ? {} : { DATABASE_URL: databaseUrl }) },
  }).then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  await absent(marker);
  return result;
}
async function succeeds(args, databaseUrl = sentinelUrl, entry = cli, cwd = root) {
  const result = await invoke(args, databaseUrl, entry, cwd);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
  checks++;
  return result.stdout;
}
async function rejectsBeforeAcquisition(args, pattern, databaseUrl = sentinelUrl) {
  const result = await invoke(args, databaseUrl);
  assert.equal(result.code, 1, args.join(' '));
  assert.equal(result.stdout, '', args.join(' '));
  assert.match(result.stderr, pattern, args.join(' '));
  assert.doesNotMatch(result.stderr, /ENOENT|not a git repository|DATABASE_SELECTION_SMOKE_FORBIDS_NETWORK|ECONNREFUSED|ENOTFOUND/);
  checks++;
}
try {
  await writeFile(guard, `import { Socket } from 'node:net';
import { appendFileSync } from 'node:fs';
const reject = () => {
  appendFileSync(${JSON.stringify(marker)}, 'attempt\\n');
  throw new Error('DATABASE_SELECTION_SMOKE_FORBIDS_NETWORK');
};
Socket.prototype.connect = reject;
globalThis.fetch = reject;
`, { flag: 'wx' });
  const helpCommands = [
    ['rules', 'import'], ['rules', 'governance', 'apply'], ['snapshots', 'capture'], ['contexts', 'capture'],
    ['github-pr', 'capture'], ['github-pr', 'history', 'import'], ['mining', 'request'], ['reviews', 'run'],
    ['feedback', 'add'], ['revisions', 'compare'], ['application-jobs', 'status'], ['application-jobs', 'enqueue'], ['enqueue'],
  ];
  for (const args of helpCommands) {
    const help = await succeeds([...args, '--help']);
    assert.match(help, /--postgres(?:\s|$)/);
    assert.doesNotMatch(help, /--postgres\s+[<[]/);
  }
  const missing = join(directory, 'never-created-input.json'), db = join(directory, 'never-created-db');
  const out = join(directory, 'never-created-output.json'), repo = join(directory, 'never-created-repository');
  const selector = /--db.*--postgres|--postgres.*--db/;
  const commands = [
    ['rules', 'import', '--rule', missing],
    ['snapshots', 'capture', '--repo', repo, '--repository-id', 'authored:selector', '--base-tip', 'a'.repeat(40), '--head', 'b'.repeat(40)],
    ['contexts', 'import', '--file', missing],
    ['github-pr', 'capture', '--repository', 'authored-selector/never-contacted', '--number', '1'],
    ['github-pr', 'history', 'import', '--file', missing],
    ['mining', 'request', '--file', missing],
    ['reviews', 'run', '--rule-digest', 'a'.repeat(64), '--snapshot-digest', 'b'.repeat(64), '--offline-fixtures', missing],
    ['feedback', 'add', '--file', missing],
    ['revisions', 'compare', '--file', missing],
    ['rules', 'governance', 'apply', '--file', missing],
    ['application-jobs', 'status', '--file', missing],
  ];
  for (const args of commands) {
    await rejectsBeforeAcquisition(args, selector);
    await rejectsBeforeAcquisition([...args, '--db', db, '--postgres', '--out', out], selector);
    await rejectsBeforeAcquisition([...args, '--postgres'], /DATABASE_URL/, '');
  }
  for (const localSelector of ['memory://', 'MeMoRy://authored', 'idb://', 'IDB://authored',
    'opfs-ahp://', 'OPFS-AHP://authored', 'file://', 'file:// \t ', '', ' \t ']) {
    await rejectsBeforeAcquisition(['rules', 'import', '--rule', missing, '--db', localSelector, '--out', out], /--db.*(?:persistent|nonempty).*directory/);
  }
  for (const url of [null, ' \t ', 'not-a-url', 'https://database-selection.invalid/fixture',
    'postgresql:///fixture', 'postgresql://database-selection.invalid', 'postgresql://database-selection.invalid/', 'postgresql://database-selection.invalid/%20']) {
    await rejectsBeforeAcquisition(['rules', 'import', '--rule', missing, '--postgres'], /DATABASE_URL|PostgreSQL|postgres/i, url);
  }
  for (const args of [['enqueue', '--bundle', missing, '--dataset', missing], ['application-jobs', 'enqueue', '--file', missing]]) {
    await rejectsBeforeAcquisition(args, /--postgres/);
    await rejectsBeforeAcquisition([...args, '--postgres'], /DATABASE_URL/, '');
    await rejectsBeforeAcquisition([...args, '--postgres'], /DATABASE_URL|PostgreSQL|postgres/i, 'postgresql:///fixture');
  }
  await rejectsBeforeAcquisition(['rules', 'list', '--postgres', sentinelUrl], /too many arguments|unexpected argument/i);
  await Promise.all([absent(db), absent(out), absent(repo), absent(missing)]);

  const localDb = join(directory, 'local-db');
  const imported = JSON.parse(await succeeds(['rules', 'import', '--rule', join(root, 'examples/semantic-rule-v2.json'),
    '--cases', join(root, 'examples/semantic-rule-cases.json'), '--db', localDb]));
  assert.match(imported.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await succeeds(['rules', 'show', '--digest', imported.digest, '--db', localDb])), imported);
  assert.deepEqual(JSON.parse(await succeeds(['rules', 'list', '--db', localDb], 'not-a-database-url')), [imported]);
  const job = join(directory, 'authored-job.json');
  await writeFile(job, JSON.stringify({ schemaVersion: 1, kind: 'semantic-review', workspaceId: 'authored-selector',
    ruleDigest: imported.digest, snapshotDigest: 'a'.repeat(64) }), { flag: 'wx' });
  const first = JSON.parse(await succeeds(['application-jobs', 'status', '--file', job, '--db', localDb]));
  assert.equal(first.state, 'not_started');
  assert.equal(first.queueState, null);
  assert.equal(first.attempts, 0);
  assert.equal(first.result, null);
  assert.deepEqual(JSON.parse(await succeeds(['application-jobs', 'status', '--file', job, '--db', localDb])), first);

  const memoryCwd = join(directory, 'in-memory-defaults');
  await mkdir(memoryCwd);
  const demo = JSON.parse(await succeeds(['demo'], sentinelUrl, cli, memoryCwd));
  assert.equal(demo.mode, 'offline_fixture');
  assert.equal(demo.feedbackExample.resolveRecorded, true);
  const replay = JSON.parse(await succeeds(['replay', '--bundle', join(root, 'examples/deadline-bundle.json'),
    '--dataset', join(root, 'examples/deadline-dataset.json')], sentinelUrl, cli, memoryCwd));
  assert.equal(replay.mode, 'offline_fixture');
  assert.equal(replay.modelIdentity, null);
  assert.deepEqual(await readdir(memoryCwd), []);

  const closedLoop = join(directory, 'never-created-closed-loop');
  assert.doesNotMatch(await succeeds(['closed-loop', 'demo', '--help']), /--postgres/);
  await rejectsBeforeAcquisition(['closed-loop', 'demo', '--out-dir', closedLoop, '--postgres'], /unknown option.*--postgres/);
  await absent(closedLoop);
  const checked = JSON.parse(await succeeds(['--check'], sentinelUrl, worker));
  assert.equal(checked.status, 'checked');
  assert.deepEqual(checked.queues, ['replay', 'application']);
  assert.equal(checked.applicationRuntime, 'blocked');
  for (const databaseUrl of [null, '', 'not-a-url', 'postgresql://selector-fixture:authored-only@database-selection.invalid/']) {
    const rejected = await invoke([], databaseUrl, worker);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /Worker startup failed/);
    assert.match(rejected.stderr, /DATABASE_URL/);
    assert.doesNotMatch(rejected.stderr, /selector-fixture|authored-only|database-selection\.invalid|not-a-url|DATABASE_SELECTION_SMOKE_FORBIDS_NETWORK/);
    checks++;
  }
  await absent(marker);
  console.log(JSON.stringify({ mode: 'compiled-offline-database-selection-smoke', checks,
    explicitSelectors: 'passed', validationBeforeAcquisition: 'passed', localCrossProcessPersistence: 'passed',
    ambientDatabaseUrlIsolation: 'passed', inMemoryDefaults: 'passed', closedLoopLocalOnly: 'passed',
    workerCheck: 'service-free', networkAttempts: 0, livePostgres: 'not_used' }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
