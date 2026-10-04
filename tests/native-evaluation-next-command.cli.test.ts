import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('keeps literal path characters when the printed next command is pasted into a POSIX shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-next-command-'));
  const directory = join(root, "authored $UNSET_PATH 'quoted' `literal`");
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: 'C.UTF-8', QE_ENABLE_MODEL: 'false' };
  try {
    const initialized = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'evaluation', 'native',
      'init-authored', '--directory', directory], { env, timeout: 30_000, maxBuffer: 200_000 });
    const { nextCommand } = JSON.parse(initialized.stdout);
    // Capture the shell's argv without dispatching a study or evaluating any model.
    const bin = join(root, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'npm'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o700 });
    const pasted = await exec('/bin/sh', ['-c', nextCommand], {
      env: { ...env, PATH: `${bin}:${env.PATH}` }, timeout: 10_000, maxBuffer: 200_000,
    });
    expect(JSON.parse(pasted.stdout)).toEqual(['run', 'cli', '--', 'evaluation', 'native', 'run',
      '--manifest', join(directory, 'manifest.json'), '--checkpoint', join(directory, 'checkpoint')]);
    expect(pasted.stderr).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45_000);
