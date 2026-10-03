import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateW0SourcePackage, W0SourcePackageSchema } from '../scripts/validate-w0-source-package.js';
import { digestOf } from '../src/core/identity.js';
import { w0SourceFixture as fixture } from './helpers/w0-source-fixture.js';

function refreshObservation(value: any, observation: any) {
  const previous = observation.dataDigest;
  observation.dataDigest = digestOf(observation.data);
  for (const list of [value.acquisition.observations, value.evidence.receipt.observations])
    for (const row of list) if (row.endpoint === observation.endpoint && row.dataDigest === previous) row.dataDigest = observation.dataDigest;
}
function appendTree(value: any, sha: string, tree: any[]) {
  const data = { sha, truncated: false, tree };
  const observation = { endpoint: `GET /repos/encode/httpx/git/trees/${sha}`,
    observedAt: value.license.treeObservation.observedAt, dataDigest: digestOf(data), data };
  value.sourceTrees.push(observation);
  const { data: _body, ...event } = observation;
  value.acquisition.observations.push(structuredClone(event)); value.acquisition.requests++;
  value.evidence.receipt.observations.push(structuredClone(event)); value.evidence.receipt.requests++;
  return observation;
}
function nestedFixture() {
  const value = fixture(), bytes = Buffer.from('synthetic nested source\n');
  const objectId = execFileSync('git', ['hash-object', '--stdin'], { input: bytes, encoding: 'utf8', timeout: 5000 }).trim();
  const evidence = value.evidence.evidence;
  evidence.snapshot.changes = [{ status: 'A', before: { state: 'absent' }, after: { state: 'captured',
    path: 'pkg/file.py', mode: '100644', objectId, byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') } }];
  evidence.snapshot.coverage = { changedPaths: 1, capturedSides: 1, excludedSides: 0, capturedBytes: bytes.length, scope: 'changed-entries-only' };
  evidence.snapshotDigest = digestOf(evidence.snapshot);
  evidence.pull.reportedChangedFiles = 1; evidence.source.compareFileCount = 1;
  value.evidence.digest = digestOf(evidence);
  value.license.treeObservation.data.tree.push({ path: 'pkg', mode: '040000', type: 'tree', sha: '7'.repeat(40) });
  refreshObservation(value, value.license.treeObservation);
  appendTree(value, value.sourceIdentities.mergeBase.tree, []);
  const nestedTree = appendTree(value, '7'.repeat(40), [{ path: 'file.py', mode: '100644', type: 'blob', sha: objectId, size: bytes.length }]);
  return { value, nestedTree };
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
  value.evidence.receipt.observations.find((row: any) => row.dataDigest === previous).dataDigest = observation.dataDigest;
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

it('accepts a changed nested path with retained root-to-child trees and bound source bytes', () => {
  const { value } = nestedFixture();
  expect(() => validateW0SourcePackage(value)).not.toThrow();
});

it('rejects an unreachable retained source tree even when its response is included in both audits', () => {
  const value = fixture();
  appendTree(value, '8'.repeat(40), []);
  expect(() => validateW0SourcePackage(value)).toThrow('UNREACHABLE_SOURCE_TREE');
});

it('rejects changed source bytes that disagree with the reachable tree despite refreshed observation digests', () => {
  const { value, nestedTree } = nestedFixture();
  nestedTree.data.tree[0].sha = '8'.repeat(40);
  refreshObservation(value, nestedTree);
  expect(() => validateW0SourcePackage(value)).toThrow('SOURCE_BYTES_TREE_MISMATCH');
});
