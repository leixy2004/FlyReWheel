import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { validateW0SourcePackage, W0SourcePackageSchema } from '../scripts/validate-w0-source-package.js';
import { DEFAULT_SNAPSHOT_LIMITS, validateChangeSnapshot } from '../src/change-snapshot.js';
import { validateGithubPrEvidence } from '../src/github-pr-evidence.js';
import { digestOf } from '../src/core/identity.js';

// All data below is authored synthetic test input in memory. A live-shaped declaration
// exercises consistency rules only; it is never a real acquisition artifact or saved dataset.
function fixture(): any {
  const number = 3035, repository = 'encode/httpx', timestamp = '2026-10-03T00:00:00Z';
  const mergedAt = '2024-01-03T05:11:45Z', mergeCommit = 'b871b4b8b29aca2e675645fae0c9f8e7d2a5e7d5';
  const baseTip = '1'.repeat(40), mergeBase = '2'.repeat(40), head = '3'.repeat(40), url = `https://github.com/${repository}/pull/${number}`;
  const snapshot = validateChangeSnapshot({ schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: `github:${repository}`, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip, mergeBase, head, comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    prMetadata: { verification: 'caller-supplied-unverified', provider: 'github', repository, number, url }, changes: [],
    coverage: { changedPaths: 0, capturedSides: 0, excludedSides: 0, capturedBytes: 0, scope: 'changed-entries-only' } });
  const evidence = validateGithubPrEvidence({ schemaVersion: 1, kind: 'github-pr-evidence', snapshotDigest: snapshot.digest, snapshot: snapshot.snapshot,
    pull: { id: number, number, repository, url, title: 'SYNTHETIC TEST ONLY', body: null, author: null,
      state: 'closed', draft: false, merged: true, createdAt: mergedAt, updatedAt: mergedAt, closedAt: mergedAt, mergedAt,
      baseRef: 'main', baseTip, headRef: 'fixture', head, headRepository: repository, mergeCommit,
      reportedChangedFiles: 0, reportedIssueComments: 0, reportedReviewComments: 0 },
    source: { provider: 'github', apiOrigin: 'https://api.github.com', observation: 'current-api-state', historicalReviewCheckpoint: false,
      ancestry: 'provider-declared', inventory: 'provider-declared-compare', repositoryContext: 'changed-paths-only',
      discussionConsistency: 'non-atomic-current-observation', discussionCoverage: 'all-pages-returned-within-limits', compareFileCount: 0,
      sourceStatements: 'untrusted-not-ground-truth-or-feedback' }, discussions: { issueComments: [], reviews: [], reviewComments: [] } });
  const prefix = 'GET /repos/encode/httpx';
  const observation = (endpoint: string, data: object) => ({ endpoint, observedAt: timestamp, dataDigest: digestOf(data), data });
  const identity = (commit: string, tree: string) => ({ commit, tree, observation: observation(`${prefix}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } }) });
  const sourceIdentities = { baseTip: { ...identity(baseTip, '4'.repeat(40)), role: 'current-tip-metadata-only-not-source' },
    mergeBase: identity(mergeBase, '5'.repeat(40)), head: identity(head, '6'.repeat(40)) };
  const text = 'SYNTHETIC LICENSE FIXTURE: no real license rights established.\n', bytes = Buffer.from(text);
  const blobSha1 = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const path = 'LICENSE.md';
  const result = { schemaVersion: 1, kind: 'w0-source-package', provenance: 'live-api-observation',
    planSha256: '9b024e81a3886794d4b50fb44767cd53a10a794ffbaf881e4305c6cfd648898a',
    evidence: { ...evidence, receipt: { kind: 'github-api-observation', startedAt: timestamp, completedAt: timestamp,
      authentication: 'none', transport: '@octokit/rest@22.0.1', verification: 'live-api-observation-not-verified-history',
      requestLimit: 50, requests: 1, decodedResponseBytes: 0, observations: [{ endpoint: `${prefix}/pulls/${number}`, observedAt: timestamp, dataDigest: digestOf({}) }] } },
    sourceIdentities, license: { sourceRef: head, path, text, blobSha1, sha256: createHash('sha256').update(bytes).digest('hex'),
      observation: observation(`${prefix}/contents/${path}?ref=${head}`, { type: 'file', path, sha: blobSha1, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }),
      treeObservation: observation(`${prefix}/git/trees/${sourceIdentities.head.tree}`, { sha: sourceIdentities.head.tree, truncated: false,
        tree: [{ path, mode: '100644', type: 'blob', sha: blobSha1, size: bytes.length }] }) } };
  const observations = [...result.evidence.receipt.observations, ...Object.values(sourceIdentities).map(identity => identity.observation),
    result.license.observation, result.license.treeObservation].map(({ endpoint, observedAt, dataDigest }) => ({ endpoint, observedAt, dataDigest }));
  return { ...result, acquisition: { maxGetRequests: 50, requests: observations.length, observations } };
}

it('checks synthetic live-shaped consistency without certifying authenticity, history or license rights', () => {
  const value = fixture();
  expect(W0SourcePackageSchema.safeParse(value).success).toBe(true);
  expect(validateW0SourcePackage(value)).toMatchObject({ status: 'offline_source_package_consistency_pass',
    authenticity: 'declared_live_observation_not_independently_authenticated', historicalW0Feedback: false,
    historicalSourceAvailability: 'not_established', licenseInterpretation: 'not_performed', publicationAllowed: false, evaluationReady: false });
});

it('independently matches Git blob hashing with git hash-object rather than sharing an implementation assumption', () => {
  const value = fixture();
  const expected = execFileSync('git', ['hash-object', '--stdin'], { input: Buffer.from(value.license.text), encoding: 'utf8', timeout: 5000 }).trim();
  expect(value.license.blobSha1).toBe(expected);
  expect(() => validateW0SourcePackage(value)).not.toThrow();
});

it('accepts GitHub base64 with actual newline wrapping', () => {
  const value = fixture(), observation = value.license.observation, previous = observation.dataDigest;
  observation.data.content = observation.data.content.match(/.{1,20}/g).join('\n') + '\n';
  observation.dataDigest = digestOf(observation.data);
  value.acquisition.observations.find((row: any) => row.dataDigest === previous).dataDigest = observation.dataDigest;
  expect(() => validateW0SourcePackage(value)).not.toThrow();
});

it('counts duplicate receipt events as separate requests even with identical timestamp and digest', () => {
  const value = fixture();
  value.evidence.receipt.observations.push(structuredClone(value.evidence.receipt.observations[0]));
  value.evidence.receipt.requests++;
  expect(() => validateW0SourcePackage(value)).toThrow('CAPTURE_OBSERVATION_UNACCOUNTED');
  value.acquisition.observations.push(structuredClone(value.acquisition.observations[0]));
  value.acquisition.requests++;
  expect(() => validateW0SourcePackage(value)).not.toThrow();
});

it.each([
  ['explicit synthetic provenance', (v: any) => { v.provenance = 'synthetic'; }],
  ['import-only receipt', (v: any) => { v.evidence.receipt = { kind: 'package-integrity-only' }; }],
  ['missing license', (v: any) => { delete v.license; }],
  ['unknown license', (v: any) => { v.license = 'unknown'; }],
  ['missing root identity', (v: any) => { delete v.sourceIdentities.head.tree; }],
  ['missing root tree observation', (v: any) => { delete v.license.treeObservation; }],
  ['SHA256 drift', (v: any) => { v.license.sha256 = '0'.repeat(64); }],
  ['Git blob drift', (v: any) => { v.license.blobSha1 = '7'.repeat(40); }],
  ['license current-tip ref', (v: any) => { v.license.sourceRef = v.sourceIdentities.baseTip.commit; }],
  ['baseTip confused with mergeBase', (v: any) => { v.sourceIdentities.mergeBase = v.sourceIdentities.baseTip; }],
  ['baseTip source role', (v: any) => { v.sourceIdentities.baseTip.role = 'source'; }],
  ['API tree disagreement', (v: any) => { v.sourceIdentities.head.observation.data.tree.sha = '7'.repeat(40); v.sourceIdentities.head.observation.dataDigest = digestOf(v.sourceIdentities.head.observation.data); }],
  ['tree blob disagreement', (v: any) => { v.license.treeObservation.data.tree[0].sha = '7'.repeat(40); v.license.treeObservation.dataDigest = digestOf(v.license.treeObservation.data); }],
  ['unbound API response', (v: any) => { v.license.observation.data.size++; }],
  ['unpinned contents endpoint', (v: any) => { v.license.observation.endpoint = 'GET /repos/encode/httpx/contents/LICENSE.md'; }],
  ['over-budget acquisition', (v: any) => { v.acquisition.requests = 51; }],
  ['unaccounted sidecar', (v: any) => { v.acquisition.observations.pop(); v.acquisition.requests--; }],
  ['unaccounted capture', (v: any) => { v.acquisition.observations.shift(); v.acquisition.requests--; }],
  ['W2 endpoint', (v: any) => { v.acquisition.observations.push({ ...v.acquisition.observations[0], endpoint: 'GET /repos/encode/httpx/pulls/3245' }); v.acquisition.requests++; }],
] as const)('rejects %s', (_name, mutate) => {
  const value = fixture(); mutate(value);
  expect(() => validateW0SourcePackage(value)).toThrow();
});

it.each(['2024-04-06T06:30:16Z', '2024-07-23T14:43:47Z'])('rejects W1/W2 merge date %s even with a refreshed evidence digest', mergedAt => {
  const value = fixture(); value.evidence.evidence.pull.mergedAt = mergedAt;
  value.evidence.digest = digestOf(value.evidence.evidence);
  expect(() => validateW0SourcePackage(value)).toThrow('NOT_FROZEN_W0_MEMBER');
});
