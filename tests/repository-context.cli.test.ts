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
it('captures, binds, verifies, cites, imports and reopens across CLI processes, always downgrading imported receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-cli-'));
  const repo = join(directory, 'repo'), db = join(directory, 'db'), otherDb = join(directory, 'other'), file = join(directory, 'context.json'); await mkdir(repo);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo, env: { ...workspaceEnvironment(),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })).stdout.trim();
  try {
    await git('init', '-qb', 'main'); await writeFile(join(repo, 'change.ts'), 'before\n'); await writeFile(join(repo, 'contract.ts'), 'contract\n'); await writeFile(join(repo, 'test.ts'), 'test\n');
    await git('add', '.'); await git('commit', '-qm', 'base'); const baseTip = await git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'change.ts'), 'after\n'); await git('commit', '-qam', 'head'); const head = await git('rev-parse', 'HEAD');
    const snapshot = JSON.parse((await run(['snapshots', 'capture', '--repo', repo, '--repository-id', 'fixture/cli', '--base-tip', baseTip, '--head', head, '--db', db])).stdout);
    const capture = ['contexts', 'capture', '--repo', repo, '--repository-id', 'fixture/cli', '--head', head,
      '--path', 'contract.ts', '--path', 'test.ts', '--snapshot-digest', snapshot.digest, '--db', db];
    expect((await run([...capture, '--out', file])).stdout).toBe(''); const value = JSON.parse(await readFile(file, 'utf8'));
    expect(value.context.coverage.capturedPaths).toBe(2); expect(value.receipt.kind).toBe('local-git-check');
    const shown = JSON.parse((await run(['contexts', 'show', '--digest', value.digest, '--db', db])).stdout);
    expect(shown.context).toEqual(value.context); expect(shown.receipt).toEqual({ kind: 'package-integrity-only' });
    expect(JSON.parse((await run(capture)).stdout).digest).toBe(value.digest);
    const verified = JSON.parse((await run(['contexts', 'verify', '--digest', value.digest, '--repo', repo, '--db', db])).stdout);
    expect(verified.digest).toBe(value.digest); expect(verified.receipt.kind).toBe('local-git-check');
    const cite = ['contexts', 'cite', '--digest', value.digest, '--path', 'contract.ts', '--kind', 'callee-contract', '--start', '0', '--end', '8', '--db', db];
    const citation = JSON.parse((await run([...cite, '--snapshot-digest', snapshot.digest])).stdout);
    expect(citation.evidence.content).toBe('contract'); expect(citation.evidence.anchor.kind).toBe('repository-context');
    expect(citation.binding.snapshotDigest).toBe(snapshot.digest); expect(citation.semanticReviewAcceptance).toBe('semantic-snapshot-review-v3');
    await expect(run([...capture, '--head', baseTip])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('exact snapshot repository and review head') });
    await expect(run([...capture, '--max-paths', '1'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('no truncated context') });
    const inventory = JSON.parse((await run(['contexts', 'list', '--db', db, '--head', head, '--limit', '1'])).stdout);
    expect(inventory.contexts).toHaveLength(1); expect(inventory.contexts[0]).not.toHaveProperty('entries'); expect(inventory.nextAfter).toBe(value.digest);
    expect(JSON.parse((await run(['contexts', 'list', '--db', db, '--after', value.digest])).stdout).contexts).toEqual([]);
    await rm(repo, { recursive: true, force: true });
    const imported = JSON.parse((await run(['contexts', 'import', '--file', file, '--db', otherDb])).stdout);
    expect(imported).toEqual(shown);
    expect(JSON.parse((await run(['contexts', 'import', '--file', file, '--db', otherDb])).stdout)).toEqual(shown);
    expect(JSON.parse((await run([...cite, '--db', otherDb])).stdout).evidence).toEqual(citation.evidence);
    await expect(run(['contexts', 'verify', '--digest', value.digest, '--repo', repo, '--db', otherDb])).rejects.toMatchObject({ code: 1 });
    await expect(run(['contexts', 'capture', '--repo', repo, '--repository-id', 'fixture/cli', '--head', head, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--path') });
    await expect(run(['contexts', 'show', '--digest', 'f'.repeat(64), '--db', otherDb])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown repository context') });
    await expect(run(['contexts', 'list', '--limit', '101', '--db', db])).rejects.toMatchObject({ code: 1 });
    await expect(run([...cite, '--end', '100'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('bounds') });
    value.context.head = baseTip; await writeFile(file, JSON.stringify(value));
    await expect(run(['contexts', 'import', '--file', file, '--db', otherDb])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('digest mismatch') });
    await writeFile(file, ' '.repeat(5_000_001));
    await expect(run(['contexts', 'import', '--file', file, '--db', otherDb])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('exceeds 5MB') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);
