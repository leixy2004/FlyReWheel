import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { isMainModule } from '../scripts/lib/is-main.mjs';

const exec = promisify(execFile);
let root: string, target: string, alias: string, other: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'main-identity-'));
  target = join(root, "main '#% ü.mjs"); alias = join(root, 'alias.mjs'); other = join(root, 'other.mjs');
  const helper = new URL('../scripts/lib/is-main.mjs', import.meta.url).href;
  await writeFile(target, `import {isMainModule} from ${JSON.stringify(helper)};
    if (await isMainModule(import.meta.url)) process.stdout.write('main-once');`);
  await writeFile(other, ''); await symlink(target, alias);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it('uses native real paths and decoded file URLs, including both alias directions', async () => {
  expect(await isMainModule(pathToFileURL(target), alias)).toBe(true);
  expect(await isMainModule(pathToFileURL(alias).href, target)).toBe(true);
  expect(await isMainModule(pathToFileURL(target).href, target)).toBe(true);
});

it('does not infer main from cwd or an unavailable/different executable', async () => {
  const url = pathToFileURL(target);
  expect(await isMainModule(url, '')).toBe(false);
  expect(await isMainModule(url, join(root, 'missing'))).toBe(false);
  expect(await isMainModule(url, other)).toBe(false);
});

it.each([{ options: [] }, { options: ['--preserve-symlinks-main'] }])('handles loaded module aliases with Node options %j', async ({ options }) => {
  const result = await exec(process.execPath, [...options, alias], {
    cwd: root, env: {}, timeout: 10_000, maxBuffer: 10_000,
  });
  expect(result).toMatchObject({ stdout: 'main-once', stderr: '' });
});
