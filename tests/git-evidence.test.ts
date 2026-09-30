import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { extractBugFixPair } from '../src/git-evidence.js';
const exec = promisify(execFile);
test('reads actual immutable Git before/after blobs without checkout or repository execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qe-git-'));
  const git = (...args: string[]) => exec('git', args, { cwd: directory, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  try {
    await git('init', '-q');
    await writeFile(join(directory, 'sample.ts'), 'waitUntilReady(job);\n');
    await git('add', 'sample.ts'); await git('commit', '-qm', 'synthetic before');
    const base = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(join(directory, 'sample.ts'), 'waitUntilReady(job, {timeoutMs: 1000});\n');
    await git('commit', '-qam', 'synthetic fix');
    const input = { repository: directory, base, head: 'HEAD', path: 'sample.ts', caseId: 'example', language: 'typescript', problem: 'Readiness must be bounded' };
    const pair = await extractBugFixPair(input);
    expect(pair.pairs[0]!.before).toBe('waitUntilReady(job);\n');
    expect(pair.pairs[0]!.after).toContain('timeoutMs');
    expect(pair.pairs[0]!.evidenceRefs).toHaveLength(2);
    await expect(extractBugFixPair({ ...input, path: '../secret' })).rejects.toThrow('repository-relative');
    await expect(extractBugFixPair({ ...input, head: base })).rejects.toThrow('different commits');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
