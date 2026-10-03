import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
const exec = promisify(execFile), project = fileURLToPath(new URL('..', import.meta.url));
const cli = (...args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'evaluation', 'checkout', ...args], { cwd: project, timeout: 30_000 });
test('separate source CLI processes export, inspect and rerun the same explicit visibility manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evaluation-checkout-cli-'));
  try {
    const source = join(root, 'source'), store = join(root, 'store'), manifest = join(root, 'visibility.json'); await mkdir(source);
    const git = (...args: string[]) => exec('/usr/bin/git', args, { cwd: source, env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    await git('init', '--quiet', '--template='); await writeFile(join(source, 'file.txt'), 'development fixture\n'); await git('add', '.');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'development fixture');
    const sha = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, repositoryId: 'fixture/cli', classification: 'development-fixture', allowedHeads: [sha], checkoutSha: sha,
      visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: null, evidenceDigests: [] } }));
    const a = JSON.parse((await cli('export', '--repo', source, '--store', store, '--manifest', manifest)).stdout);
    expect(JSON.parse((await cli('inspect', '--store', store, '--manifest', manifest)).stdout)).toEqual(a);
    expect(JSON.parse((await cli('export', '--repo', source, '--store', store, '--manifest', manifest)).stdout)).toEqual(a);
    expect(await readFile(join(a.repoPath, 'file.txt'), 'utf8')).toBe('development fixture\n');
    await expect(cli('export', '--repo', source, '--store', store, '--manifest', manifest, '--before', '2001-01-01')).rejects.toMatchObject({ code: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
