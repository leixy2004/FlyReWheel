import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('routes the actual CLI to evaluation registry authorization and leaves rejected output absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evaluation-registration-'));
  const registry = join(root, 'registry.json'), selection = join(root, 'selection.json'), output = join(root, 'report.json');
  try {
    await writeFile(registry, JSON.stringify({ schemaVersion: 1, purpose: 'offline-study', entries: [] }));
    const sha = 'a'.repeat(40);
    await writeFile(selection, JSON.stringify({ workspaceId: 'unregistered', jobDigest: 'b'.repeat(64),
      repository: 'authored/registration', kind: 'pr-mining', baseSha: sha, headSha: sha, expectedSha: sha,
      evaluationExportId: 'authored-export' }));
    await expect(exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'evaluation', 'workspace', 'resolve',
      '--registry', registry, '--selection', selection, '--out', output], {
      timeout: 30_000, maxBuffer: 200_000,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: 'C.UTF-8', QE_ENABLE_MODEL: 'false' },
    })).rejects.toMatchObject({ code: 1,
      stderr: expect.stringContaining('Prepared evaluation workspace selection is not authorized') });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);
