import { expect, it } from 'vitest';
import { diagnoseW0FirstRead, safeErrorChain } from '../scripts/diagnose-w0-first-read.js';

it('issues exactly one fixed anonymous GET and retains only successful identity', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (url, options) => {
    calls++;
    expect(String(url)).toBe('https://api.github.com/repos/encode/httpx/pulls/3035');
    expect(options?.method).toBe('GET'); expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).has('authorization')).toBe(false);
    return new Response(JSON.stringify({ number: 3035, merged: true, merged_at: '2024-01-03T05:11:45Z',
      merge_commit_sha: 'b871b4b8b29aca2e675645fae0c9f8e7d2a5e7d5',
      base: { repo: { full_name: 'encode/httpx', private: false }, sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) },
      title: 'DO NOT RETAIN', body: 'DO NOT RETAIN' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await diagnoseW0FirstRead({ fetch });
  expect(result).toMatchObject({ status: 'success', httpStatus: 200, requests: 1, totalRequestsUsed: 2, realSourcePackages: 0 });
  expect(calls).toBe(1); expect(JSON.stringify(result)).not.toContain('DO NOT RETAIN');
});

it.each([401, 403, 429, 503])('stops on HTTP %s and never serializes sensitive fields', async status => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ message: 'SECRET' }),
    { status, headers: { authorization: 'SECRET', 'set-cookie': 'SECRET', 'x-github-request-id': 'ABCD:1234:5678:9ABC' } }); };
  const result = await diagnoseW0FirstRead({ fetch });
  expect(result).toMatchObject({ status: 'failed', httpStatus: status, requests: 1, totalRequestsUsed: 2 });
  expect(calls).toBe(1); expect(JSON.stringify(result)).not.toContain('SECRET');
});

it.each([['CERT_HAS_EXPIRED', 'tls'], ['ENOTFOUND', 'network-dns'], ['ECONNREFUSED', 'network-connection']])('retains safe code %s through Octokit', async (code, category) => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++;
    throw new TypeError('SECRET URL', { cause: Object.assign(new Error('SECRET credentials'), { code }) }); };
  const result = await diagnoseW0FirstRead({ fetch });
  expect(result).toMatchObject({ status: 'failed', httpStatus: null, classification: { category, code }, requests: 1 });
  expect(calls).toBe(1); expect(JSON.stringify(result)).not.toContain('SECRET');
});

it.each([undefined, 'UNKNOWN', 'UNRECOGNIZED_SECRET_CODE'])('keeps unrecognized transport code %s unknown without inventing HTTP, TLS or proxy attribution', async code => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    // Synthetic SDK-like status is not an observed HTTP response. No real proxy is contacted.
    const cause = Object.assign(new Error('SECRET proxy or TLS guess'), { code, status: 500,
      request: { headers: { authorization: 'SECRET credential' } } });
    throw new TypeError('SECRET URL', { cause });
  };
  const result = await diagnoseW0FirstRead({ fetch });
  expect(result).toMatchObject({ status: 'failed', httpStatus: null,
    classification: { category: 'transport-unknown' }, requests: 1, totalRequestsUsed: 2 });
  if (!('errorChain' in result)) throw new Error('Expected failed diagnostic');
  expect(result.classification).toEqual({ category: 'transport-unknown' });
  expect(result.errorChain.every(entry => entry.code === undefined)).toBe(true);
  expect(calls).toBe(1);
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

it('does not invoke code/cause getters or retain unrecognized names and codes', () => {
  const error = { name: 'SECRET', code: 'SECRET' };
  Object.defineProperty(error, 'cause', { get() { throw new Error('no getter access'); } });
  expect(safeErrorChain(error)).toEqual([{}]);
});

it('counts a proxy diagnostic after the two preserved requests without spending a second GET', async () => {
  let calls = 0;
  const result = await diagnoseW0FirstRead({ priorRequests: 2, fetch: async () => {
    calls++; return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  } });
  expect(result).toMatchObject({ originalRunRequests: 2, requests: 1, totalRequestsUsed: 3, httpStatus: 503 });
  expect(calls).toBe(1);
});
