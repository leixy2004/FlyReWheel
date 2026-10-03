import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { historyPlan } from './helpers/github-history-fixture.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 2_000_000,
  env: { ...process.env, QE_ENABLE_MODEL: 'true', QE_CODEX_AUTH_MODE: 'not-configured', QE_CODEX_MODEL: 'must-not-run', GITHUB_TOKEN: 'must-not-use' } });
it('imports, shows and lists a durable local plan across CLI processes with no ambient model/auth activation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-cli-'));
  try {
    const plan = historyPlan([]), file = join(directory, 'plan.json'), db = join(directory, 'db'), out = join(directory, 'out.json');
    await writeFile(file, JSON.stringify(plan));
    expect((await run(['github-pr', 'history', 'import', '--file', file, '--db', db, '--out', out])).stdout).toBe('');
    const imported = JSON.parse(await readFile(out, 'utf8')); expect(imported.items).toEqual([]);
    expect(JSON.parse((await run(['github-pr', 'history', 'show', '--batch', plan.digest, '--db', db])).stdout)).toEqual(imported);
    const list = JSON.parse((await run(['github-pr', 'history', 'list', '--db', db, '--repository', 'fixture/project'])).stdout);
    expect(list.batches[0]).toMatchObject({ digest: plan.digest, counts: { pending: 0, captured: 0 } });
    const capture = JSON.parse((await run(['github-pr', 'history', 'capture', '--batch', plan.digest, '--db', db])).stdout);
    expect(capture.run).toMatchObject({ requests: 0, attempted: 0, freshCaptures: [] }); expect(capture.batch.receipt.kind).toBe('package-integrity-only');
    const help = (await run(['github-pr', 'history', 'capture', '--help'])).stdout;
    expect(help).toContain('--recover-interrupted'); expect(help).toContain('--max-requests-per-pull');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
it('rejects missing explicit filters, invalid limits, oversized plans and imported progress before database creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-cli-invalid-'));
  try {
    const plan = historyPlan(), file = join(directory, 'plan.json'), db = join(directory, 'never-created');
    await expect(run(['github-pr', 'history', 'preview', '--repository', 'fixture/project'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--created-from') });
    await expect(run(['github-pr', 'history', 'capture', '--batch', plan.digest, '--db', db, '--max-requests', '201'])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, JSON.stringify({ ...plan, items: [] }));
    await expect(run(['github-pr', 'history', 'import', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, ' '.repeat(500_001));
    await expect(run(['github-pr', 'history', 'import', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('500KB') });
    await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
