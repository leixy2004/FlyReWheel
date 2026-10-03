import { expect, it } from 'vitest';
import { fetchArgs } from '../scripts/materialize-w0-context.js';

it('uses one exact commit with no tags, default branch, redirects, credentials or recursive reads', () => {
  const sha = 'a'.repeat(40), args = fetchArgs(sha);
  expect(args.slice(-2)).toEqual(['https://github.com/encode/httpx.git', sha]);
  for (const flag of ['--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', 'http.sslVerify=true', 'http.followRedirects=false']) expect(args).toContain(flag);
  expect(args).not.toContain('--depth');
  expect(() => fetchArgs('main')).toThrow();
  expect(() => fetchArgs(sha, 'https://other.example/repo.git')).toThrow();
  expect(() => fetchArgs(sha, 'https://github.com/encode/httpx.git/redirect')).toThrow();
  expect(fetchArgs(sha, '/workspace/FlyReWheel').slice(-2)).toEqual(['/workspace/FlyReWheel', sha]);
});

it('rederives each saved full-context template against its original request and exact after export', async () => {
  const { readFile } = await import('node:fs/promises');
  const { buildPrMiningModelInput } = await import('../src/adapters/pr-mining-model.js');
  const { validateGithubPrEvidence } = await import('../src/github-pr-evidence.js');
  const load = async (path: string) => JSON.parse(await readFile(new URL(`../experiments/temporal-pilot/w0-first-three/${path}`, import.meta.url), 'utf8'));
  for (const n of [3035, 3031, 3036]) {
    const pkg = await load(`proxy-attempt-1/package-${n}.json`);
    const evidence = validateGithubPrEvidence(pkg.evidence.evidence);
    const request = await load(`mining-preparation/request-${n}.json`);
    const after = await load(`full-context/context-${n}-after.json`);
    const before = await load(`full-context/context-${n}-before.json`);
    expect(before.binding.checkoutSha).toBe(evidence.evidence.snapshot.mergeBase);
    expect(after.binding.checkoutSha).toBe(evidence.evidence.snapshot.head);
    expect(after.binding.allowedHeads).toEqual([evidence.evidence.snapshot.head]);
    expect(after.binding.repositoryId).toBe(evidence.evidence.snapshot.repository.id);
    expect(after.executable).toBe(false);
    expect(after.derivedCleanup).toBe('removed');
    const prepared = buildPrMiningModelInput({ request, evidence, candidateId: `w0-unexecuted-${n}`,
      candidateCreatedAt: request.request.input.createdAt, context: { kind: 'full-repository', repository: evidence.evidence.snapshot.repository.id,
        checkout: 'after', workspace: after.generationTemplate.context.workspace, evaluation: after.binding } }, { model: 'test-unconfigured' });
    const { model: _model, ...template } = prepared.generation;
    expect(template).toEqual(after.generationTemplate);
    expect(template.context.kind).toBe('full-repository');
    expect(after.observation.historicalPublicAvailability).toBe('unproven');
  }
});
