import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGithubReadFailure, githubHttpFailureDiagnostic } from '../src/github-pr-diagnostics.js';

const endpoint = 'GET /repos/encode/httpx/pulls/3035';
const own = (value: unknown, key: string): unknown => value !== null && typeof value === 'object'
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const names = new Set(['HttpError', 'Error', 'TypeError', 'AggregateError', 'AbortError', 'TimeoutError']);
export function safeErrorChain(error: unknown) {
  const chain: { name?: string; code?: string }[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== null && typeof current === 'object' && depth < 3; depth++) {
    const rawName = own(current, 'name');
    const name = typeof rawName === 'string' && names.has(rawName) ? rawName :
      current instanceof TypeError ? 'TypeError' : current instanceof Error ? 'Error' : undefined;
    const { code } = classifyGithubReadFailure({ code: own(current, 'code') });
    chain.push({ ...(name ? { name } : {}), ...(code ? { code } : {}) });
    current = own(current, 'cause');
  }
  return chain;
}

/** One fixed metadata GET only. fetch is for offline tests, never a fallback route. */
export async function diagnoseW0FirstRead(testing: { fetch?: typeof globalThis.fetch; priorRequests?: number } = {}) {
  const priorRequests = testing.priorRequests ?? 1;
  if (!Number.isInteger(priorRequests) || priorRequests < 0 || priorRequests >= 50) throw new Error('INVALID_PRIOR_REQUESTS');
  const startedAt = new Date().toISOString();
  const client = new Octokit({ userAgent: 'FlyReWheel/0.1 read-only-evidence',
    // Suppress SDK free-text logging; only the returned allowlisted record is retained.
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...(testing.fetch ? { request: { fetch: testing.fetch } } : {}) });
  let requests = 0;
  client.hook.before('request', request => {
    if (requests || request.method !== 'GET' || request.headers.authorization !== undefined ||
      request.url !== '/repos/{owner}/{repo}/pulls/{pull_number}' || request.owner !== 'encode' ||
      request.repo !== 'httpx' || request.pull_number !== 3035) throw new Error('DIAGNOSTIC_REQUEST_SCOPE');
    requests++;
    request.headers['x-github-api-version'] = '2022-11-28';
  });
  const base = { schemaVersion: 1, kind: 'w0_single_get_diagnostic', endpoint,
    transport: '@octokit/rest@22.0.1', authentication: 'none', startedAt,
    originalRunRequests: priorRequests, requestBudget: 50, automaticRetries: 0,
    sourceProducer: 'implemented_offline_verified', realSourcePackages: 0,
    sourceOrDiscussionFollowupRequests: 0, modelCalls: 0 };
  try {
    const response = await client.rest.pulls.get({ owner: 'encode', repo: 'httpx', pull_number: 3035,
      request: { signal: AbortSignal.timeout(15000), redirect: 'error' } });
    const pr = response.data;
    const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
    const matches = pr.number === 3035 && pr.base?.repo?.full_name === 'encode/httpx' && pr.base.repo.private === false &&
      pr.merged === true && pr.merged_at === '2024-01-03T05:11:45Z' &&
      pr.merge_commit_sha === 'b871b4b8b29aca2e675645fae0c9f8e7d2a5e7d5' && sha(pr.base.sha) && sha(pr.head?.sha);
    return { ...base, completedAt: new Date().toISOString(), requests, totalRequestsUsed: priorRequests + requests,
      status: response.status === 200 && matches ? 'success' : 'identity_or_status_mismatch', httpStatus: response.status,
      ...(matches ? { identity: { repository: 'encode/httpx', number: 3035, mergedAt: pr.merged_at,
        mergeCommit: pr.merge_commit_sha, baseTip: pr.base.sha, head: pr.head.sha, verification: 'provider_declared_metadata_only' } } : {}) };
  } catch (error) {
    const diagnostic = githubHttpFailureDiagnostic(error);
    return { ...base, completedAt: new Date().toISOString(), requests, totalRequestsUsed: priorRequests + requests,
      status: 'failed', httpStatus: diagnostic?.status ?? null,
      ...(diagnostic ? { diagnostic } : {}), classification: classifyGithubReadFailure(error, diagnostic), errorChain: safeErrorChain(error) };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute-one-get') throw new Error('REQUIRE_EXECUTE_ONE_GET');
  const directory = new URL('../experiments/temporal-pilot/w0-first-three/', import.meta.url);
  const previousBytes = await readFile(new URL('capture-run/run.json', directory));
  const previous = JSON.parse(previousBytes.toString('utf8'));
  if (previous.requests !== 1 || previous.status !== 'stopped' || previous.items[0]?.number !== 3035 ||
    previous.items[0]?.status !== 'failed') throw new Error('ORIGINAL_RUN_ACCOUNTING_MISMATCH');
  const destination = new URL('single-get-diagnostic.json', directory);
  // Reserve the attempt before any upstream request; even interruption cannot silently retry it.
  const handle = await open(destination, 'wx', 0o600);
  try {
    const inProgress = { status: 'reserved', originalRunRequests: 1, reservedGetRequests: 1,
      totalRequestsReserved: 2, requestBudget: 50, endpoint, realSourcePackages: 0 };
    await handle.writeFile(JSON.stringify(inProgress, null, 2) + '\n');
    await handle.sync();
    const result = { ...await diagnoseW0FirstRead(),
      originalRunSha256: createHash('sha256').update(previousBytes).digest('hex') };
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'success') process.exitCode = 1;
  } finally { await handle.close(); }
}
