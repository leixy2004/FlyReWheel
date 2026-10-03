import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// This fixed audit re-queries W0 commit objects only, never PR content or source.
const framePath = 'experiments/temporal-pilot/httpx-2024-frame.json';
const expectedFrameSha256 = '07c1ded10a03002eed7b3f25d75c33e161876d72f71371b4cbfc1652022f477b';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fullOid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const bytes = await readFile(new URL(`../${framePath}`, import.meta.url));
const result = {
  schemaVersion: 1, kind: 'github_w0_commit_identity_verification',
  repository: 'encode/httpx', frame: { path: framePath, sha256: sha256(bytes),
    expectedSha256: expectedFrameSha256, sourceCommit: '973a9b7cccef1615b7e11ee1b9318965f9131a7f' },
  scope: { window: 'W0', expectedCount: 38, selection: 'All W0 members of the byte-pinned frame; no outcome filtering' },
  acquisition: { api: 'https://api.github.com/graphql', startedAt: new Date().toISOString(),
    script: 'scripts/verify-temporal-source-identities.mjs',
    scriptSha256: sha256(await readFile(new URL(import.meta.url))),
    maxRequests: 4, batchSize: 10, requestTimeoutMs: 60000, requests: 0, batches: [] },
  status: 'incomplete', checks: [],
  limitations: { evidence: 'Independent lookup of GitHub-declared commit metadata; same authority as the original frame',
    localGitObjectVerification: 'not_run', sourceCapture: 'not_run',
    historicalPublicAvailability: 'not_established', lineageIndependence: 'not_evaluated',
    w1AndW2Queries: 0, modelCalls: 0, efficacy: 'not_evaluated' },
};
try {
  if (result.frame.sha256 !== expectedFrameSha256) fail('FROZEN_FRAME_HASH_MISMATCH');
  const frame = JSON.parse(bytes);
  if (frame.repository !== result.repository || frame.status !== 'complete') fail('INVALID_FRAME');
  const members = frame.pullRequests.filter(pr => pr.window === 'W0');
  if (members.length !== 38 || new Set(members.map(pr => pr.number)).size !== 38 ||
      new Set(members.map(pr => pr.mergeCommit)).size !== 38) fail('W0_MEMBERSHIP_MISMATCH');
  for (const pr of members) {
    if (!Number.isInteger(pr.number) || pr.number < 1 || !fullOid(pr.mergeCommit) || !fullOid(pr.tree) ||
        !Array.isArray(pr.parents) || !pr.parents.every(fullOid) ||
        !(pr.mergedAt >= '2024-01-01T00:00:00Z' && pr.mergedAt < '2024-04-01T00:00:00Z')) fail('INVALID_W0_IDENTITY');
  }
  result.checks = members.map(pr => ({ number: pr.number, mergeCommit: pr.mergeCommit,
    expected: { tree: pr.tree, parents: pr.parents }, status: 'not_checked' }));
  for (let offset = 0; offset < members.length; offset += result.acquisition.batchSize) {
    if (result.acquisition.requests >= result.acquisition.maxRequests) fail('REQUEST_BUDGET_EXHAUSTED');
    const batch = members.slice(offset, offset + result.acquisition.batchSize);
    const query = `query { repository(owner: "encode", name: "httpx") {\n${batch.map((pr, index) =>
      `c${index}: object(oid: "${pr.mergeCommit}") { ... on Commit { oid tree { oid } parents(first: 100) { totalCount pageInfo { hasNextPage } nodes { oid } } } }`).join('\n')}\n} }`;
    const audit = { request: ++result.acquisition.requests, numbers: batch.map(pr => pr.number), query,
      startedAt: new Date().toISOString(), status: 'started' };
    result.acquisition.batches.push(audit);
    let payload;
    try {
      payload = JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (error) {
      const stderr = String(error.stderr ?? '');
      audit.status = 'failed';
      fail(error.code === 'ETIMEDOUT' ? 'API_TIMEOUT' : /rate limit/i.test(stderr) ? 'API_RATE_LIMIT' :
        /401|403|authentication|not logged/i.test(stderr) ? 'API_AUTHORIZATION_FAILED' : 'API_REQUEST_FAILED');
    }
    if (payload.errors?.length) fail('GRAPHQL_ERRORS');
    if (!payload.data?.repository) fail('MISSING_REPOSITORY');
    for (let index = 0; index < batch.length; index++) {
      const check = result.checks[offset + index];
      const commit = payload.data.repository[`c${index}`];
      if (!fullOid(commit?.oid) || !fullOid(commit?.tree?.oid) ||
          !Number.isInteger(commit?.parents?.totalCount) || !Array.isArray(commit?.parents?.nodes) ||
          commit.parents.pageInfo?.hasNextPage !== false || commit.parents.totalCount !== commit.parents.nodes.length ||
          !commit.parents.nodes.every(parent => fullOid(parent.oid))) {
        check.status = 'invalid_or_incomplete_response';
        continue;
      }
      check.observed = { oid: commit.oid, tree: commit.tree.oid, parents: commit.parents.nodes.map(parent => parent.oid) };
      check.status = commit.oid === check.mergeCommit && commit.tree.oid === check.expected.tree &&
        JSON.stringify(check.observed.parents) === JSON.stringify(check.expected.parents) ? 'match' : 'mismatch';
    }
    audit.status = 'complete';
    audit.completedAt = new Date().toISOString();
  }
  if (result.checks.some(check => check.status !== 'match')) fail('IDENTITY_VERIFICATION_FAILED');
  result.status = 'complete';
} catch (error) {
  result.status = 'failed';
  result.failure = { code: typeof error.code === 'string' ? error.code : 'LOCAL_VALIDATION_FAILED' };
  process.exitCode = 1;
} finally {
  result.acquisition.completedAt = new Date().toISOString();
  result.summary = { selected: result.checks.length, matched: result.checks.filter(c => c.status === 'match').length,
    mismatched: result.checks.filter(c => c.status === 'mismatch').length,
    invalid: result.checks.filter(c => c.status === 'invalid_or_incomplete_response').length,
    notChecked: result.checks.filter(c => c.status === 'not_checked').length };
  await writeFile(new URL('../experiments/temporal-pilot/source-identity-verification.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, requests: result.acquisition.requests, ...result.summary,
    failure: result.failure?.code }));
}
