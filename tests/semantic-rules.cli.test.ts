import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ruleVersionDigest, type SemanticRuleVersion } from '../src/core/index.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const examplePath = join(root, 'examples/semantic-rule-v2.json');
const casesPath = join(root, 'examples/semantic-rule-cases.json');
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 4_000_000 });

it('imports, shows and lists a semantic-only version through separate local CLI processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-cli-'));
  const db = join(directory, 'db');
  try {
    const rule = JSON.parse(await readFile(examplePath, 'utf8')) as SemanticRuleVersion;
    const imported = JSON.parse((await run(['rules', 'import', '--rule', examplePath, '--cases', casesPath, '--db', db])).stdout);
    expect(imported).toEqual({ digest: ruleVersionDigest(rule), rule });
    const shown = JSON.parse((await run(['rules', 'show', '--digest', imported.digest, '--db', db])).stdout);
    expect(shown).toEqual(imported);
    const out = join(directory, 'list.json');
    const listed = await run(['rules', 'list', '--rule-id', rule.ruleId, '--db', db, '--out', out]);
    expect(listed.stdout).toBe('');
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual([imported]);
    const same = JSON.parse((await run(['rules', 'import', '--rule', examplePath, '--db', db])).stdout);
    expect(same).toEqual(imported);
    await expect(run(['scan', '--bundle', examplePath, '--file', examplePath])).rejects.toMatchObject({ code: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('requires durable storage and rejects oversized, unsupported or unknown rule inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-cli-errors-'));
  const db = join(directory, 'db');
  try {
    await expect(run(['rules', 'import', '--rule', examplePath])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--db') });
    const huge = join(directory, 'huge.json');
    await writeFile(huge, ' '.repeat(2_000_001));
    await expect(run(['rules', 'import', '--rule', huge, '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Input exceeds 2MB') });
    const unsupported = join(directory, 'unsupported.json');
    const rule = JSON.parse(await readFile(examplePath, 'utf8'));
    await writeFile(unsupported, JSON.stringify({ ...rule, schemaVersion: 99 }));
    await expect(run(['rules', 'import', '--rule', unsupported, '--db', db])).rejects.toMatchObject({ code: 1 });
    await expect(run(['rules', 'show', '--digest', 'f'.repeat(64), '--db', db])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown rule version') });
    expect(JSON.parse((await run(['rules', 'list', '--db', db])).stdout)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
