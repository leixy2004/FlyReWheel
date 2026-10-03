import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { HISTORY_NOTES, type HistoryPlan, validateHistoryPlan } from '../../src/github-pr-history.js';
import { digestOf } from '../../src/core/identity.js';

export const historyRepository = 'fixture/project', historyTime = '2026-10-01T00:00:00Z';
export function historyPlan(numbers: number[] = [7, 8]) {
  const plan: HistoryPlan = { schemaVersion: 1, kind: 'github-pr-history-plan',
    filter: { repository: historyRepository, createdFrom: historyTime, createdBefore: '2026-10-02T00:00:00Z', status: 'all', maxPulls: 25, maxPages: 10 },
    ordering: 'created-ascending-then-number',
    pulls: numbers.map(number => ({ number, url: `https://github.com/${historyRepository}/pull/${number}`, title: `PR ${number}`, createdAt: historyTime, updatedAt: historyTime, state: 'open', mergedAt: null })),
    discovery: { observedAt: historyTime, pagesRead: Math.max(1, Math.ceil(numbers.length / 5)), rowsRead: numbers.length, reportedTotal: numbers.length,
      incompleteResults: false, searchCapReached: false, hasMore: false, stopReason: 'exhausted', coverage: 'all-reported-search-results-observed', notes: [...HISTORY_NOTES] } };
  return validateHistoryPlan({ digest: digestOf(plan), plan, receipt: { kind: 'package-integrity-only' } });
}
export function historyTransport(numbers = [7, 8]) {
  const base = '1'.repeat(40), head = '2'.repeat(40), tree = '3'.repeat(40), bytes = Buffer.from('export const fixed = true;\n');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const prefix = `/repos/${historyRepository}`;
  const routes = new Map<string, unknown>([
    [`${prefix}/compare/${base}...${head}`, { base_commit: { sha: base }, merge_base_commit: { sha: base }, files: [{ filename: 'file.ts', status: 'added', sha: blob }] }],
    [`${prefix}/git/commits/${base}`, { sha: base, tree: { sha: '4'.repeat(40) } }], [`${prefix}/git/commits/${head}`, { sha: head, tree: { sha: tree } }],
    [`${prefix}/git/trees/${'4'.repeat(40)}`, { sha: '4'.repeat(40), truncated: false, tree: [] }],
    [`${prefix}/git/trees/${tree}`, { sha: tree, truncated: false, tree: [{ path: 'file.ts', mode: '100644', type: 'blob', sha: blob, size: bytes.length }] }],
    [`${prefix}/git/blobs/${blob}`, { sha: blob, size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' }],
  ]);
  for (const number of numbers) {
    const url = `https://github.com/${historyRepository}/pull/${number}`;
    routes.set(`${prefix}/pulls/${number}`, { id: number + 1000, number, html_url: url, title: `PR ${number}`, body: 'Untrusted discussion, never a label.', user: null,
      state: 'open', draft: false, merged: false, created_at: historyTime, updated_at: historyTime, closed_at: null, merged_at: null,
      base: { ref: 'main', sha: base, repo: { full_name: historyRepository, private: false } }, head: { ref: 'topic', sha: head, repo: null }, merge_commit_sha: null,
      changed_files: 1, comments: 0, review_comments: 0 });
    for (const suffix of [`issues/${number}/comments`, `pulls/${number}/reviews`, `pulls/${number}/comments`]) routes.set(`${prefix}/${suffix}`, []);
  }
  const calls: URL[] = [];
  let hook: ((url: URL, data: unknown) => { data?: unknown; status?: number; headers?: Record<string, string> } | undefined) | undefined;
  const fetch: typeof globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); calls.push(url);
    expect(url.origin).toBe('https://api.github.com'); expect(options?.method).toBe('GET'); expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).has('authorization')).toBe(false); expect(new Headers(options?.headers).get('x-github-api-version')).toBe('2022-11-28');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const original = routes.get(url.pathname), override = hook?.(url, original);
    if (original === undefined && override?.data === undefined) throw new Error(`Unexpected route ${url}`);
    return new Response(JSON.stringify(override?.data ?? original), { status: override?.status ?? 200, headers: { 'content-type': 'application/json', ...override?.headers } });
  };
  return { routes, calls, fetch, setHook(value: typeof hook) { hook = value; } };
}
export function searchItem(number: number, createdAt = historyTime) {
  const url = `https://github.com/${historyRepository}/pull/${number}`;
  return { number, html_url: url, repository_url: `https://api.github.com/repos/${historyRepository}`, title: `PR ${number}`, created_at: createdAt, updated_at: historyTime,
    state: 'open', pull_request: { html_url: url, merged_at: null } };
}
