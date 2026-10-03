import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const { validateTemporalFrame } = await import(new URL('../scripts/validate-temporal-frame.mjs', import.meta.url).href);
const frame = JSON.parse(readFileSync(new URL('../experiments/temporal-pilot/httpx-2024-frame.json', import.meta.url), 'utf8'));
const collectorBytes = readFileSync(new URL('../scripts/capture-temporal-frame.mjs', import.meta.url));

describe('saved temporal metadata frame integrity', () => {
  it('validates the saved 70-PR frame without asserting evaluation readiness', async () => {
    expect(frame.pullRequests).toHaveLength(70);
    expect(frame.windowCounts).toEqual({ W0: 38, W1: 13, W2: 19 });
    expect(await validateTemporalFrame(frame, collectorBytes)).toMatchObject({
      independentLabels: 0,
      evaluationReady: false,
    });
  });

  it('retains all three zero-yield windows for an authored empty-frame fixture', async () => {
    const empty = structuredClone(frame);
    empty.pullRequests = [];
    empty.reportedCount = 0;
    empty.capturedCount = 0;
    empty.windowCounts = { W0: 0, W1: 0, W2: 0 };
    empty.acquisition.pages = [{ page: 1, reportedCount: 0, returnedCount: 0, hasNextPage: false }];
    empty.acquisition.requests = 1;
    expect(await validateTemporalFrame(empty, collectorBytes)).toMatchObject({
      capturedCount: 0,
      windowCounts: { W0: 0, W1: 0, W2: 0 },
      independentLabels: 0,
      evaluationReady: false,
    });
  });

  it('preserves input values and saved frame/readiness bytes on success and rejection', async () => {
    const frameURL = new URL('../experiments/temporal-pilot/httpx-2024-frame.json', import.meta.url);
    const readinessURL = new URL('../experiments/temporal-pilot/annotation-readiness.json', import.meta.url);
    const originalFrameBytes = readFileSync(frameURL);
    const originalReadinessBytes = readFileSync(readinessURL);
    const supplied = structuredClone(frame);
    const originalInput = structuredClone(supplied);
    const originalCollector = Buffer.from(collectorBytes);
    await validateTemporalFrame(supplied, collectorBytes);
    expect(supplied).toEqual(originalInput);
    supplied.status = 'failed';
    const failedInput = structuredClone(supplied);
    await expect(validateTemporalFrame(supplied, collectorBytes)).rejects.toThrow();
    expect(supplied).toEqual(failedInput);
    expect(collectorBytes).toEqual(originalCollector);
    expect(readFileSync(frameURL)).toEqual(originalFrameBytes);
    expect(readFileSync(readinessURL)).toEqual(originalReadinessBytes);
  });

  const mutations: Array<[string, (copy: typeof frame) => void]> = [
    ['duplicate PR identity', copy => { copy.pullRequests[1].number = copy.pullRequests[0].number; }],
    ['missing PR row', copy => { copy.pullRequests.pop(); }],
    ['wrong captured count', copy => { copy.capturedCount++; }],
    ['wrong reported count', copy => { copy.reportedCount++; }],
    ['wrong window count', copy => { copy.windowCounts.W0--; }],
    ['wrong window assignment', copy => { copy.pullRequests[0].window = 'W2'; }],
    ['merge outside the frame', copy => { copy.pullRequests[0].mergedAt = '2023-12-31T23:59:59Z'; }],
    ['exclusive upper endpoint', copy => { copy.pullRequests[69].mergedAt = '2024-10-01T00:00:00Z'; }],
    ['impossible calendar date', copy => { copy.pullRequests[0].mergedAt = '2024-02-30T00:00:00Z'; }],
    ['timestamp without UTC zone', copy => { copy.pullRequests[0].mergedAt = '2024-01-02T00:00:00'; }],
    ['unfinished pagination', copy => { copy.acquisition.pages[0].hasNextPage = true; }],
    ['page total differs from frame', copy => { copy.acquisition.pages[0].reportedCount--; }],
    ['page row count differs from frame', copy => { copy.acquisition.pages[0].returnedCount--; }],
    ['missing page audit', copy => { copy.acquisition.pages = []; }],
    ['request count differs from pages', copy => { copy.acquisition.requests++; }],
    ['collector hash mismatch', copy => { copy.acquisition.scriptSha256 = '0'.repeat(64); }],
    ['malformed merge SHA', copy => { copy.pullRequests[0].mergeCommit = 'short'; }],
    ['malformed parent SHA', copy => { copy.pullRequests[0].parents[0] = 'short'; }],
    ['merge commit is its own parent', copy => { copy.pullRequests[0].parents[0] = copy.pullRequests[0].mergeCommit; }],
    ['malformed tree SHA', copy => { copy.pullRequests[0].tree = 'short'; }],
    ['PR title leakage', copy => { copy.pullRequests[0].title = 'Synthetic forbidden content'; }],
    ['PR label leakage', copy => { copy.pullRequests[0].labels = ['Synthetic forbidden label']; }],
    ['unknown top-level field', copy => { copy.unrecognizedField = true; }],
    ['unknown nested field', copy => { copy.acquisition.pages[0].unrecognizedField = true; }],
    ['fabricated independent labels', copy => { copy.limitations.independentLabels = 1; }],
    ['fabricated model execution', copy => { copy.limitations.modelExecution = 'complete'; }],
    ['fabricated preregistration', copy => { copy.limitations.fullPilotPreregistration = true; }],
    ['failed acquisition marked usable', copy => { copy.status = 'failed'; }],
    ['unexpected repository', copy => { copy.repository = 'example/other'; }],
    ['expanded content query', copy => { copy.acquisition.query = copy.acquisition.query.replace('number mergedAt', 'number title mergedAt'); }],
  ];

  it.each(mutations)('rejects %s', async (_name, mutate) => {
    const copy = structuredClone(frame);
    mutate(copy);
    await expect(validateTemporalFrame(copy, collectorBytes)).rejects.toThrow();
  });

  it('rejects collector bytes that differ from the acquisition provenance', async () => {
    await expect(validateTemporalFrame(structuredClone(frame), Buffer.concat([collectorBytes, Buffer.from('\n')]))).rejects.toThrow();
  });
});
