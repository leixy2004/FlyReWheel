import { expect, it } from 'vitest';
import { classifyGithubReadFailure, GithubReadError } from '../src/github-pr-diagnostics.js';
import { captureGithubPrEvidence } from '../src/github-pr.js';

it.each([
  [401, undefined, 'http-authentication'], [403, undefined, 'http-forbidden'],
  [403, 0, 'http-rate-limit'], [429, undefined, 'http-rate-limit'], [503, undefined, 'http-api'],
])('classifies only actual HTTP response status %s', (status, remaining, category) => {
  const error = { response: { status, headers: remaining === undefined ? {} : { 'x-ratelimit-remaining': String(remaining) } } };
  Object.defineProperty(error, 'cause', { get() { throw new Error('must not inspect HTTP error cause'); } });
  expect(classifyGithubReadFailure(error)).toEqual({ category });
});

it.each([
  ['CERT_HAS_EXPIRED', 'tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
  ['ENOTFOUND', 'network-dns'], ['ECONNREFUSED', 'network-connection'],
  ['UND_ERR_CONNECT_TIMEOUT', 'network-timeout'],
])('retains only safe transport code %s', (code, category) => {
  const error = { status: 500, cause: { cause: { code, message: 'Bearer SECRET' } } };
  expect(classifyGithubReadFailure(error)).toEqual({ category, code });
  expect(JSON.stringify(classifyGithubReadFailure(error))).not.toContain('SECRET');
});

it('ignores SDK status, secret code strings and accessor causes', () => {
  const error = { status: 500, code: 'Bearer private-token' };
  Object.defineProperties(error, {
    cause: { get() { throw new Error('cause getter'); } },
    message: { get() { throw new Error('message getter'); } },
    request: { get() { throw new Error('request getter'); } },
  });
  expect(classifyGithubReadFailure(error)).toEqual({ category: 'transport-unknown' });
  expect(classifyGithubReadFailure({ code: '__proto__' })).toEqual({ category: 'transport-unknown' });
  const circular: any = {}; circular.cause = circular;
  expect(classifyGithubReadFailure(circular)).toEqual({ category: 'transport-unknown' });
});

it('preserves a safe nested TLS cause through Octokit without retaining raw error or retrying', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    throw new TypeError('SECRET transport message', { cause: Object.assign(new Error('SECRET certificate'), { code: 'CERT_HAS_EXPIRED' }) });
  };
  const result = await captureGithubPrEvidence({ repository: 'fixture/project', number: 7 }, { fetch }).catch(error => error);
  expect(result).toBeInstanceOf(GithubReadError);
  expect(result.diagnostic).toBeUndefined();
  expect(result.classification).toEqual({ category: 'tls', code: 'CERT_HAS_EXPIRED' });
  expect(result.cause).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(calls).toBe(1);
});
