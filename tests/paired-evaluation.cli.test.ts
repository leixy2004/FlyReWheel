import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readEvaluationJson, writeEvaluationJson } from '../src/paired-evaluation.js';
import { PAIRED_EVALUATION_LIMITS } from '../src/core/paired-evaluation.js';

const exec = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const run = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, timeout: 30_000, maxBuffer: 6_000_000 });
it('replays frozen synthetic manifests in a separate CLI process and never replaces an artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paired-evaluation-cli-')), directory = join(root, 'demo');
  try {
    const demo = JSON.parse((await run(['evaluation', 'demo', '--directory', directory])).stdout);
    expect(demo.mode).toBe('authored-synthetic-no-model-no-human-annotation');
    const original = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    const args = ['evaluation', 'score', '--dataset', join(directory, 'dataset.json'), '--annotations', join(directory, 'annotations.json'), '--runs', join(directory, 'runs.json')];
    const out = join(root, 'replayed.json');
    const replay = JSON.parse((await run([...args, '--out', out])).stdout);
    expect(replay.reportId).toBe(demo.reportId); expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(original);
    await expect(run([...args, '--out', out])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EEXIST') });
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(original);
    await expect(run([...args, '--out', join(root, 'never.json'), '--enable-model'])).rejects.toMatchObject({ code: 1 });
    await expect(run(['evaluation', 'demo', '--directory', directory])).rejects.toMatchObject({ code: 1 });
    const annotations = JSON.parse(await readFile(join(directory, 'annotations.json'), 'utf8')); annotations.datasetDigest = 'f'.repeat(64);
    await writeFile(join(root, 'bad.json'), JSON.stringify(annotations));
    await expect(run(['evaluation', 'score', '--dataset', join(directory, 'dataset.json'), '--annotations', join(root, 'bad.json'), '--runs', join(directory, 'runs.json'), '--out', join(root, 'never.json')]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Dataset digest mismatch') });
    await expect(readFile(join(root, 'never.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it('rejects nonregular files, invalid UTF-8, oversized input and oversized formatted output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paired-evaluation-io-'));
  try {
    const input = join(root, 'input.json');
    await writeFile(input, Buffer.from([123, 34, 255, 34, 58, 49, 125]));
    await expect(readEvaluationJson(input, 100)).rejects.toThrow();
    await writeFile(input, ' '.repeat(101)); await expect(readEvaluationJson(input, 100)).rejects.toThrow('exceeds');
    await expect(readEvaluationJson(root, 100)).rejects.toThrow('regular file');
    if (process.platform !== 'win32') {
      const fifo = join(root, 'fifo'); await exec('mkfifo', [fifo]);
      await expect(readEvaluationJson(fifo, 100)).rejects.toThrow('regular file');
    }
    await expect(writeEvaluationJson(join(root, 'large.json'), { x: 'x'.repeat(PAIRED_EVALUATION_LIMITS.reportBytes) })).rejects.toThrow('exceeds');
    await expect(readFile(join(root, 'large.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);
