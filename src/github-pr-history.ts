import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { digestOf } from './core/identity.js';
import { DigestSchema } from './core/model.js';
import { GithubRepository } from './github-pr-evidence.js';

export const HISTORY_MAX_JSON_BYTES = 500_000;
export const HISTORY_PAGE_SIZE = 5;
const Time = z.string().datetime({ offset: true });
// Date.parse truncates sub-millisecond fractions, so modulo arithmetic alone
// would incorrectly admit bounds such as .0001Z. Search ranges use seconds.
const WholeSecondTime = Time.refine(value => !/\.\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'Creation times must use whole seconds');
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NumberId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const HistoryFilterSchema = z.object({
  repository: GithubRepository.transform(value => value.toLowerCase()),
  createdFrom: WholeSecondTime, createdBefore: WholeSecondTime,
  status: z.enum(['all', 'open', 'closed', 'merged']),
  maxPulls: z.number().int().min(1).max(25).default(5),
  maxPages: z.number().int().min(1).max(10).default(2),
}).strict().superRefine((value, ctx) => {
  const duration = Date.parse(value.createdBefore) - Date.parse(value.createdFrom);
  if (duration <= 0 || duration > 366 * 86400_000) ctx.addIssue({ code: 'custom', message: 'Creation window must be positive and at most 366 days' });
});
export type HistoryFilter = z.infer<typeof HistoryFilterSchema>;
export const HistoryPullSchema = z.object({
  number: NumberId, url: z.string().url().max(2048), title: z.string().max(1024),
  createdAt: WholeSecondTime, updatedAt: Time, state: z.enum(['open', 'closed']), mergedAt: Time.nullable(),
}).strict();
export type HistoryPull = z.infer<typeof HistoryPullSchema>;
export function historyOrder(a: HistoryPull, b: HistoryPull): number { return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number; }
export function matchesHistoryFilter(pull: Pick<HistoryPull, 'createdAt' | 'state' | 'mergedAt'>, filter: HistoryFilter): boolean {
  return Date.parse(pull.createdAt) >= Date.parse(filter.createdFrom) && Date.parse(pull.createdAt) < Date.parse(filter.createdBefore)
    && (filter.status === 'all' || (filter.status === 'merged' ? pull.mergedAt !== null : pull.state === filter.status));
}
export const HISTORY_NOTES = [
  'Current non-atomic GitHub search observation; search indexing, omissions, and movement can affect results.',
  'Not a probability sample, historical review checkpoint, complete repository history, or semantic ground truth.',
  'Creation-time ascending API order; retained rows sorted by creation time then PR number. Ties beyond a cap may vary.',
  'Closed includes merged PRs. Creation window is inclusive from and exclusive before; it is not a merge-time window.',
] as const;
export const HistoryPlanSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('github-pr-history-plan'), filter: HistoryFilterSchema,
  ordering: z.literal('created-ascending-then-number'), pulls: z.array(HistoryPullSchema).max(25),
  discovery: z.object({
    observedAt: Time, pagesRead: Count.max(10), rowsRead: Count.max(50), reportedTotal: Count,
    incompleteResults: z.boolean(), searchCapReached: z.boolean(), hasMore: z.boolean(),
    stopReason: z.enum(['exhausted', 'pull-limit', 'page-limit']),
    coverage: z.enum(['all-reported-search-results-observed', 'partial-search-results']),
    notes: z.tuple([z.literal(HISTORY_NOTES[0]), z.literal(HISTORY_NOTES[1]), z.literal(HISTORY_NOTES[2]), z.literal(HISTORY_NOTES[3])]),
  }).strict(),
}).strict().superRefine((plan, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  const d = plan.discovery;
  if (plan.pulls.length > plan.filter.maxPulls || d.pagesRead < 1 || d.pagesRead > plan.filter.maxPages || d.rowsRead < plan.pulls.length || d.rowsRead > d.pagesRead * HISTORY_PAGE_SIZE || d.reportedTotal < d.rowsRead) invalid('Inconsistent discovery counts');
  if (d.searchCapReached !== (d.reportedTotal > 1000)) invalid('Inconsistent search cap');
  const complete = !d.incompleteResults && !d.searchCapReached && !d.hasMore && d.rowsRead === d.reportedTotal && plan.pulls.length === d.rowsRead;
  if (d.coverage !== (complete ? 'all-reported-search-results-observed' : 'partial-search-results')) invalid('Inconsistent search coverage');
  if (d.stopReason === 'exhausted' && d.hasMore) invalid('Exhausted discovery cannot have more pages');
  if (d.stopReason === 'page-limit' && (d.pagesRead !== plan.filter.maxPages || !d.hasMore)) invalid('Inconsistent page limit');
  if (d.stopReason === 'pull-limit' && plan.pulls.length !== plan.filter.maxPulls) invalid('Inconsistent pull limit');
  const ids = new Set<number>();
  for (const [index, pull] of plan.pulls.entries()) {
    if (ids.has(pull.number) || !matchesHistoryFilter(pull, plan.filter) || pull.url.toLowerCase() !== `https://github.com/${plan.filter.repository}/pull/${pull.number}` || (index && historyOrder(plan.pulls[index - 1], pull) >= 0)) invalid('Invalid, duplicate, unsorted or out-of-filter PR');
    ids.add(pull.number);
  }
});
export type HistoryPlan = z.infer<typeof HistoryPlanSchema>;
export const HistoryPlanPackageSchema = z.object({ digest: DigestSchema, plan: HistoryPlanSchema,
  receipt: z.object({ kind: z.literal('package-integrity-only') }).strict(),
}).strict().refine(value => digestOf(value.plan) === value.digest, 'History plan digest mismatch');
export type HistoryPlanPackage = z.infer<typeof HistoryPlanPackageSchema>;
export function validateHistoryPlan(input: unknown): HistoryPlanPackage {
  if (Buffer.byteLength(JSON.stringify(input)) > HISTORY_MAX_JSON_BYTES) throw new Error('History plan exceeds 500KB');
  return HistoryPlanPackageSchema.parse(input);
}

