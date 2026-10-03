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
