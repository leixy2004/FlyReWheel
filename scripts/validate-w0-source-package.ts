import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digestOf } from '../src/core/identity.js';
import { GithubAcquisitionReceiptSchema, GithubPrEvidencePackageSchema, GithubSha } from '../src/github-pr-evidence.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Observation = z.object({
  endpoint: z.string().min(1).max(2048), observedAt: z.string().datetime(), dataDigest: Digest,
  data: z.record(z.string(), z.unknown()),
}).strict();
const AuditObservation = Observation.omit({ data: true });
const Identity = z.object({ commit: GithubSha, tree: GithubSha, observation: Observation }).strict();
export const W0SourcePackageSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('w0-source-package'),
  provenance: z.literal('live-api-observation'),
  planSha256: z.literal('9b024e81a3886794d4b50fb44767cd53a10a794ffbaf881e4305c6cfd648898a'),
  evidence: GithubPrEvidencePackageSchema,
  acquisition: z.object({ maxGetRequests: z.literal(50), requests: z.number().int().min(1).max(50),
    observations: z.array(AuditObservation).min(1).max(50) }).strict(),
  sourceIdentities: z.object({ baseTip: Identity.extend({ role: z.literal('current-tip-metadata-only-not-source') }).strict(),
    mergeBase: Identity, head: Identity }).strict(),
  sourceTrees: z.array(Observation).max(50).default([]),
  license: z.object({
    sourceRef: GithubSha,
    // Version 1 supports a root license only: its membership is proved by one complete root tree response.
    path: z.string().regex(/^(?:LICENSE|LICENCE|COPYING)(?:[._-][A-Za-z0-9._-]+)?$/i),
    text: z.string().min(1).max(262_144), blobSha1: GithubSha, sha256: Digest,
    observation: Observation, treeObservation: Observation,
  }).strict(),
}).strict();

