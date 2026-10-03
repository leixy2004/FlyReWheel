/** Compiled CLI + pinned official Octokit, authored transport fixtures only. No live network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'compiled-pr-history-'));
try {
  const repository = 'fixture/project', timestamp = '2026-10-01T00:00:00Z', base = '1'.repeat(40), head = '2'.repeat(40), oldTree = '3'.repeat(40), newTree = '4'.repeat(40);
  const bytes = Buffer.from('export const fixed = true;\n'), blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const prefix = `/repos/${repository}`, rows = [], routes = [
    [`${prefix}/compare/${base}...${head}`, { base_commit: { sha: base }, merge_base_commit: { sha: base }, files: [{ filename: 'file.ts', status: 'added', sha: blob }] }],
    [`${prefix}/git/commits/${base}`, { sha: base, tree: { sha: oldTree } }], [`${prefix}/git/commits/${head}`, { sha: head, tree: { sha: newTree } }],
    [`${prefix}/git/trees/${oldTree}`, { sha: oldTree, truncated: false, tree: [] }],
    [`${prefix}/git/trees/${newTree}`, { sha: newTree, truncated: false, tree: [{ path: 'file.ts', mode: '100644', type: 'blob', sha: blob, size: bytes.length }] }],
    [`${prefix}/git/blobs/${blob}`, { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }],
  ];
  for (const number of [7, 8]) {
    const url = `https://github.com/${repository}/pull/${number}`;
    rows.push({ number, html_url: url, repository_url: `https://api.github.com/repos/${repository}`, title: `Fixture PR ${number}`, state: 'open', created_at: timestamp, updated_at: timestamp, pull_request: { html_url: url, merged_at: null } });
    routes.push([`${prefix}/pulls/${number}`, { id: number, number, html_url: url, title: `Fixture PR ${number}`, body: 'Untrusted fixture statement.', user: null,
      state: 'open', draft: false, merged: false, created_at: timestamp, updated_at: timestamp, closed_at: null, merged_at: null,
      base: { ref: 'main', sha: base, repo: { full_name: repository, private: false } }, head: { ref: 'topic', sha: head, repo: null }, merge_commit_sha: null,
      changed_files: 1, comments: 0, review_comments: 0 }]);
    for (const suffix of [`issues/${number}/comments`, `pulls/${number}/reviews`, `pulls/${number}/comments`]) routes.push([`${prefix}/${suffix}`, []]);
  }
  routes.push(['/search/issues', { total_count: 2, incomplete_results: false, items: rows }]);
  const loader = join(directory, 'offline-transport.mjs'), log = join(directory, 'requests.jsonl');
  await writeFile(loader, `import assert from 'node:assert/strict'; import { appendFile } from 'node:fs/promises';
const routes = new Map(${JSON.stringify(routes)});
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input)); assert.equal(url.origin, 'https://api.github.com'); assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error'); assert.equal(new Headers(options.headers).has('authorization'), false);
  assert.equal(new Headers(options.headers).get('x-github-api-version'), '2022-11-28');
  if (url.pathname === '/search/issues') assert.equal(url.searchParams.get('q'), 'repo:fixture/project is:pr created:2026-10-01T00:00:00Z..2026-10-01T23:59:59Z is:open');
  assert(routes.has(url.pathname), 'Unexpected request'); await appendFile(${JSON.stringify(log)}, JSON.stringify(url.pathname)+'\\n');
  return new Response(JSON.stringify(routes.get(url.pathname)), { status: 200, headers: { 'content-type': 'application/json' } });
};\n`);
  const run = async (args, expectedCode = 0) => {
    let result;
    try { result = await exec(process.execPath, ['--import', loader, 'dist/cli.js', 'github-pr', 'history', ...args], { cwd: root, timeout: 30_000, maxBuffer: 2_000_000,
      env: { ...process.env, QE_ENABLE_MODEL: 'true', QE_CODEX_AUTH_MODE: 'must-not-run', GITHUB_TOKEN: 'must-not-use' } }); assert.equal(expectedCode, 0); }
    catch (error) { assert.equal(error.code, expectedCode, error.stderr); result = error; }
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const file = join(directory, 'plan.json'), db = join(directory, 'db');
  await run(['preview', '--repository', repository, '--created-from', timestamp, '--created-before', '2026-10-02T00:00:00Z', '--status', 'open', '--out', file]);
  const plan = JSON.parse(await readFile(file, 'utf8'));
  const imported = await run(['import', '--file', file, '--db', db]); assert.equal(imported.items.length, 2);
  const args = ['--batch', plan.digest, '--db', db];
  const first = await run(['capture', ...args, '--max-pulls', '1'], 2);
  assert.deepEqual(first.batch.items.map(item => item.status), ['captured', 'pending']);
  const second = await run(['capture', ...args]); assert.deepEqual(second.batch.items.map(item => item.status), ['captured', 'captured']);
  assert.deepEqual(second.run.freshCaptures.map(item => item.number), [8]);
  const input = { id: 'compiled-history-request', evidenceDigest: second.batch.items[0].evidenceDigest, sources: [{ side: 'after', path: 'file.ts' }], statements: [{ kind: 'pull' }],
    requestedRule: { ruleId: 'compiled-history-rule', version: 'draft-1', parentDigest: null }, objective: 'Investigate explicit fixture evidence.', actor: 'fixture-operator', source: 'fixture', createdAt: timestamp };
  const requestFile = join(directory, 'request.json'); await writeFile(requestFile, JSON.stringify(input));
  const request = await run(['mining-request', ...args, '--number', '7', '--file', requestFile]); assert.equal(request.request.trust.labels, 'unknown-only');
  const shown = await run(['show', ...args]); assert.deepEqual(shown.items[0].miningRequestDigests, [request.digest]); assert.equal(shown.receipt.kind, 'package-integrity-only');
  const resumed = await run(['capture', ...args]); assert.equal(resumed.run.requests, 0); assert.deepEqual(resumed.run.freshCaptures, []);
  const list = await run(['list', '--db', db, '--repository', repository]); assert.equal(list.batches[0].counts.captured, 2);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(path => path === '/search/issues').length, 1);
  for (const number of [7, 8]) assert.equal(calls.filter(path => path === `${prefix}/pulls/${number}`).length, 2);
  process.stdout.write(JSON.stringify({ mode: 'offline-authored-transport-fixture', transport: '@octokit/rest@22.0.1', compiledCli: true,
    checked: ['preview', 'import', 'partial-capture-exit-2', 'reopen-resume', 'exact-mining-link', 'show', 'list', 'zero-read-completed-resume'],
    externalNetworkRequests: 0, mockedGetRequests: calls.length, pullNumbers: [7, 8], labels: 'unknown-only', receipt: 'package-integrity-only', modelExecution: 'not_run' }, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }
