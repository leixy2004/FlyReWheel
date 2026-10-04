import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { runW0Capture } from '../scripts/capture-w0-first-three.js';
import { GithubReadError } from '../src/github-pr-diagnostics.js';
import { w0SourceFixture } from './helpers/w0-source-fixture.js';

const plan = JSON.parse(readFileSync(new URL('../experiments/temporal-pilot/w0-first-three/selection.json', import.meta.url), 'utf8'));
function fixture(number: number) {
  const value = w0SourceFixture(number);
  return { ...value.evidence, sourceProvenance: { sourceIdentities: value.sourceIdentities,
    license: value.license, sourceTrees: value.sourceTrees } };
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
  const capture = async ({ number, includeSourceProvenance }: any, { budget }: any) => {
    expect(includeSourceProvenance).toBe(true); order.push(number); const value = fixture(number);
    budget.requestsRemaining -= value.receipt.requests; return value;
  };
  const { summary, packages } = await runW0Capture(plan, capture as any);
  expect(order).toEqual([3035, 3031, 3036]);
  expect(summary.items.map((p: any) => p.status)).toEqual(['captured', 'captured', 'captured']);
  expect(summary.requests).toBe(3 * fixture(3035).receipt.requests);
  expect(summary).toMatchObject({ priorRequests: 0, availableGetRequests: 50, totalRequestsUsed: summary.requests });
  expect(packages).toHaveLength(3);
  expect(packages.map(value => value.kind)).toEqual(['w0-source-package', 'w0-source-package', 'w0-source-package']);
  expect(packages.map(value => value.evidence.evidence.pull.number)).toEqual([3035, 3031, 3036]);
});

it('does not start another PR after all 50 shared requests are spent', async () => {
  const capture = vi.fn(async ({ number, maxRequests }: any, { budget }: any) => {
    expect(maxRequests).toBeLessThanOrEqual(50);
    const value = fixture(number);
    while (value.receipt.observations.length < 50) value.receipt.observations.push(structuredClone(value.receipt.observations[0]));
    value.receipt.requests = 50; budget.requestsRemaining = 0; return value;
  });
  const { summary } = await runW0Capture(plan, capture as any);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(summary.requests).toBe(50);
  expect(summary.items.slice(1).every((p: any) => p.status === 'unattempted')).toBe(true);
});

it('rejects captured PR identity drift without substituting the next PR', async () => {
  const capture = vi.fn(async ({ number }: any, { budget }: any) => {
    const value = fixture(number);
    budget.requestsRemaining -= value.receipt.requests;
    value.evidence.pull.mergedAt = '2024-01-04T00:00:00Z';
    return value;
  });
  const { summary, packages } = await runW0Capture(plan, capture as any);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(summary.items[0].status).toBe('failed');
  expect(packages).toHaveLength(0);
});

it('reports quarantine and unknown provenance instead of mining readiness', async () => {
  const capture = async ({ number }: any, { budget }: any) => { const value = fixture(number); budget.requestsRemaining -= value.receipt.requests; return value; };
  const { summary } = await runW0Capture(plan, capture as any);
  expect(summary).toMatchObject({ historicalW0Feedback: false, mining: 'not_run', modelCalls: 0,
    packageUse: 'quarantine_only_not_rule_input', license: 'pinned_bytes_verified_for_accepted_packages',
    licenseAcquisition: 'required_for_accepted_packages', redistribution: 'not_authorized',
    treeIdentities: 'required_for_accepted_packages' });
});

it('rejects a missing source sidecar without accepting partial evidence or trying another PR', async () => {
  const capture = vi.fn(async ({ number }: any, { budget }: any) => {
    const value = fixture(number); budget.requestsRemaining -= value.receipt.requests;
    const { sourceProvenance: _missing, ...bare } = value; return bare;
  });
  const { summary, packages } = await runW0Capture(plan, capture as any);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(packages).toHaveLength(0);
  expect(summary.items.map(item => item.status)).toEqual(['failed', 'unattempted', 'unattempted']);
});

