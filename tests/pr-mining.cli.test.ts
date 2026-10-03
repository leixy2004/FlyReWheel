import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { miningFixture } from './helpers/pr-mining-fixture.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
  cwd: root, timeout: 30_000, maxBuffer: 4_000_000,
  // Ambient configuration must not activate any model/auth adapter in this path.
  env: { ...process.env, QE_ENABLE_MODEL: 'true', QE_CODEX_AUTH_MODE: 'not-configured', QE_CODEX_MODEL: 'must-not-run' },
});
it('runs the frozen PR → unknown cases → fixture v2 candidate → snapshot review flow across CLI processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mining-cli-'));
  try {
    const fixture = miningFixture();
    for (const [name, value] of [['evidence', fixture.evidence], ['request', fixture.input], ['candidate', fixture.candidate]] as const) {
      expect(JSON.parse(await readFile(join(root, `examples/pr-mining-${name}.json`), 'utf8'))).toEqual(value);
    }
    const db = join(directory, 'db'), evidence = join(directory, 'evidence.json'), request = join(directory, 'request.json'), candidate = join(directory, 'candidate.json'), out = join(directory, 'out.json');
    await writeFile(evidence, JSON.stringify(fixture.evidence)); await writeFile(request, JSON.stringify(fixture.input)); await writeFile(candidate, JSON.stringify(fixture.candidate));
    await run(['github-pr', 'import', '--file', evidence, '--db', db, '--out', out]);
    expect((await run(['mining', 'request', '--file', request, '--db', db, '--out', out])).stdout).toBe('');
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(fixture.request);
    expect(JSON.parse((await run(['mining', 'show', '--digest', fixture.request.digest, '--db', db])).stdout)).toEqual(fixture.request);
    expect(JSON.parse((await run(['mining', 'list', '--evidence-digest', fixture.evidence.digest, '--db', db])).stdout)).toEqual([fixture.request]);
    const supplied = JSON.parse((await run(['mining', 'supply', '--file', candidate, '--db', db])).stdout);
    expect(supplied.candidate).toMatchObject({ requestDigest: fixture.request.digest, source: 'fixture', semanticValidation: 'not_run', certification: 'none' });
    expect(JSON.parse((await run(['mining', 'supply', '--file', candidate, '--db', db])).stdout)).toEqual(supplied);
    expect(JSON.parse((await run(['mining', 'candidate', '--digest', supplied.digest, '--db', db])).stdout)).toEqual(supplied);
    expect(JSON.parse((await run(['mining', 'candidates', '--request-digest', fixture.request.digest, '--db', db])).stdout)).toEqual([supplied]);
    expect(JSON.parse((await run(['rules', 'show', '--digest', supplied.candidate.ruleDigest, '--db', db])).stdout).rule).toEqual(fixture.candidate.rule);
    const review = JSON.parse((await run(['reviews', 'run', '--rule-digest', supplied.candidate.ruleDigest, '--snapshot-digest', fixture.evidence.evidence.snapshotDigest, '--db', db])).stdout);
    expect(review.findings).toEqual([]); expect(review.coverage.targets.length).toBeGreaterThan(0);
    expect(review.coverage.targets.every((target: { semantic: { state: string } }) => target.semantic.state === 'not_run')).toBe(true);
    const help = (await run(['mining', '--help'])).stdout;
    expect(help.replace(/\s+/g, ' ')).toContain('no live synthesis or labels'); expect(help).toContain('supply');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('requires persistent storage and rejects malformed, oversized and unsupported mining inputs before opening a database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mining-cli-errors-'));
  try {
    const fixture = miningFixture(), db = join(directory, 'never-created'), file = join(directory, 'input.json');
    await writeFile(file, JSON.stringify(fixture.input));
    await expect(run(['mining', 'request', '--file', file])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--db') });
    await writeFile(file, JSON.stringify({ ...fixture.input, label: 'TP' }));
    await expect(run(['mining', 'request', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, JSON.stringify({ ...fixture.candidate, source: 'model' }));
    await expect(run(['mining', 'supply', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await writeFile(file, ' '.repeat(2_000_001));
    await expect(run(['mining', 'supply', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('2MB') });
    await writeFile(file, Buffer.from([123, 34, 255, 34, 58, 49, 125]));
    await expect(run(['mining', 'request', '--file', file, '--db', db])).rejects.toMatchObject({ code: 1 });
    await expect(stat(db)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
