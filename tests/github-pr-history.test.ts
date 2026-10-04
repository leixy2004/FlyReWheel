import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverGithubPrHistory, validateHistoryPlan, HISTORY_PAGE_SIZE } from '../src/github-pr-history.js';
import { captureGithubPrHistoryBatch } from '../src/github-pr-history-batch.js';
import { QualEvoStore } from '../src/storage/store.js';
import { digestOf } from '../src/core/identity.js';
import { historyPlan, historyTransport, searchItem, historyRepository, historyTime } from './helpers/github-history-fixture.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { useFreshPGlite } from './helpers/fresh-pglite.js';

const filter = { repository: historyRepository, createdFrom: historyTime, createdBefore: '2026-10-02T00:00:00Z', status: 'all' as const };
afterEach(() => vi.restoreAllMocks());
it('discovers only public unauthenticated GET PR search with explicit filters, safe pagination and deterministic tie ordering', async () => {
  const transport = historyTransport();
  transport.setHook(url => ({ data: { total_count: 6, incomplete_results: false,
    items: url.searchParams.get('page') === '1' ? [5, 4, 3, 2, 1].map(number => searchItem(number)) : [searchItem(6)] },
    headers: url.searchParams.get('page') === '1' ? { link: '<https://attacker.invalid/secret>; rel="next"' } : undefined }));
  const result = await discoverGithubPrHistory({ ...filter, maxPulls: 10 }, transport);
  expect(result.plan.pulls.map(pull => pull.number)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(result.plan.discovery).toMatchObject({ pagesRead: 2, rowsRead: 6, reportedTotal: 6, coverage: 'all-reported-search-results-observed', stopReason: 'exhausted' });
  expect(result.receipt.kind).toBe('package-integrity-only');
  for (const call of transport.calls) {
    expect(call.pathname).toBe('/search/issues'); expect(call.searchParams.get('sort')).toBe('created'); expect(call.searchParams.get('order')).toBe('asc');
    expect(call.searchParams.get('per_page')).toBe(String(HISTORY_PAGE_SIZE));
    expect(call.searchParams.get('q')).toBe('repo:fixture/project is:pr created:2026-10-01T00:00:00Z..2026-10-01T23:59:59Z');
  }
});
it.each([
  ['pull-limit', { maxPulls: 2 }, 50, false, true],
  ['page-limit', { maxPulls: 10, maxPages: 1 }, 50, false, true],
  ['exhausted', { maxPulls: 10 }, 5, true, false],
  ['pull-limit', { maxPulls: 5 }, 1001, false, true],
] as const)('reports partial selection/cap/incomplete-search honestly (%s)', async (stopReason, bounds, total, incomplete, next) => {
  const f = historyTransport(); f.setHook(() => ({ data: { total_count: total, incomplete_results: incomplete, items: [1, 2, 3, 4, 5].map(number => searchItem(number)) }, headers: next ? { link: '<https://api.github.com/next>; rel="next"' } : undefined }));
  const { plan } = await discoverGithubPrHistory({ ...filter, ...bounds }, f);
  expect(plan.discovery).toMatchObject({ stopReason, coverage: 'partial-search-results', incompleteResults: incomplete, searchCapReached: total > 1000 });
  expect(plan.pulls.length).toBeLessThanOrEqual(bounds.maxPulls); expect(f.calls).toHaveLength(1);
});
it('represents an empty search without fabricating evidence', async () => {
  const f = historyTransport(); f.setHook(() => ({ data: { total_count: 0, incomplete_results: false, items: [] } }));
  const result = await discoverGithubPrHistory(filter, f);
  expect(result.plan.pulls).toEqual([]); expect(result.plan.discovery.coverage).toBe('all-reported-search-results-observed');
});
it.each(['open', 'closed', 'merged'] as const)('includes and checks %s status', async status => {
  const f = historyTransport(), row = searchItem(7);
  if (status !== 'open') row.state = 'closed';
  const item = { ...row, pull_request: { ...row.pull_request, merged_at: status === 'merged' ? historyTime : null } };
  f.setHook(() => ({ data: { total_count: 1, incomplete_results: false, items: [item] } }));
  await discoverGithubPrHistory({ ...filter, status }, f);
  expect(f.calls[0].searchParams.get('q')).toContain(`is:${status}`);
});
it.each([
  { repository: '../invalid' }, { createdFrom: 'bad' }, { createdBefore: historyTime }, { createdBefore: '2030-01-01T00:00:00Z' },
  { createdFrom: '2026-10-01T00:00:00.001Z' }, { status: 'whatever' }, { maxPulls: 26 }, { maxPages: 11 },
  { createdFrom: '2026-10-01T00:00:00.0001Z' }, { createdBefore: '2026-10-02T00:00:00.000000001Z' },
  { createdFrom: '2026-10-01T08:00:00.0001+08:00' },
])('rejects invalid discovery scope before transport (%j)', async invalid => {
  const f = historyTransport(); await expect(discoverGithubPrHistory({ ...filter, ...invalid } as any, f)).rejects.toThrow(); expect(f.calls).toEqual([]);
});
it.each([
  ['foreign repository', { repository_url: 'https://api.github.com/repos/other/repo' }],
  ['foreign URL', { html_url: 'https://github.com/other/repo/pull/7' }],
  ['issue result', { pull_request: undefined }], ['before window', { created_at: '2026-09-30T23:59:59Z' }], ['at exclusive bound', { created_at: '2026-10-02T00:00:00Z' }],
  ['unexpected fractional creation second', { created_at: '2026-10-01T23:59:59.5Z' }],
  ['unexpected sub-millisecond creation second', { created_at: '2026-10-01T00:00:00.0001Z' }],
])('rejects %s', async (_name, mutation) => {
  const f = historyTransport(); f.setHook(() => ({ data: { total_count: 1, incomplete_results: false, items: [{ ...searchItem(7), ...mutation }] } }));
  await expect(discoverGithubPrHistory(filter, f)).rejects.toThrow();
});
it.each([
  ['2024-09-18T15:17:18Z', '2024-09-18T16:17:18Z', '2024-09-18T15:17:18Z', '2024-09-18T16:17:17Z'],
  ['2024-09-18T15:17:18Z', '2024-09-18T15:17:19Z', '2024-09-18T15:17:18Z', '2024-09-18T15:17:18Z'],
  ['2024-02-29T23:59:59Z', '2024-03-01T00:00:00Z', '2024-02-29T23:59:59Z', '2024-02-29T23:59:59Z'],
  ['2024-12-31T23:59:59Z', '2025-01-01T00:00:00Z', '2024-12-31T23:59:59Z', '2024-12-31T23:59:59Z'],
  ['2024-09-18T23:17:18+08:00', '2024-09-18T12:17:18-04:00', '2024-09-18T15:17:18Z', '2024-09-18T16:17:17Z'],
  ['2024-09-18T15:17:18.000000Z', '2024-09-18T16:17:18.000Z', '2024-09-18T15:17:18Z', '2024-09-18T16:17:17Z'],
])('encodes an inclusive second-precision range through real Octokit for [%s, %s)', async (createdFrom, createdBefore, first, last) => {
  const f = historyTransport();
  const items = first === last ? [searchItem(7, first)] : [searchItem(7, first), searchItem(8, last)];
  f.setHook(() => ({ data: { total_count: items.length, incomplete_results: false, items } }));
  const { plan } = await discoverGithubPrHistory({ ...filter, createdFrom, createdBefore }, f);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].searchParams.get('q')).toBe(`repo:${historyRepository} is:pr created:${first}..${last}`);
  expect(plan.pulls.map(pull => pull.createdAt)).toEqual(items.map(item => item.created_at));
  expect(plan.discovery.coverage).toBe('all-reported-search-results-observed');
  expect(plan.filter).toMatchObject({ createdFrom, createdBefore });
});
it('keeps the observed live out-of-window response fail-closed with the corrected query', async () => {
  const evidence = JSON.parse(await readFile(new URL('../docs/evidence/github-pr-history-vllm-live-2026-10-02.json', import.meta.url), 'utf8'));
  const items = evidence.search.rejectedRows.map((row: any) => ({ number: row.number, html_url: row.url,
    repository_url: `https://api.github.com/repos/${evidence.repository}`, title: `Observed PR ${row.number}`,
    created_at: row.createdAt, updated_at: row.createdAt, state: row.state,
    pull_request: { html_url: row.url, merged_at: row.mergedAt } }));
  const f = historyTransport();
  f.setHook(() => ({ data: { total_count: evidence.search.observedReportedTotal, incomplete_results: evidence.search.incompleteResults, items } }));
  await expect(discoverGithubPrHistory({ repository: evidence.repository, ...evidence.filter }, f)).rejects.toThrow('out-of-filter PR');
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].searchParams.get('q')).toBe('repo:vllm-project/vllm is:pr created:2024-09-18T15:17:18Z..2024-09-18T16:17:17Z is:merged');
});
it('rejects duplicate pages, changed totals, reverse time order and inconsistent pagination', async () => {
  for (const variant of ['duplicate', 'changed-total', 'ordering', 'pagination']) {
    const f = historyTransport();
    f.setHook(url => ({ data: { total_count: variant === 'changed-total' && url.searchParams.get('page') === '2' ? 11 : 10, incomplete_results: false,
      items: variant === 'pagination' ? [searchItem(1)] : variant === 'ordering' ? [searchItem(1, '2026-10-01T01:00:00Z'), searchItem(2)] : [1, 2, 3, 4, 5].map(number => searchItem(number)) },
      headers: { link: '<https://api.github.com/next>; rel="next"' } }));
    await expect(discoverGithubPrHistory({ ...filter, maxPulls: 10 }, f)).rejects.toThrow(); expect(f.calls.length).toBeLessThanOrEqual(2);
  }
});
it('stops immediately on rate limits, timeout and response budgets without exposing provider bodies', async () => {
  const rate = historyTransport(); rate.setHook(() => ({ status: 429, data: { message: 'never echo secret' } }));
  await expect(discoverGithubPrHistory(filter, rate)).rejects.toThrow('HTTP 429'); expect(rate.calls).toHaveLength(1);
  const big = historyTransport(); big.setHook(() => ({ data: { oversized: 'x'.repeat(2_000_001) } }));
  await expect(discoverGithubPrHistory(filter, big)).rejects.toThrow('byte budget');
  const timeout = historyTransport(); timeout.setHook(() => ({ data: { total_count: 0, incomplete_results: false, items: [] } })); const original = Date.now; let calls = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => original() + (calls++ > 1 ? 31_000 : 0));
  await expect(discoverGithubPrHistory(filter, timeout)).rejects.toThrow('deadline');
});
it('rejects forged completeness, reordered selection, injected progress and fresh receipts on import', async () => {
  const value = historyPlan();
  for (const change of [
    (v: any) => { v.plan.discovery.coverage = 'partial-search-results'; },
    (v: any) => { v.plan.pulls.reverse(); },
    (v: any) => { v.items = [{ status: 'captured' }]; },
    (v: any) => { v.receipt.kind = 'github-api-observation'; },
    (v: any) => { v.plan.filter.repository = 'other/repo'; },
  ]) { const copy = structuredClone(value); change(copy); copy.digest = digestOf(copy.plan); expect(() => validateHistoryPlan(copy)).toThrow(); }
});

