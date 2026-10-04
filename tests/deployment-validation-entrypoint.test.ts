import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, afterAll, expect, it } from 'vitest';

const exec = promisify(execFile);
const validator = fileURLToPath(new URL('../deploy/validate.mjs', import.meta.url));
let root: string, alias: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deployment-validation-entrypoint-'));
  alias = join(root, 'validator alias #.mjs');
  await symlink(validator, alias);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const run = (...args: string[]) => exec(process.execPath, args, { timeout: 10_000, maxBuffer: 200_000,
  env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: 'C.UTF-8' } });

it.each(['direct', 'file-symlink'] as const)('executes checks and rejects invalid input on %s launch', async mode => {
  const path = mode === 'direct' ? validator : alias;
  await expect(run(path, '--not-a-real-option')).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('Unknown argument') });
  await expect(run(path, '--rendered', 'base', join(root, 'missing.yaml'))).rejects.toMatchObject({ code: 1 });
  const result = await run(path);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('PASS: 30 YAML documents parsed');
  expect(result.stdout).toContain('NOT VERIFIED HERE: Kustomize rendering');
}, 30_000);

it('imports the validator without executing deployment checks', async () => {
  const result = await run('--input-type=module', '--eval',
    `await import(${JSON.stringify(pathToFileURL(validator).href)}); process.stdout.write('import-only');`);
  expect(result).toMatchObject({ stdout: 'import-only', stderr: '' });
});
