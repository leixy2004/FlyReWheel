import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { workspaceEnvironment } from '../src/workspace/process.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 6_000_000 });
it('captures, exports, imports and reopens in separate CLI processes with honest verification receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-cli-'));
  const repo = join(directory, 'repo'), db = join(directory, 'db'), otherDb = join(directory, 'import-db'), file = join(directory, 'snapshot.json');
  await mkdir(repo);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo, env: { ...workspaceEnvironment(),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })).stdout.trim();
  try {
    await git('init', '-qb', 'main'); await writeFile(join(repo, 'sample.ts'), 'before\r\n');
    await git('add', '.'); await git('commit', '-qm', 'before'); const base = await git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'sample.ts'), 'after\r\n'); await git('commit', '-qam', 'after'); const head = await git('rev-parse', 'HEAD');
    const capture = ['snapshots', 'capture', '--repo', repo, '--repository-id', 'fixture/cli', '--base-tip', base, '--head', head, '--db', db];
    expect((await run([...capture, '--out', file])).stdout).toBe('');
    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.receipt.kind).toBe('local-git-check');
    expect(JSON.parse((await run(capture)).stdout).digest).toBe(record.digest);
    const shown = JSON.parse((await run(['snapshots', 'show', '--digest', record.digest, '--db', db])).stdout);
    expect(shown.snapshot).toEqual(record.snapshot); expect(shown.receipt).toEqual({ kind: 'package-integrity-only' });
    await rm(repo, { recursive: true, force: true });
    const imported = JSON.parse((await run(['snapshots', 'import', '--file', file, '--db', otherDb])).stdout);
    expect(imported).toEqual(shown);
    expect(JSON.parse((await run(['snapshots', 'import', '--file', file, '--db', otherDb])).stdout)).toEqual(imported);
    const listed = JSON.parse((await run(['snapshots', 'list', '--repository-id', 'fixture/cli', '--limit', '1', '--db', otherDb])).stdout);
    expect(listed.snapshots).toHaveLength(1); expect(listed.nextAfter).toBe(record.digest);
    expect(listed.snapshots[0]).not.toHaveProperty('changes');
    expect(JSON.parse((await run(['snapshots', 'list', '--after', record.digest, '--db', otherDb])).stdout).snapshots).toEqual([]);
    await expect(run(['snapshots', 'import', '--file', file])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--db') });
    await expect(run(['snapshots', 'list', '--limit', '101', '--db', otherDb])).rejects.toMatchObject({ code: 1 });
    await expect(run(['snapshots', 'show', '--digest', 'f'.repeat(64), '--db', otherDb])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown change snapshot') });
    record.snapshot.baseTip = '1'.repeat(40); await writeFile(file, JSON.stringify(record));
    await expect(run(['snapshots', 'import', '--file', file, '--db', otherDb])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('digest mismatch') });
    await writeFile(file, ' '.repeat(5_000_001));
    await expect(run(['snapshots', 'import', '--file', file, '--db', otherDb])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('exceeds 5MB') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