it('persists serial progress across database reopen, resumes only pending PRs and keeps receipts invocation-local', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-resume-')); let store: QualEvoStore | undefined;
  try {
    store = await QualEvoStore.openPGlite(join(directory, 'db'));
    const plan = historyPlan(), f = historyTransport(); await store.importGithubPrHistoryPlan(plan);
    const first = await captureGithubPrHistoryBatch(store, plan.digest, { maxPulls: 1 }, f);
    expect(first.batch.items.map(item => item.status)).toEqual(['captured', 'pending']); expect(first.run.stopReason).toBe('pull-limit');
    expect(first.run.freshCaptures).toHaveLength(1); expect(first.run.requests).toBe(f.calls.length);
    await store.close(); store = await QualEvoStore.openPGlite(join(directory, 'db'));
    expect(await store.importGithubPrHistoryPlan(plan)).toEqual(first.batch);
    const again = historyTransport(); const second = await captureGithubPrHistoryBatch(store, plan.digest, {}, again);
    expect(second.batch.items.map(item => item.status)).toEqual(['captured', 'captured']); expect(second.run.freshCaptures.map(value => value.number)).toEqual([8]);
    expect(again.calls.some(call => call.pathname.endsWith('/pulls/7'))).toBe(false);
    for (const item of second.batch.items) expect((await store.getGithubPrEvidence(item.evidenceDigest!)).evidence.snapshotDigest).toBe(item.snapshotDigest);
    const third = await captureGithubPrHistoryBatch(store, plan.digest, {}, again);
    expect(third.run.requests).toBe(0); expect(third.run.freshCaptures).toEqual([]); expect(third.batch.receipt.kind).toBe('package-integrity-only');
    const listed = await store.listGithubPrHistoryBatches({ repository: 'Fixture/Project' }); expect(listed.batches[0].counts).toMatchObject({ captured: 2, pending: 0 });
    expect((await store.listGithubPrHistoryBatches({ after: plan.digest })).batches).toEqual([]);
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
it('records failures, continues bounded non-rate failures, retries explicitly and never re-captures successes', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan(), f = historyTransport(); await store.importGithubPrHistoryPlan(plan);
    f.setHook(url => url.pathname.endsWith('/pulls/7') ? { status: 404, data: { message: 'private diagnostic' } } : undefined);
    const first = await captureGithubPrHistoryBatch(store, plan.digest, {}, f);
    expect(first.batch.items.map(item => item.status)).toEqual(['failed', 'captured']); expect(JSON.stringify(first)).not.toContain('private diagnostic');
    expect(first.batch.items[0].failureDiagnostic).toEqual({ status: 404 });
    expect((await captureGithubPrHistoryBatch(store, plan.digest, {}, f)).run.attempted).toBe(0);
    const retry = historyTransport(); const done = await captureGithubPrHistoryBatch(store, plan.digest, { retryFailed: true }, retry);
    expect(done.batch.items.map(item => item.attempts)).toEqual([2, 1]); expect(done.run.freshCaptures.map(item => item.number)).toEqual([7]);
    expect(done.batch.items[0]).not.toHaveProperty('failureDiagnostic');
  } finally { await store.close(); }
});
it.each([403, 429])('stops a batch on HTTP %s, with remaining PRs pending', async status => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan(), f = historyTransport(); await store.importGithubPrHistoryPlan(plan);
    f.setHook(() => ({ status, data: { message: 'rate limit' } }));
    const result = await captureGithubPrHistoryBatch(store, plan.digest, {}, f);
    expect(f.calls).toHaveLength(1); expect(result.run.stopReason).toBe(status === 403 ? 'forbidden-or-rate-limited' : 'rate-limited'); expect(result.batch.items.map(item => item.status)).toEqual(['failed', 'pending']);
    expect(result.batch.items[0].failureDiagnostic).toEqual({ status });
  } finally { await store.close(); }
});
it('persists sanitized failure observations across reopen without inferring a 403 cause or retaining stale retry data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-diagnostic-')); let store: QualEvoStore | undefined;
  try {
    store = await QualEvoStore.openPGlite(join(directory, 'db'));
    const plan = historyPlan([7]), f = historyTransport([7]); await store.importGithubPrHistoryPlan(plan);
    f.setHook(() => ({ status: 403, data: { message: 'private provider message' }, headers: {
      'x-github-request-id': 'ABCD:1234:5678:9ABC:DEF0', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790960400',
      'retry-after': '60', 'set-cookie': 'private-cookie', authorization: 'Bearer private-token',
    } }));
    const first = await captureGithubPrHistoryBatch(store, plan.digest, {}, f);
    expect(first.batch.items[0]).toMatchObject({ failure: 'forbidden-or-rate-limited', failureDiagnostic: {
      status: 403, requestId: 'ABCD:1234:5678:9ABC:DEF0', rateLimitRemaining: 0, rateLimitReset: 1790960400, retryAfterSeconds: 60,
    } });
    expect(first.run).toMatchObject({ stopReason: 'forbidden-or-rate-limited', requests: 1, freshCaptures: [] });
    expect(JSON.stringify(first)).not.toContain('private');
    await store.close(); store = await QualEvoStore.openPGlite(join(directory, 'db'));
    expect(await store.getGithubPrHistoryBatch(plan.digest)).toEqual(first.batch);
    const noRetry = historyTransport([7]);
    expect((await captureGithubPrHistoryBatch(store, plan.digest, {}, noRetry)).run.attempted).toBe(0);
    expect(noRetry.calls).toEqual([]);
    const next = historyTransport([7]); next.setHook(() => ({ status: 404, data: {} }));
    const failedAgain = await captureGithubPrHistoryBatch(store, plan.digest, { retryFailed: true }, next);
    expect(failedAgain.batch.items[0]).toMatchObject({ attempts: 2, failure: 'capture-failed', failureDiagnostic: { status: 404 } });
    expect(failedAgain.batch.items[0].failureDiagnostic).toEqual({ status: 404 });
    const done = await captureGithubPrHistoryBatch(store, plan.digest, { retryFailed: true }, historyTransport([7]));
    expect(done.batch.items[0]).toMatchObject({ status: 'captured', attempts: 3, failure: null });
    expect(done.batch.items[0]).not.toHaveProperty('failureDiagnostic');
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
it('enforces aggregate requests across failures and rejects malformed bounds before reading state', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan(), f = historyTransport(); await store.importGithubPrHistoryPlan(plan);
    const result = await captureGithubPrHistoryBatch(store, plan.digest, { maxRequests: 3 }, f);
    expect(f.calls).toHaveLength(3); expect(result.run.requests).toBe(3); expect(result.run.stopReason).toBe('request-budget');
    expect(result.batch.items.map(item => item.status)).toEqual(['failed', 'pending']);
    await expect(captureGithubPrHistoryBatch(store, 'not-a-digest', { maxPulls: 6 }, f)).rejects.toThrow();
  } finally { await store.close(); }
});
describe('interrupted history recovery setup', () => {
  const fresh = useFreshPGlite();
  it('requires explicit interrupted recovery, rejects concurrent CAS claims and never imports forged progress', async context => {
    const { store } = fresh(context);
    const plan = historyPlan(), initial = await store.importGithubPrHistoryPlan(plan), f = historyTransport();
    const active = { ...initial.items[0], status: 'capturing' as const, attempts: 1, lastAttemptAt: '2026-10-01T00:00:00.000Z' };
    const running = await store.updateGithubPrHistoryItem(plan.digest, 0, active);
    await expect(store.updateGithubPrHistoryItem(plan.digest, 0, active)).rejects.toThrow('changed');
    await expect(store.updateGithubPrHistoryItem(plan.digest, running.revision, { ...initial.items[1], status: 'capturing', attempts: 1, lastAttemptAt: active.lastAttemptAt })).rejects.toThrow('active');
    await expect(captureGithubPrHistoryBatch(store, plan.digest, {}, f)).rejects.toThrow('recover-interrupted'); expect(f.calls).toEqual([]);
    const result = await captureGithubPrHistoryBatch(store, plan.digest, { recoverInterrupted: true }, f);
    expect(result.batch.items.map(item => item.attempts)).toEqual([2, 1]);
    await expect(store.importGithubPrHistoryPlan(result.batch)).rejects.toThrow();
  });
});
it('rejects captures whose current status moved outside the discovery filter', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan([7]); plan.plan.filter.status = 'open'; plan.digest = digestOf(plan.plan);
    await store.importGithubPrHistoryPlan(plan); const f = historyTransport([7]);
    const pull = f.routes.get('/repos/fixture/project/pulls/7') as any; pull.state = 'closed'; pull.closed_at = historyTime;
    const result = await captureGithubPrHistoryBatch(store, plan.digest, {}, f);
    expect(result.batch.items[0]).toMatchObject({ status: 'failed', failure: 'out-of-filter', evidenceDigest: null }); expect(result.run.freshCaptures).toEqual([]);
  } finally { await store.close(); }
});
it('links explicit mining requests to exact captured IDs through the existing unknown-only derivation', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan([7]), f = historyTransport([7]); await store.importGithubPrHistoryPlan(plan);
    const capture = await captureGithubPrHistoryBatch(store, plan.digest, {}, f), item = capture.batch.items[0];
    const input = { id: 'history-rule-request', evidenceDigest: item.evidenceDigest!, sources: [{ side: 'after' as const, path: 'file.ts' }], statements: [{ kind: 'pull' as const }],
      requestedRule: { ruleId: 'history-candidate', version: 'draft-1', parentDigest: null }, objective: 'Investigate without inventing semantics.', actor: 'local-operator', source: 'supplied' as const, createdAt: historyTime };
    const request = await store.createGithubPrHistoryMiningRequest(plan.digest, 7, input);
    expect(request.request).toMatchObject({ status: 'pending', synthesis: 'not_run', trust: { labels: 'unknown-only', evidence: 'package-integrity-only' } });
    expect((await store.getGithubPrHistoryBatch(plan.digest)).items[0].miningRequestDigests).toEqual([request.digest]);
    expect(await store.createGithubPrHistoryMiningRequest(plan.digest, 7, input)).toEqual(request);
    await expect(store.createGithubPrHistoryMiningRequest(plan.digest, 8, input)).rejects.toThrow('exact');
    await expect(store.createGithubPrHistoryMiningRequest(plan.digest, 7, { ...input, evidenceDigest: 'a'.repeat(64) })).rejects.toThrow('exact');
  } finally { await store.close(); }
});
it('records per-PR budget failure distinctly while continuing within the aggregate allowance', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan(), f = historyTransport(); await store.importGithubPrHistoryPlan(plan);
    const result = await captureGithubPrHistoryBatch(store, plan.digest, { maxRequestsPerPull: 1, maxRequests: 20 }, f);
    expect(f.calls).toHaveLength(2); expect(result.batch.items.map(item => item.failure)).toEqual(['request-budget', 'request-budget']);
    expect(result.run.stopReason).toBe('finished-selection'); expect(result.run.acceptedEvidenceBytes).toBe(0);
  } finally { await store.close(); }
});
it('rolls back a 21st mining request and derived cases when the local linkage bound rejects it', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan([7]), f = historyTransport([7]); await store.importGithubPrHistoryPlan(plan);
    const captured = await captureGithubPrHistoryBatch(store, plan.digest, {}, f), evidenceDigest = captured.batch.items[0].evidenceDigest!;
    const input = { id: 'request', evidenceDigest, sources: [{ side: 'after' as const, path: 'file.ts' }], statements: [{ kind: 'pull' as const }],
      requestedRule: { ruleId: 'bounded-rule', version: 'draft-1', parentDigest: null }, objective: 'Investigate evidence.', actor: 'local-operator', source: 'supplied' as const, createdAt: historyTime };
    for (let index = 0; index < 20; index++) await store.createGithubPrHistoryMiningRequest(plan.digest, 7, { ...input, id: `request-${index}` });
    await expect(store.createGithubPrHistoryMiningRequest(plan.digest, 7, { ...input, id: 'request-20' })).rejects.toThrow();
    expect(await store.listPrMiningRequests(evidenceDigest)).toHaveLength(20);
    expect((await store.getGithubPrHistoryBatch(plan.digest)).items[0].miningRequestDigests).toHaveLength(20);
  } finally { await store.close(); }
}, 30_000);
describe('stored history evidence setup', () => {
  const fresh = useFreshPGlite();
  it('revalidates stored captured evidence and mining links on read and resume', async context => {
    const { db, store } = fresh(context);
    const plan = historyPlan([7]), f = historyTransport([7]); await store.importGithubPrHistoryPlan(plan);
    const result = await captureGithubPrHistoryBatch(store, plan.digest, {}, f);
    const original = result.batch.items;
    for (const mutation of [{ snapshotDigest: 'a'.repeat(64) }, { evidenceDigest: 'a'.repeat(64) }, { miningRequestDigests: ['a'.repeat(64)] }]) {
      await db.query('UPDATE qe_github_pr_history SET items=$1::jsonb WHERE digest=$2', [JSON.stringify([{ ...original[0], ...mutation }]), plan.digest]);
      await expect(store.getGithubPrHistoryBatch(plan.digest)).rejects.toThrow();
      await expect(captureGithubPrHistoryBatch(store, plan.digest, {}, f)).rejects.toThrow();
    }
    await expect(db.query('UPDATE qe_github_pr_history SET repository=$1 WHERE digest=$2', ['other/repo', plan.digest])).rejects.toThrow('immutable');
  });
});
it('keeps an interruption recoverable when local persistence fails after a successful provider read', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan([7]), f = historyTransport([7]); await store.importGithubPrHistoryPlan(plan);
    const save = vi.spyOn(store, 'importGithubPrEvidence').mockRejectedValueOnce(new Error('local disk unavailable'));
    await expect(captureGithubPrHistoryBatch(store, plan.digest, {}, f)).rejects.toThrow('local disk unavailable');
    expect((await store.getGithubPrHistoryBatch(plan.digest)).items[0].status).toBe('capturing'); save.mockRestore();
    const result = await captureGithubPrHistoryBatch(store, plan.digest, { recoverInterrupted: true }, f);
    expect(result.batch.items[0]).toMatchObject({ status: 'captured', attempts: 2 });
  } finally { await store.close(); }
});
it('shares the aggregate deadline with the existing capturer and leaves remaining PRs pending', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan(), f = historyTransport(); await store.importGithubPrHistoryPlan(plan);
    let elapsed = 0; const start = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => start + elapsed);
    f.setHook(() => { elapsed = 101; return undefined; });
    const result = await captureGithubPrHistoryBatch(store, plan.digest, { timeoutMs: 100 }, f);
    expect(f.calls).toHaveLength(1); expect(result.run.stopReason).toBe('deadline');
    expect(result.batch.items.map(item => item.status)).toEqual(['failed', 'pending']); expect(result.batch.items[0].failure).toBe('deadline');
  } finally { vi.restoreAllMocks(); await store.close(); }
});
it('enforces the aggregate accepted-evidence ceiling without counting the rejected capture', async () => {
  const { createHash } = await import('node:crypto');
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan([7, 8, 9]), f = historyTransport([7, 8, 9]); await store.importGithubPrHistoryPlan(plan);
    const bytes = Buffer.from('x'.repeat(262_144)), blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const prefix = '/repos/fixture/project';
    f.routes.set(`${prefix}/git/blobs/${blob}`, { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
    const files = Array.from({ length: 8 }, (_, index) => ({ filename: `file${index}.ts`, status: 'added', sha: blob }));
    (f.routes.get(`${prefix}/compare/${'1'.repeat(40)}...${'2'.repeat(40)}`) as any).files = files;
    (f.routes.get(`${prefix}/git/trees/${'3'.repeat(40)}`) as any).tree = files.map(file => ({ path: file.filename, sha: blob, size: bytes.length, type: 'blob', mode: '100644' }));
    for (const number of [7, 8, 9]) {
      const pull = f.routes.get(`${prefix}/pulls/${number}`) as any; pull.changed_files = 8; pull.comments = 29;
      f.routes.set(`${prefix}/issues/${number}/comments`, Array.from({ length: 29 }, (_, index) => ({ id: index + 1, html_url: `${pull.html_url}#issuecomment-${index + 1}`, user: null, body: 'x'.repeat(60_000), created_at: historyTime, updated_at: historyTime })));
    }
    const result = await captureGithubPrHistoryBatch(store, plan.digest, { maxPulls: 3, maxRequests: 100 }, f);
    expect(result.batch.items.map(item => item.status)).toEqual(['captured', 'captured', 'failed']);
    expect(result.batch.items[2].failure).toBe('evidence-budget'); expect(result.run.stopReason).toBe('evidence-budget');
    let accepted = 0;
    for (const item of result.batch.items.slice(0, 2)) accepted += Buffer.byteLength(JSON.stringify((await store.getGithubPrEvidence(item.evidenceDigest!)).evidence));
    expect(result.run.acceptedEvidenceBytes).toBe(accepted); expect(accepted).toBeLessThanOrEqual(12_000_000);
    expect(result.run.freshCaptures).toHaveLength(2);
  } finally { await store.close(); }
}, 60_000);
it('retains a per-PR deadline reason when fetch aborts before the longer aggregate deadline', async () => {
  const store = await QualEvoStore.openPGlite();
  try {
    const plan = historyPlan([7]), f = historyTransport([7]); await store.importGithubPrHistoryPlan(plan);
    let elapsed = 0; const start = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => start + elapsed);
    f.setHook(() => { elapsed = 120_001; throw new Error('aborted transport body must not be echoed'); });
    const result = await captureGithubPrHistoryBatch(store, plan.digest, { timeoutMs: 300_000 }, f);
    expect(result.batch.items[0].failure).toBe('deadline'); expect(result.run.requests).toBe(1);
    expect(JSON.stringify(result)).not.toContain('aborted transport body');
  } finally { vi.restoreAllMocks(); await store.close(); }
});