it('rejects an internally valid receipt whose request count disagrees with the shared budget consumed', async () => {
  const capture = vi.fn(async ({ number }: any, { budget }: any) => {
    budget.requestsRemaining--; return fixture(number);
  });
  const { summary, packages } = await runW0Capture(plan, capture as any);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(packages).toHaveLength(0);
  expect(summary.items[0].status).toBe('failed');
  expect(summary.requests).toBe(1);
});

it('reserves the prior three GETs and passes only remaining allowances to each selected PR', async () => {
  const limits: number[] = [];
  const capture = async ({ number, maxRequests }: any, { budget }: any) => {
    limits.push(maxRequests); expect(maxRequests).toBe(budget.requestsRemaining);
    const value = fixture(number); value.receipt.requestLimit = maxRequests;
    budget.requestsRemaining -= value.receipt.requests; return value;
  };
  const { summary, packages } = await runW0Capture(plan, capture as any, { priorRequests: 3 });
  const perPull = fixture(3035).receipt.requests;
  expect(limits).toEqual([47, 47 - perPull, 47 - perPull * 2]);
  expect(summary).toMatchObject({ priorRequests: 3, availableGetRequests: 47,
    requests: perPull * 3, totalRequestsUsed: 3 + perPull * 3 });
  expect(packages).toHaveLength(3);
});

it('stops the entire remaining batch after a failure while retaining prior request accounting', async () => {
  const capture = vi.fn(async ({ maxRequests }: any, { budget }: any) => {
    expect(maxRequests).toBe(47); budget.requestsRemaining--;
    throw new GithubReadError('GET /repos/encode/httpx/pulls/3035', { status: 403 });
  });
  const { summary, packages } = await runW0Capture(plan, capture as any, { priorRequests: 3 });
  expect(capture).toHaveBeenCalledTimes(1);
  expect(summary).toMatchObject({ requests: 1, priorRequests: 3, availableGetRequests: 47, totalRequestsUsed: 4 });
  expect(summary.items.map(item => item.status)).toEqual(['failed', 'unattempted', 'unattempted']);
  expect(packages).toHaveLength(0);
});

it.each([-1, 50, 3.5, NaN, Infinity, '3', null])('rejects invalid prior GET count %s before invoking capture', async priorRequests => {
  const capture = vi.fn();
  await expect(runW0Capture(plan, capture, { priorRequests } as any)).rejects.toThrow();
  expect(capture).not.toHaveBeenCalled();
});

it('does not exceed 50 cumulative GETs when the remaining 47 are consumed by the first PR', async () => {
  const capture = vi.fn(async ({ number, maxRequests }: any, { budget }: any) => {
    expect(maxRequests).toBe(47);
    const value = fixture(number);
    while (value.receipt.observations.length < 47) value.receipt.observations.push(structuredClone(value.receipt.observations[0]));
    value.receipt.requests = value.receipt.requestLimit = 47;
    budget.requestsRemaining -= 47; return value;
  });
  const { summary, packages } = await runW0Capture(plan, capture as any, { priorRequests: 3 });
  expect(capture).toHaveBeenCalledTimes(1); expect(packages).toHaveLength(1);
  expect(summary).toMatchObject({ requests: 47, priorRequests: 3, availableGetRequests: 47, totalRequestsUsed: 50 });
  expect(summary.items.map(item => item.status)).toEqual(['captured', 'unattempted', 'unattempted']);
});

it('accepts the upper prior-count boundary and allows only its final one GET', async () => {
  const capture = vi.fn(async ({ maxRequests }: any, { budget }: any) => {
    expect(maxRequests).toBe(1); expect(budget.requestsRemaining).toBe(1); budget.requestsRemaining--;
    throw new GithubReadError('GET /repos/encode/httpx/pulls/3035', { status: 429 });
  });
  const { summary } = await runW0Capture(plan, capture as any, { priorRequests: 49 });
  expect(capture).toHaveBeenCalledTimes(1);
  expect(summary).toMatchObject({ priorRequests: 49, requests: 1, availableGetRequests: 1, totalRequestsUsed: 50 });
});
