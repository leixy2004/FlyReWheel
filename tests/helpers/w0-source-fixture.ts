import { createHash } from 'node:crypto';
import { DEFAULT_SNAPSHOT_LIMITS, validateChangeSnapshot } from '../../src/change-snapshot.js';
import { validateGithubPrEvidence } from '../../src/github-pr-evidence.js';
import { digestOf } from '../../src/core/identity.js';

// All data below is authored synthetic test input in memory. A live-shaped declaration
// exercises consistency rules only; it is never a real acquisition artifact or saved dataset.
export function w0SourceFixture(number = 3035): any {
  const repository = 'encode/httpx', timestamp = '2026-10-03T00:00:00Z';
  const selected: Record<number, [string, string]> = {
    3035: ['2024-01-03T05:11:45Z', 'b871b4b8b29aca2e675645fae0c9f8e7d2a5e7d5'],
    3031: ['2024-01-03T05:14:26Z', 'ea3071642d12ed546d901861a5901da6fad37073'],
    3036: ['2024-01-03T05:36:16Z', 'f1ed7463086f0aed97afa61a1197c51840d3bb2e'],
  };
  if (!selected[number]) throw new Error('Synthetic fixture requires a selected W0 number');
  const [mergedAt, mergeCommit] = selected[number];
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
  result.evidence.receipt.observations = structuredClone(observations);
  result.evidence.receipt.requests = observations.length;
  return { ...result, sourceTrees: [result.license.treeObservation], acquisition: { maxGetRequests: 50, requests: observations.length, observations } };
}

