import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { runW0Capture } from '../scripts/capture-w0-first-three.js';
import { GithubReadError } from '../src/github-pr-diagnostics.js';
import { DEFAULT_SNAPSHOT_LIMITS, integrityReceipt, validateChangeSnapshot } from '../src/change-snapshot.js';
import { validateGithubPrEvidence } from '../src/github-pr-evidence.js';

const plan = JSON.parse(readFileSync(new URL('../experiments/temporal-pilot/w0-first-three/selection.json', import.meta.url), 'utf8'));
function fixture(number: number) {
  const row = plan.selected.find((p: any) => p.number === number);
  const base = row.parents[0], head = row.mergeCommit, repository = plan.repository;
  const url = `https://github.com/${repository}/pull/${number}`;
  const stored = validateChangeSnapshot({ schemaVersion: 1, kind: 'git-change-snapshot',
    repository: { id: `github:${repository}`, identityVerification: 'caller-supplied-unverified', objectFormat: 'sha1' },
    baseTip: base, mergeBase: base, head, comparison: 'merge-base-to-head', renamePolicy: 'exact-content-only', limits: DEFAULT_SNAPSHOT_LIMITS,
    prMetadata: { verification: 'caller-supplied-unverified', provider: 'github', repository, number, url },
    changes: [], coverage: { changedPaths: 0, capturedSides: 0, excludedSides: 0, capturedBytes: 0, scope: 'changed-entries-only' } });
  return { ...validateGithubPrEvidence({ schemaVersion: 1, kind: 'github-pr-evidence', snapshotDigest: stored.digest, snapshot: stored.snapshot,
    pull: { id: number, number, repository, url, title: 'Authored offline zero-change fixture', body: null, author: null,
      state: 'closed', draft: false, merged: true, createdAt: row.mergedAt, updatedAt: row.mergedAt, closedAt: row.mergedAt, mergedAt: row.mergedAt,
      baseRef: 'main', baseTip: base, headRef: 'topic', head, headRepository: repository, mergeCommit: row.mergeCommit,
      reportedChangedFiles: 0, reportedIssueComments: 0, reportedReviewComments: 0 },
    source: { provider: 'github', apiOrigin: 'https://api.github.com', observation: 'current-api-state', historicalReviewCheckpoint: false,
      ancestry: 'provider-declared', inventory: 'provider-declared-compare', repositoryContext: 'changed-paths-only',
      discussionConsistency: 'non-atomic-current-observation', discussionCoverage: 'all-pages-returned-within-limits', compareFileCount: 0,
      sourceStatements: 'untrusted-not-ground-truth-or-feedback' }, discussions: { issueComments: [], reviews: [], reviewComments: [] } }), receipt: integrityReceipt };
}

it.each([401, 403, 429, 404])('stops the entire selection after HTTP %s, retaining unattempted rows', async status => {
  const capture = vi.fn(async (_input: any, { budget }: any) => {
    budget.requestsRemaining--;
    throw new GithubReadError('GET /repos/encode/httpx/pulls/3035', { status });
  });
  const { summary, packages } = await runW0Capture(plan, capture as any);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(summary.items.map((p: any) => p.status)).toEqual(['failed', 'unattempted', 'unattempted']);
  expect(summary.requests).toBe(1);
  expect(packages).toHaveLength(0);
});

it('rejects W1 selection and an expanded budget before the collector is called', async () => {
  for (const mutate of [(p: any) => { p.selected[0].window = 'W1'; }, (p: any) => { p.budget.maxGetRequests = 51; }]) {
    const copy = structuredClone(plan); mutate(copy);
    const capture = vi.fn();
    await expect(runW0Capture(copy, capture)).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  }
});

it('retains authored zero-change successes in frozen order without claiming mining', async () => {
  const order: number[] = [];
  const capture = async ({ number }: any, { budget }: any) => { order.push(number); budget.requestsRemaining--; return fixture(number); };
  const { summary, packages } = await runW0Capture(plan, capture as any);
  expect(order).toEqual([3035, 3031, 3036]);
  expect(summary.items.map((p: any) => p.status)).toEqual(['captured', 'captured', 'captured']);
  expect(summary.requests).toBe(3);
  expect(packages).toHaveLength(3);
});

it('does not start another PR after all 50 shared requests are spent', async () => {
  const capture = vi.fn(async ({ number, maxRequests }: any, { budget }: any) => {
    expect(maxRequests).toBeLessThanOrEqual(50); budget.requestsRemaining = 0; return fixture(number);
  });
  const { summary } = await runW0Capture(plan, capture as any);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(summary.requests).toBe(50);
  expect(summary.items.slice(1).every((p: any) => p.status === 'unattempted')).toBe(true);
});

it('rejects captured PR identity drift without substituting the next PR', async () => {
  const capture = vi.fn(async ({ number }: any, { budget }: any) => {
    budget.requestsRemaining--;
    const value = fixture(number);
    value.evidence.pull.mergedAt = '2024-01-04T00:00:00Z';
    return value;
  });
  const { summary, packages } = await runW0Capture(plan, capture as any);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(summary.items[0].status).toBe('failed');
  expect(packages).toHaveLength(0);
});

it('reports quarantine and unknown provenance instead of mining readiness', async () => {
  const capture = async ({ number }: any, { budget }: any) => { budget.requestsRemaining--; return fixture(number); };
  const { summary } = await runW0Capture(plan, capture as any);
  expect(summary).toMatchObject({ license: 'unknown', redistribution: 'blocked_pending_license',
    historicalW0Feedback: false, mining: 'not_run', treeIdentities: 'not_retained', modelCalls: 0 });
});