/** One bounded, unauthenticated search. No PR bodies, capture, database, model, or queue work. */
export async function discoverGithubPrHistory(raw: z.input<typeof HistoryFilterSchema>, testing: { fetch?: typeof globalThis.fetch } = {}): Promise<HistoryPlanPackage> {
  const filter = HistoryFilterSchema.parse(raw);
  const client = new Octokit({ userAgent: 'FlyReWheel/0.1 read-only-history', ...(testing.fetch ? { request: { fetch: testing.fetch } } : {}) });
  client.hook.before('request', request => {
    if (request.method !== 'GET' || request.headers.authorization !== undefined) throw new Error('Only unauthenticated GitHub GET requests are allowed');
    request.headers['x-github-api-version'] = '2022-11-28';
  });
  const timestamp = (value: number) => new Date(value).toISOString().replace('.000Z', 'Z');
  // GitHub documents a single inclusive timestamp range; do not express the
  // intersection with repeated `created:` qualifiers (live search ignored it).
  // Convert whole-second [from, before) to [from, before - 1s], then still check
  // every returned row against the exact local filter.
  const q = `repo:${filter.repository} is:pr created:${timestamp(Date.parse(filter.createdFrom))}..${timestamp(Date.parse(filter.createdBefore) - 1000)}${filter.status === 'all' ? '' : ` is:${filter.status}`}`;
  const deadline = Date.now() + 30_000, rows: HistoryPull[] = [], ids = new Set<number>();
  let bytes = 0, total = -1, incompleteResults = false, hasMore = false, pagesRead = 0;
  let stopReason: HistoryPlan['discovery']['stopReason'] = 'page-limit';
  for (let page = 1; page <= filter.maxPages; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('GitHub history discovery exceeded its 30-second deadline');
    let response;
    try { response = await client.rest.search.issuesAndPullRequests({ q, sort: 'created', order: 'asc', per_page: HISTORY_PAGE_SIZE, page,
      request: { signal: AbortSignal.timeout(Math.min(10_000, remaining)), redirect: 'error' } }); }
    catch (error) { const status = (error as { status?: number }).status; throw new Error(`GitHub history search failed${status ? ` (HTTP ${status})` : ''}; no plan produced`); }
    if (Date.now() > deadline) throw new Error('GitHub history discovery exceeded its 30-second deadline');
    if (response.status !== 200) throw new Error('Unexpected GitHub search status');
    const responseBytes = Buffer.byteLength(JSON.stringify(response.data)); bytes += responseBytes;
    if (responseBytes > 2_000_000 || bytes > 4_000_000) throw new Error('GitHub history decoded-response byte budget exceeded');
    const data = z.object({ total_count: Count, incomplete_results: z.boolean(), items: z.array(z.unknown()).max(HISTORY_PAGE_SIZE) }).parse(response.data);
    if (total !== -1 && total !== data.total_count) throw new Error('GitHub history search total changed between pages; retry a narrower window');
    total = data.total_count; pagesRead++; incompleteResults ||= data.incomplete_results;
    for (const rawItem of data.items) {
      const item = z.object({ number: NumberId, html_url: z.string(), repository_url: z.string(), title: z.string(), created_at: Time, updated_at: Time,
        state: z.enum(['open', 'closed']), pull_request: z.object({ html_url: z.string(), merged_at: Time.nullable().optional() }) }).parse(rawItem);
      if (item.repository_url.toLowerCase() !== `https://api.github.com/repos/${filter.repository}` || item.pull_request.html_url !== item.html_url) throw new Error('Search result repository/PR identity mismatch');
      const pull = HistoryPullSchema.parse({ number: item.number, url: item.html_url, title: item.title, createdAt: item.created_at, updatedAt: item.updated_at, state: item.state, mergedAt: item.pull_request.merged_at ?? null });
      if (!matchesHistoryFilter(pull, filter) || pull.url.toLowerCase() !== `https://github.com/${filter.repository}/pull/${pull.number}`) throw new Error('Search returned an out-of-filter PR');
      if (ids.has(pull.number)) throw new Error('Duplicate PR across search pages; retry a narrower window');
      if (rows.length && Date.parse(rows.at(-1)!.createdAt) > Date.parse(pull.createdAt)) throw new Error('Search results are not creation-time ascending');
      ids.add(pull.number); rows.push(pull);
    }
    hasMore = /;\s*rel="next"/.test(String(response.headers.link ?? ''));
    if (hasMore && data.items.length !== HISTORY_PAGE_SIZE) throw new Error('Inconsistent search pagination');
    if (rows.length > total) throw new Error('Search result count exceeds reported total');
    if (rows.length >= filter.maxPulls) { stopReason = rows.length > filter.maxPulls || hasMore ? 'pull-limit' : 'exhausted'; break; }
    if (!hasMore) { stopReason = 'exhausted'; break; }
  }
  rows.sort(historyOrder);
  const pulls = rows.slice(0, filter.maxPulls), searchCapReached = total > 1000;
  const complete = !incompleteResults && !searchCapReached && !hasMore && rows.length === total && pulls.length === rows.length;
  const plan = HistoryPlanSchema.parse({ schemaVersion: 1, kind: 'github-pr-history-plan', filter, ordering: 'created-ascending-then-number', pulls,
    discovery: { observedAt: new Date().toISOString(), pagesRead, rowsRead: rows.length, reportedTotal: total, incompleteResults, searchCapReached, hasMore,
      stopReason, coverage: complete ? 'all-reported-search-results-observed' : 'partial-search-results', notes: [...HISTORY_NOTES] } });
  return validateHistoryPlan({ digest: digestOf(plan), plan, receipt: { kind: 'package-integrity-only' } });
}