const selected = [
  { number: 3035, mergedAt: '2024-01-03T05:11:45Z', mergeCommit: 'b871b4b8b29aca2e675645fae0c9f8e7d2a5e7d5' },
  { number: 3031, mergedAt: '2024-01-03T05:14:26Z', mergeCommit: 'ea3071642d12ed546d901861a5901da6fad37073' },
  { number: 3036, mergedAt: '2024-01-03T05:36:16Z', mergeCommit: 'f1ed7463086f0aed97afa61a1197c51840d3bb2e' },
];
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Offline consistency check of declared live observations. It cannot authenticate an invented API response. */
export function validateW0SourcePackage(input: unknown) {
  const value = W0SourcePackageSchema.parse(input);
  const evidence = value.evidence.evidence, pull = evidence.pull;
  const expected = selected.find(row => row.number === pull.number);
  check(expected && pull.repository === 'encode/httpx' && pull.merged && pull.mergedAt === expected.mergedAt &&
    pull.mergeCommit === expected.mergeCommit, 'NOT_FROZEN_W0_MEMBER');
  // Imported/integrity-only and explicitly synthetic evidence cannot be promoted to live acquisition.
  const receipt = GithubAcquisitionReceiptSchema.parse(value.evidence.receipt);
  const prefix = 'GET /repos/encode/httpx';
  const audit = value.acquisition;
  check(audit.requests === audit.observations.length, 'ACQUISITION_COUNT_MISMATCH');
  const auditKey = (observation: z.infer<typeof AuditObservation>) => digestOf({ endpoint: observation.endpoint,
    observedAt: observation.observedAt, dataDigest: observation.dataDigest });
  const audited = new Set(audit.observations.map(auditKey));
  const available = new Map<string, number>();
  for (const observation of audit.observations) {
    const key = auditKey(observation); available.set(key, (available.get(key) ?? 0) + 1);
  }
  for (const observation of receipt.observations) {
    const key = auditKey(observation), count = available.get(key) ?? 0;
    check(count > 0, 'CAPTURE_OBSERVATION_UNACCOUNTED'); available.set(key, count - 1);
  }
  const allowed = new Set([`${prefix}/pulls/${pull.number}`,
    `${prefix}/compare/${evidence.snapshot.baseTip}...${evidence.snapshot.head}?page=1&per_page=1`,
    `${prefix}/contents/${encodeURIComponent(value.license.path)}?ref=${value.license.sourceRef}`]);
  for (const [name, identity] of Object.entries(value.sourceIdentities)) {
    allowed.add(`${prefix}/git/commits/${identity.commit}`);
    if (name !== 'baseTip') allowed.add(`${prefix}/git/trees/${identity.tree}`);
  }
  for (const change of evidence.snapshot.changes) for (const side of [change.before, change.after])
    if (side.state !== 'absent') allowed.add(`${prefix}/git/blobs/${side.objectId}`);
  for (let page = 1; page <= 3; page++) for (const path of [`issues/${pull.number}/comments`, `pulls/${pull.number}/reviews`, `pulls/${pull.number}/comments`])
    allowed.add(`${prefix}/${path}?page=${page}&per_page=100`);
  const observe = (observation: z.infer<typeof Observation>, endpoint: string) => {
    check(audited.has(auditKey(observation)), 'SIDECAR_OBSERVATION_UNACCOUNTED');
    check(observation.endpoint === endpoint, 'OBSERVATION_ENDPOINT_MISMATCH');
    check(digestOf(observation.data) === observation.dataDigest, 'OBSERVATION_DIGEST_MISMATCH');
    return observation.data;
  };
  for (const [name, commit] of [['baseTip', evidence.snapshot.baseTip], ['mergeBase', evidence.snapshot.mergeBase], ['head', evidence.snapshot.head]] as const) {
    const identity = value.sourceIdentities[name];
    check(identity.commit === commit, 'SOURCE_COMMIT_MISMATCH');
    const data = observe(identity.observation, `${prefix}/git/commits/${commit}`);
    const parsed = z.object({ sha: GithubSha, tree: z.object({ sha: GithubSha }).passthrough() }).passthrough().parse(data);
    check(parsed.sha === commit && parsed.tree.sha === identity.tree, 'SOURCE_TREE_IDENTITY_MISMATCH');
  }
  const license = value.license;
  check(license.sourceRef === evidence.snapshot.head, 'LICENSE_NOT_PINNED_TO_SELECTED_HEAD');
  const bytes = Buffer.from(license.text, 'utf8');
  check(bytes.length > 0 && bytes.length <= 262_144 && license.text.trim().length > 0 &&
    !bytes.includes(0) && bytes.toString('utf8') === license.text, 'LICENSE_TEXT_INVALID');
  check(gitBlob(bytes) === license.blobSha1 && sha256(bytes) === license.sha256, 'LICENSE_BYTE_IDENTITY_MISMATCH');
  const raw = observe(license.observation, `${prefix}/contents/${encodeURIComponent(license.path)}?ref=${license.sourceRef}`);
  const content = z.object({ type: z.literal('file'), path: z.string(), sha: GithubSha,
    size: z.number().int().nonnegative(), encoding: z.literal('base64'), content: z.string() }).passthrough().parse(raw);
  const encoded = content.content.replace(/\n/g, '');
  const decoded = Buffer.from(encoded, 'base64');
  check(content.path === license.path && content.sha === license.blobSha1 && content.size === bytes.length &&
    decoded.toString('base64') === encoded && decoded.equals(bytes), 'LICENSE_API_CONTENT_MISMATCH');
  const root = value.sourceIdentities.head.tree;
  const tree = z.object({ sha: GithubSha, truncated: z.literal(false), tree: z.array(z.object({
    path: z.string().min(1), mode: z.string(), type: z.string(), sha: GithubSha, size: z.number().int().nonnegative().optional(),
  }).passthrough()).max(10_000) }).passthrough().parse(observe(license.treeObservation, `${prefix}/git/trees/${root}`));
  check(tree.sha === root && tree.tree.every(entry => !entry.path.includes('/')) &&
    new Set(tree.tree.map(entry => entry.path)).size === tree.tree.length, 'LICENSE_ROOT_TREE_INVALID');
  const entry = tree.tree.find(entry => entry.path === license.path);
  check(entry && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) &&
    entry.sha === license.blobSha1 && entry.size === bytes.length, 'LICENSE_TREE_ENTRY_MISMATCH');
  // Retained nonrecursive trees must be reachable from the comparison roots.
  // Merely naming a tree SHA in an audit must never authorize arbitrary source trees.
  const retained = new Map<string, typeof tree>();
  for (const observation of [...value.sourceTrees, license.treeObservation]) {
    const data = z.object({ sha: GithubSha, truncated: z.literal(false), tree: z.array(z.object({
      path: z.string().min(1), mode: z.string(), type: z.string(), sha: GithubSha,
      size: z.number().int().nonnegative().optional(),
    }).passthrough()).max(10_000) }).passthrough().parse(observation.data);
    observe(observation, `${prefix}/git/trees/${data.sha}`);
    check(data.tree.every(entry => !entry.path.includes('/') && !['.', '..'].includes(entry.path)) &&
      new Set(data.tree.map(entry => entry.path)).size === data.tree.length, 'SOURCE_TREE_INVALID');
    check(!retained.has(data.sha) || digestOf(retained.get(data.sha)) === digestOf(data), 'CONFLICTING_SOURCE_TREE');
    retained.set(data.sha, data);
  }
  const reachable = new Set([value.sourceIdentities.mergeBase.tree, value.sourceIdentities.head.tree]);
  const queue = [...reachable];
  for (let i = 0; i < queue.length; i++) for (const entry of retained.get(queue[i])?.tree ?? []) {
    if (entry.type === 'tree' && entry.mode === '040000' && !reachable.has(entry.sha)) {
      reachable.add(entry.sha); queue.push(entry.sha);
    }
  }
  for (const sha of retained.keys()) {
    check(reachable.has(sha), 'UNREACHABLE_SOURCE_TREE');
    allowed.add(`${prefix}/git/trees/${sha}`);
  }
  const atPath = (root: string, path: string) => {
    let sha = root;
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      const branch = retained.get(sha);
      check(branch, 'MISSING_SOURCE_PATH_TREE');
      const found = branch.tree.find(entry => entry.path === part);
      if (!found) return undefined;
      if (index === parts.length - 1) return found;
      if (found.type !== 'tree' || found.mode !== '040000') return undefined;
      sha = found.sha;
    }
    return undefined;
  };
  for (const change of evidence.snapshot.changes) for (const which of ['before', 'after'] as const) {
    const side = change[which], other = change[which === 'before' ? 'after' : 'before'];
    const path = side.state === 'absent' ? (other.state === 'absent' ? undefined : other.path) : side.path;
    check(path, 'MISSING_SOURCE_PATH');
    const root = value.sourceIdentities[which === 'before' ? 'mergeBase' : 'head'].tree;
    const entry = atPath(root, path);
    if (side.state === 'absent') check(!entry, 'ABSENT_SOURCE_PRESENT_IN_TREE');
    else check(entry && entry.sha === side.objectId && entry.mode === side.mode &&
      entry.type === (side.mode === '160000' ? 'commit' : 'blob') &&
      (side.mode === '160000' || entry.size === side.byteLength), 'SOURCE_BYTES_TREE_MISMATCH');
  }
  for (const observation of audit.observations) check(allowed.has(observation.endpoint), 'ACQUISITION_ENDPOINT_OUTSIDE_PACKAGE');
  return { status: 'offline_source_package_consistency_pass' as const, repository: pull.repository, number: pull.number,
    provenance: value.provenance, evidenceDigest: value.evidence.digest, snapshotDigest: evidence.snapshotDigest,
    sourceIdentities: { baseTip: { commit: value.sourceIdentities.baseTip.commit, tree: value.sourceIdentities.baseTip.tree,
      role: value.sourceIdentities.baseTip.role }, mergeBase: { commit: value.sourceIdentities.mergeBase.commit, tree: value.sourceIdentities.mergeBase.tree },
      head: { commit: value.sourceIdentities.head.commit, tree: value.sourceIdentities.head.tree } },
    license: { sourceRef: license.sourceRef, path: license.path, blobSha1: license.blobSha1, sha256: license.sha256 },
    historicalW0Feedback: false, historicalSourceAvailability: 'not_established', authenticity: 'declared_live_observation_not_independently_authenticated',
    acquisition: { requests: audit.requests, maxGetRequests: audit.maxGetRequests,
      verification: 'recorded_observation_consistency_not_independent_network_audit', crossPackageRunBudget: 'not_established',
      scope: 'single_pr_known_commits_reachable_source_trees_and_changed_blobs' },
    syntheticDetection: 'explicit_synthetic_or_integrity_only_rejected_forged_live_claim_not_detectable_offline',
    licenseInterpretation: 'not_performed', licenseCoverageOfBeforeSource: 'unknown', publicationAllowed: false,
    mining: 'not_run', evaluationReady: false };
}
