import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exportEvaluationCheckout, inspectEvaluationCheckout } from '../dist/workspace/evaluation-checkout.js';

// DEVELOPMENT FIXTURE ONLY. Synthetic history and visibility declarations are
// deliberately authored; this establishes no historical public availability.
const exec = promisify(execFile), project = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'evaluation-checkout-smoke-'));
let fetchBoundaryCalls = 0;
globalThis.fetch = async () => { fetchBoundaryCalls++; throw new Error('No external fetch permitted in this development fixture'); };
const env = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Development fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Development fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
const git = async (cwd, ...args) => (await exec('/usr/bin/git', args, { cwd, env })).stdout.trim();
try {
  const source = join(root, 'source'), storePath = join(root, 'store'); await mkdir(source);
  await git(source, 'init', '--quiet', '--template='); await mkdir(join(source, 'src')); await mkdir(join(source, 'tests'));
  await writeFile(join(source, 'src/value.ts'), 'export const value = "unknown";\n');
  await writeFile(join(source, 'tests/value.test.ts'), '// Committed tests are available, not executed\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Allowed development fixture'); const allowed = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'checkout', '-qb', 'future-answer');
  await writeFile(join(source, 'src/value.ts'), 'export const value = "FUTURE_ANSWER";\n');
  await writeFile(join(source, 'answer.txt'), 'FUTURE_ANSWER\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Future answer with backdated timestamp'); const future = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'tag', '-am', 'Future annotated answer', 'future-answer'); const tag = await git(source, 'rev-parse', 'future-answer');
  await writeFile(join(root, 'dangling.txt'), 'DANGLING_FUTURE_ANSWER\n'); const dangling = await git(source, 'hash-object', '-w', join(root, 'dangling.txt'));
  await git(source, 'repack', '-ad'); const originalRefs = await git(source, 'show-ref');
  const manifest = { schemaVersion: 1, repositoryId: 'development-fixture/evaluation-checkout', classification: 'development-fixture',
    allowedHeads: [allowed], checkoutSha: allowed, visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: '2001-01-01T00:00:00Z', evidenceDigests: [] } };
  const input = { repoPath: source, storePath, manifest }, result = await exportEvaluationCheckout(input);
  assert.deepEqual(await inspectEvaluationCheckout(input), result); assert.deepEqual(await exportEvaluationCheckout(input), result);
  assert.equal(await git(source, 'show-ref'), originalRefs);
  for (const oid of [future, tag, dangling]) await assert.rejects(git(result.repoPath, 'cat-file', '-e', oid));
  assert.equal(await readFile(join(result.repoPath, 'src/value.ts'), 'utf8'), 'export const value = "unknown";\n');
  assert.match(await readFile(join(result.repoPath, 'tests/value.test.ts'), 'utf8'), /Committed tests/);
  const manifestPath = join(root, 'visibility.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const cli = JSON.parse((await exec(process.execPath, ['dist/cli.js', 'evaluation', 'checkout', 'inspect', '--store', storePath, '--manifest', manifestPath], { cwd: project })).stdout);
  assert.deepEqual(cli, result);
  await writeFile(join(result.repoPath, 'src/.git'), 'HIDDEN_FUTURE_ANSWER');
  await assert.rejects(inspectEvaluationCheckout(input), /filesystem entry/);
  assert.equal(fetchBoundaryCalls, 0);
  console.log(JSON.stringify({ schemaVersion: 1, classification: 'development-fixture',
    mode: 'compiled-exact-head-object-closure-smoke', policy: result.record.policy,
    requestDigest: result.requestDigest, recordDigest: result.recordDigest, inventory: result.record.inventory,
    allowedHeads: result.record.request.allowedHeads, refs: result.record.refs,
    fullSourceAndTestTree: 'verified-without-execution', forbiddenFutureObjectLookups: 'all-rejected',
    sourceRefs: 'unchanged', apiInspectAndRerun: 'identical', compiledCliInspect: 'identical', hiddenDotGitFileTampering: 'rejected',
    fetchBoundaryCalls, modelExecution: 'not_run', targetCodeExecution: 'not_run', productionTransferPolicy: 'unchanged-all-local-refs-v1',
    historicalPublicAvailability: 'unproven', timestampsEstablishVisibility: false,
    limitations: ['Authored development fixture, not an empirical evaluation or historical availability proof.',
      'Object/ref isolation is not a filesystem or runtime sandbox; isolate the source store from any evaluation runner.',
      'Record metadata hash is export-instance specific; request and logical object inventory digests are path-independent.'] }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
