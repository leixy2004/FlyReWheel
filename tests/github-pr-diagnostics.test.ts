import { expect, it } from 'vitest';
import { githubHttpFailureDiagnostic, GithubHttpFailureDiagnosticSchema, GithubReadError } from '../src/github-pr-diagnostics.js';
import { captureGithubPrEvidence } from '../src/github-pr.js';
import { HistoryItemSchema, initialHistoryItems } from '../src/github-pr-history-state.js';
import { historyTransport } from './helpers/github-history-fixture.js';

const requestId = 'ABCD:1234:5678:9ABC:DEF0';
const failure = (headers: Record<string, unknown>, status = 403) => ({ status, response: { status, headers } });

it('selects only bounded response headers and never reads raw bodies, requests, messages or causes', () => {
  const headers = { 'x-github-request-id': requestId, 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790960400', 'retry-after': '60' };
  const error = failure(headers);
  const forbidden = { get() { throw new Error('Sensitive value must not be read'); } };
  Object.defineProperties(error, { request: forbidden, message: forbidden, cause: forbidden });
  Object.defineProperty(error.response, 'data', forbidden);
  Object.defineProperties(headers, { authorization: forbidden, 'set-cookie': forbidden, 'x-private-token': forbidden });
  const diagnostic = githubHttpFailureDiagnostic(error);
  expect(diagnostic).toEqual({ status: 403, requestId, rateLimitRemaining: 0, rateLimitReset: 1790960400, retryAfterSeconds: 60 });
  expect(GithubHttpFailureDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
  expect(new GithubReadError('GET /repos/fixture/project/pulls/7', diagnostic).cause).toBeUndefined();
});

it.each([undefined, null, {}, [], -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '9'.repeat(100_000), '1.0', '+1', '1e2', '-1', '01', '1\nsecret', 'Bearer private-token'])('omits malformed numeric metadata', value => {
  expect(githubHttpFailureDiagnostic(failure({ 'x-ratelimit-remaining': value, 'x-ratelimit-reset': value }))).toEqual({ status: 403 });
});

it.each(['token secret', 'ghp_never_save', 'github_pat_never_save', 'A:B:C:D\nAuthorization: secret', 'A:B:C:D'.padEnd(129, 'A'), '', 'https://example.com/private'])('omits nonconforming request IDs (%s)', value => {
  expect(githubHttpFailureDiagnostic(failure({ 'x-github-request-id': value }))).toEqual({ status: 403 });
});

it('accepts bounded integer metadata and canonical HTTP-date Retry-After without interpreting the cause', () => {
  const diagnostic = githubHttpFailureDiagnostic(failure({ 'x-ratelimit-remaining': Number.MAX_SAFE_INTEGER,
    'x-ratelimit-reset': String(Number.MAX_SAFE_INTEGER), 'retry-after': 'Fri, 02 Oct 2026 17:00:00 GMT' }, 429));
  expect(diagnostic).toEqual({ status: 429, rateLimitRemaining: Number.MAX_SAFE_INTEGER,
    rateLimitReset: Number.MAX_SAFE_INTEGER, retryAfterAt: '2026-10-02T17:00:00.000Z' });
  expect(GithubHttpFailureDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
  expect(JSON.stringify(diagnostic).length).toBeLessThan(512);
  expect(githubHttpFailureDiagnostic(failure({ 'retry-after': 0 }))).toEqual({ status: 403, retryAfterSeconds: 0 });
});

it.each(['Thu, 02 Oct 2026 17:00:00 GMT', 'Fri, 32 Oct 2026 17:00:00 GMT', '2026-10-02T17:00:00Z', 'tomorrow', '60\nsecret', '9'.repeat(1000)])('omits malformed Retry-After', value => {
  expect(githubHttpFailureDiagnostic(failure({ 'retry-after': value }))).toEqual({ status: 403 });
});

it.each([undefined, null, {}, { status: 500 }, { status: 403, request: { headers: { 'retry-after': '30' } } },
  { response: { status: '403', headers: {} } }, failure({}, 200), failure({}, 600), failure({}, NaN)])('requires an actual failure response, not just an SDK status (%j)', error => {
  expect(githubHttpFailureDiagnostic(error)).toBeUndefined();
});

it.each([403, 429])('sanitizes a real Octokit HTTP %s error from the offline transport', async status => {
  const transport = historyTransport();
  transport.setHook(() => ({ status, data: { message: 'private response body', token: 'do-not-save' },
    headers: { 'X-GitHub-Request-Id': requestId, 'X-RateLimit-Remaining': '0', 'Retry-After': '30',
      'set-cookie': 'private-cookie', authorization: 'Bearer private-response-token' } }));
  const error = await captureGithubPrEvidence({ repository: 'fixture/project', number: 7 }, transport).catch(value => value);
  expect(error).toBeInstanceOf(GithubReadError);
  expect(error.diagnostic).toEqual({ status, requestId, rateLimitRemaining: 0, retryAfterSeconds: 30 });
  expect(error.message).toContain(`HTTP ${status}`);
  expect(error.cause).toBeUndefined();
  for (const secret of ['private response body', 'do-not-save', 'private-cookie', 'private-response-token']) {
    expect(JSON.stringify(error)).not.toContain(secret); expect(error.message).not.toContain(secret);
  }
  expect(transport.calls).toHaveLength(1);
});

it('does not turn Octokit network-error status 500 into an observed HTTP response', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error('private transport error'); };
  const error = await captureGithubPrEvidence({ repository: 'fixture/project', number: 7 }, { fetch }).catch(value => value);
  expect(error).toBeInstanceOf(GithubReadError); expect(error.diagnostic).toBeUndefined();
  expect(error.message).not.toContain('HTTP'); expect(error.message).not.toContain('private');
  expect(error.cause).toBeUndefined(); expect(calls).toBe(1);
});

it('keeps legacy rows compatible and rejects diagnostics on nonfailed states or outside the allowlist', () => {
  const initial = initialHistoryItems([7])[0];
  const legacy = { ...initial, status: 'failed', attempts: 1, lastAttemptAt: '2026-10-02T17:00:00.000Z', failure: 'forbidden-or-rate-limited' };
  expect(HistoryItemSchema.parse(legacy)).toEqual(legacy);
  expect(HistoryItemSchema.parse({ ...legacy, failureDiagnostic: { status: 403 } }).failureDiagnostic).toEqual({ status: 403 });
  expect(() => HistoryItemSchema.parse({ ...initial, failureDiagnostic: { status: 403 } })).toThrow();
  for (const failureDiagnostic of [{ status: 403, body: 'private' }, { status: 403, requestId: 'token secret' },
    { status: 403, rateLimitRemaining: -1 }, { status: 429, retryAfterSeconds: 1, retryAfterAt: '2026-10-02T17:00:00.000Z' }]) {
    expect(() => HistoryItemSchema.parse({ ...legacy, failureDiagnostic })).toThrow();
  }
});
