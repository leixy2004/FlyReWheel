import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Fixed metadata-only read query. Never fetch source, discussions, labels or tokens.
const repository = 'encode/httpx';
const search = 'repo:encode/httpx is:pr is:merged merged:2024-01-01..2024-09-30 sort:created-asc';
const query = `query($search: String!, $cursor: String) {
  search(query: $search, type: ISSUE, first: 100, after: $cursor) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number mergedAt mergeCommit { oid tree { oid } parents(first: 100) { totalCount nodes { oid } } }
    } }
  }
}`;
const output = new URL('../experiments/temporal-pilot/httpx-2024-frame.json', import.meta.url);
const windows = [
  { id: 'W0', start: '2024-01-01T00:00:00Z', endExclusive: '2024-04-01T00:00:00Z' },
  { id: 'W1', start: '2024-04-01T00:00:00Z', endExclusive: '2024-07-01T00:00:00Z' },
  { id: 'W2', start: '2024-07-01T00:00:00Z', endExclusive: '2024-10-01T00:00:00Z' },
];
const frame = {
  schemaVersion: 1,
  kind: 'github_metadata_temporal_frame',
  repository,
  selection: { frozenBeforeAcquisition: true, rationale: 'Public Python HTTP client with bounded scope for later human annotation; not selected for known favorable outcomes.',
    rule: 'All merged PRs in the fixed interval, without content/outcome filtering.', windows },
  acquisition: { api: 'https://api.github.com/graphql', search, query,
    script: 'scripts/capture-temporal-frame.mjs',
    scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    startedAt: new Date().toISOString(), maxRequests: 10, requestTimeoutMs: 60000, requests: 0, pages: [] },
  status: 'incomplete', reportedCount: null, capturedCount: 0,
  windowCounts: Object.fromEntries(windows.map(w => [w.id, 0])), pullRequests: [],
  limitations: { identifiers: 'GitHub-declared merge metadata; no local commit/tree verification',
    historicalPublicAvailability: 'not_established', lineageIndependence: 'not_evaluated',
    sourceCapture: 'not_run', humanAnnotators: 'unassigned', independentLabels: 0,
    modelExecution: 'not_run', researchModelsAndBudgets: 'unconfigured',
    fullPilotPreregistration: false, efficacy: 'not_evaluated' },
};
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const seen = new Set(), cursors = new Set();
let cursor = null;
try {
  while (true) {
    if (frame.acquisition.requests >= frame.acquisition.maxRequests) fail('REQUEST_BUDGET_EXHAUSTED');
    frame.acquisition.requests++;
    const args = ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`, '-f', `search=${search}`];
    if (cursor !== null) args.push('-f', `cursor=${cursor}`);
    let payload;
    try {
      payload = JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 60000,
        maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (error) {
      // Inspect only error class indicators; do not emit raw CLI output or credentials.
      const stderr = String(error.stderr ?? '');
      fail(error.code === 'ETIMEDOUT' ? 'API_TIMEOUT' : /rate limit/i.test(stderr) ? 'API_RATE_LIMIT' :
        /401|403|authentication|not logged/i.test(stderr) ? 'API_AUTHORIZATION_FAILED' : 'API_REQUEST_FAILED');
    }
    if (payload.errors?.length) fail('GRAPHQL_ERRORS');
    const page = payload.data?.search;
    if (!page || !Number.isInteger(page.issueCount) || !Array.isArray(page.nodes) ||
      typeof page.pageInfo?.hasNextPage !== 'boolean') fail('INVALID_RESPONSE_SHAPE');
    if (page.issueCount > 1000) fail('SEARCH_RESULT_CEILING');
    if (frame.reportedCount !== null && frame.reportedCount !== page.issueCount) fail('COUNT_CHANGED_DURING_ACQUISITION');
    frame.reportedCount = page.issueCount;
    frame.acquisition.pages.push({ page: frame.acquisition.requests, reportedCount: page.issueCount,
      returnedCount: page.nodes.length, hasNextPage: page.pageInfo.hasNextPage });
    for (const pr of page.nodes) {
      if (!Number.isInteger(pr?.number) || pr.number < 1 || seen.has(pr.number)) fail('INVALID_OR_DUPLICATE_PR');
      const timestamp = typeof pr.mergedAt === 'string' ? Date.parse(pr.mergedAt) : NaN;
      const window = windows.find(w => timestamp >= Date.parse(w.start) && timestamp < Date.parse(w.endExclusive));
      if (!Number.isFinite(timestamp) || !window) fail('MERGE_TIMESTAMP_OUTSIDE_FRAME');
      const commit = pr.mergeCommit;
      if (!sha(commit?.oid) || !sha(commit?.tree?.oid) || !Number.isInteger(commit?.parents?.totalCount) ||
        !Array.isArray(commit?.parents?.nodes) || commit.parents.nodes.length !== commit.parents.totalCount ||
        !commit.parents.nodes.every(p => sha(p.oid))) fail('INCOMPLETE_MERGE_COMMIT_METADATA');
      seen.add(pr.number);
      frame.pullRequests.push({ number: pr.number, mergedAt: pr.mergedAt, window: window.id,
        mergeCommit: commit.oid, parents: commit.parents.nodes.map(p => p.oid), tree: commit.tree.oid });
      frame.windowCounts[window.id]++;
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) fail('INVALID_PAGINATION_CURSOR');
    cursors.add(cursor);
  }
  if (seen.size !== frame.reportedCount) fail('TOTAL_COUNT_MISMATCH');
  frame.status = 'complete';
} catch (error) {
  frame.status = 'failed';
  frame.failure = { code: typeof error.code === 'string' ? error.code : 'LOCAL_VALIDATION_FAILED',
    request: frame.acquisition.requests, partialFrameMustNotBeUsedAsComplete: true };
  process.exitCode = 1;
} finally {
  frame.pullRequests.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number);
  frame.capturedCount = frame.pullRequests.length;
  frame.acquisition.completedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(frame, null, 2) + '\n');
  console.log(JSON.stringify({ status: frame.status, repository, reportedCount: frame.reportedCount,
    capturedCount: frame.capturedCount, windowCounts: frame.windowCounts, requests: frame.acquisition.requests,
    failure: frame.failure ?? null, output: fileURLToPath(output) }));
}
