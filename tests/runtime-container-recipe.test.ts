import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The verifier exports pure guards without opening Docker/network on import.
// @ts-expect-error standalone operational .mjs has no declaration file
import { budgetBytes, GiB, parseArgs, requireSpace, measurePublicCache, ownedContainerIds } from '../scripts/verify-worker-container.mjs';

describe('bounded container verification admission', () => {
  it('refuses malformed/unpinned inputs and ambiguous options before execution', () => {
    for (const args of [[], ['--base', 'node:22'], ['--base', `node@sha256:${'a'.repeat(64)}`, '--cache', '/tmp/public', '--cache-bytes', '-1'],
      ['--base', `node@sha256:${'a'.repeat(64)}`, '--cache', '/tmp/public', '--cache-bytes', '100', '--base', 'node:22'], ['--unknown', 'yes']]) {
      expect(() => parseArgs(args)).toThrow();
    }
    expect(parseArgs(['--base', `node@sha256:${'a'.repeat(64)}`, '--cache', '/tmp/public', '--cache-bytes', '1024']).cacheBytes).toBe(1024);
  });
  it('retains the full reserve in addition to peak estimate, including equality boundary', () => {
    const estimate = budgetBytes(GiB, 256 * 1024 ** 2);
    expect(() => requireSpace(estimate + 5 * GiB - 1, estimate)).toThrow();
    expect(() => requireSpace(estimate + 5 * GiB, estimate)).not.toThrow();
    for (const value of [NaN, Infinity, -1, 5 * GiB - 1]) expect(() => requireSpace(value)).toThrow();
    for (const value of [NaN, -1, 1.5]) expect(() => budgetBytes(value, 0)).toThrow();
  });
  it('rejects ambient files and links in real cache directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worker-cache-negative-'));
    try {
      await mkdir(join(directory, '_cacache'));
      await writeFile(join(directory, '_cacache', 'public-package'), 'abc');
      expect(await measurePublicCache(directory)).toBe(3);
      await writeFile(join(directory, '.npmrc'), 'authored-non-secret-fixture');
      await expect(measurePublicCache(directory)).rejects.toThrow('only public _cacache');
      await rm(join(directory, '.npmrc'));
      await symlink('/nonexistent', join(directory, '_cacache', 'linked'));
      await expect(measurePublicCache(directory)).rejects.toThrow('links/special');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('reconciles lost create acknowledgements by exact name without selecting another container', () => {
    const rows = [
      { Names: 'task-smoke', ID: 'a'.repeat(12) },
      { Names: 'task-smoke-extra', ID: 'b'.repeat(12) },
      { Names: 'other-task', ID: 'c'.repeat(12) },
      { Names: 'task-smoke', ID: '--all' },
    ].map(row => JSON.stringify(row)).join('\n');
    expect(ownedContainerIds(rows, 'task-smoke')).toEqual(['a'.repeat(12)]);
    expect(ownedContainerIds('', 'task-smoke')).toEqual([]);
  });
  it('keeps cache transient, install offline and one native vendor tree', async () => {
    const recipe = await readFile(new URL('../deploy/workspace-worker/Dockerfile.bounded', import.meta.url), 'utf8');
    expect(recipe.match(/^FROM /gm)).toHaveLength(1);
    expect(recipe.match(/^RUN /gm)).toHaveLength(1);
    expect(recipe).toContain('--mount=type=bind,from=npmcache,target=/npm-cache,rw');
    for (const command of ['ci', 'prune']) expect(recipe).toMatch(new RegExp(`npm ${command} --offline --cache /npm-cache[^\\n]*--ignore-scripts`));
    expect(recipe).toContain('rm -rf node_modules/@openai/codex-linux-*/vendor');
    expect(recipe).toContain('prepare-image.mjs stage-codex');
    expect(recipe).not.toMatch(/COPY.*(?:node_modules|npm-cache)|apt-get|curl|wget/);
    expect(recipe).toContain('USER 10001:10001');
    const rules = await readFile(new URL('../deploy/workspace-worker/Dockerfile.bounded.dockerignore', import.meta.url), 'utf8');
    for (const excluded of ['**/.env*', '**/.npmrc', '**/auth.json', '**/.codex', '**/.aws', '**/node_modules', '**/.git']) expect(rules.split('\n')).toContain(excluded);
  });
});
