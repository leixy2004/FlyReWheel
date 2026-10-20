import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const exec = promisify(execFile), project = fileURLToPath(new URL('..', import.meta.url));
const tsx = import.meta.resolve('tsx');
const cases: [string, string[], string][] = [
  ['scripts/prepare-w0-mining.ts', [], 'Usage: node --import tsx scripts/prepare-w0-mining.ts'],
  ['scripts/capture-w0-first-three.ts', [], 'REQUIRE_EXECUTE_AFTER_PLAN_PUSH_SHA'],
  ['scripts/materialize-w0-context.ts', [], 'Specify --stage'],
  ['scripts/check-w0-behavior-inputs.ts', [], 'Supply a new output JSON path'],
  ['scripts/run-w0-proxy-attempt.ts', [], 'REQUIRE_STAGE_AND_PUBLISHED_PLAN_COMMIT'],
  ['scripts/prepare-w0-evaluation-inputs.ts', [], 'Supply new --out and --private-dir paths'],
  ['scripts/diagnose-w0-first-read.ts', [], 'REQUIRE_EXECUTE_ONE_GET'],
  ['scripts/verify-worker-container.mjs', [], 'Explicit official Node digest required'],
  ['scripts/validate-temporal-frame.mjs', ['extra', 'argument'], 'USAGE: node scripts/validate-temporal-frame.mjs'],
  ['deploy/workspace-worker/prepare-image.mjs', [], 'Expected check-base or stage-codex'],
];
let root: string, directoryAlias: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "entrypoint space '#%-"));
  directoryAlias = join(root, 'scripts alias');
  await symlink(join(project, 'scripts'), directoryAlias, 'dir');
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
function run(args: string[], cwd = project) {
  return exec(process.execPath, args, { cwd, timeout: 30_000, maxBuffer: 300_000,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: 'C.UTF-8', QE_ENABLE_MODEL: 'false' } });
}
const launch = (path: string, args: string[] = []) => run([...(path.endsWith('.ts') ? ['--import', tsx] : []), path, ...args]);

it.each(cases)('%s checks invalid arguments on direct and file-symlink launch', async (file, args, error) => {
  const target = join(project, file), alias = join(root, basename(file));
  await symlink(target, alias);
  for (const path of [target, alias]) {
    await expect(launch(path, args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(error) });
  }
}, 60_000);

it('handles relative paths and a symlinked parent directory without creating a store', async () => {
  const target = join(project, cases[0][0]), alias = join(root, 'relative alias.ts');
  await symlink(target, alias);
  for (const path of [relative(project, target), relative(project, alias), join(directoryAlias, basename(target))]) {
    await expect(launch(path)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(cases[0][2]) });
  }
});

it.each(['missing-argv', 'other-executable', 'nonexistent-argv'])('keeps all guarded modules import-only with %s', async mode => {
  const modules = [...cases.map(([path]) => path), 'scripts/check-opensandbox-local-plan.mjs',
    'deploy/validate.mjs', 'src/workspace-worker-entrypoint.ts'];
  const code = `${mode === 'nonexistent-argv' ? `process.argv[1]=${JSON.stringify(join(root, 'missing.mjs'))};` : ''}
    for (const url of ${JSON.stringify(modules.map(path => pathToFileURL(join(project, path)).href))}) await import(url);
    process.stdout.write('import-only');`;
  let args = ['--import', tsx, '--input-type=module', '--eval', code];
  if (mode === 'other-executable') {
    const harness = join(root, 'importer.mjs'); await writeFile(harness, code);
    args = ['--import', tsx, harness];
  }
  expect(await run(args)).toMatchObject({ stdout: 'import-only', stderr: '' });
});

it('keeps prepare-image runnable when copied alone before source/dependency installation', async () => {
  const copy = join(root, 'standalone-image.mjs');
  await copyFile(join(project, 'deploy/workspace-worker/prepare-image.mjs'), copy);
  await expect(launch(copy)).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('Expected check-base or stage-codex') });
});

it('prepares and reopens the actual frozen W0 inputs through a symlink, then refuses reuse', async () => {
  const alias = join(root, 'prepare integration.ts');
  await symlink(join(project, 'scripts/prepare-w0-mining.ts'), alias);
  const db = join(root, 'db'), output = join(root, 'prepared');
  const args = ['--db', db, '--out', output];
  const result = JSON.parse((await launch(alias, args)).stdout);
  expect(result).toMatchObject({ reopenedAndVerified: true, idempotenceVerified: true,
    upstreamRequestsThisStep: 0, modelExecution: 'not_run', humanLabels: 0, candidates: 0, evaluationReady: false });
  expect(result.items).toHaveLength(3);
  expect(await readdir(output)).toHaveLength(10);
  const ledger = await readFile(join(output, 'ledger.json'));
  await expect(launch(alias, args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EEXIST') });
  expect(await readFile(join(output, 'ledger.json'))).toEqual(ledger);
}, 60_000);
