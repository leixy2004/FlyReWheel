import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Offline only: reads the frame, its capture script, and this verifier. No source,
// labels, credentials, processes, network, or model clients are opened.
const framePath = new URL('../experiments/temporal-pilot/httpx-2024-frame.json', import.meta.url);
const capturePath = new URL('./capture-temporal-frame.mjs', import.meta.url);
const outputPath = new URL('../experiments/temporal-pilot/annotation-readiness.json', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const windows = [
  { id: 'W0', start: '2024-01-01T00:00:00Z', endExclusive: '2024-04-01T00:00:00Z' },
  { id: 'W1', start: '2024-04-01T00:00:00Z', endExclusive: '2024-07-01T00:00:00Z' },
  { id: 'W2', start: '2024-07-01T00:00:00Z', endExclusive: '2024-10-01T00:00:00Z' },
];
const search = 'repo:encode/httpx is:pr is:merged merged:2024-01-01..2024-09-30 sort:created-asc';
const query = `query($search: String!, $cursor: String) {
  search(query: $search, type: ISSUE, first: 100, after: $cursor) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number mergedAt mergeCommit { oid tree { oid } parents(first: 100) { totalCount nodes { oid } } }
    } }
  }
}`;
const limits = {
  identifiers: 'GitHub-declared merge metadata; no local commit/tree verification',
  historicalPublicAvailability: 'not_established', lineageIndependence: 'not_evaluated',
  sourceCapture: 'not_run', humanAnnotators: 'unassigned', independentLabels: 0,
  modelExecution: 'not_run', researchModelsAndBudgets: 'unconfigured',
  fullPilotPreregistration: false, efficacy: 'not_evaluated',
};
function check(condition, code) { if (!condition) throw new Error(code); }
function keys(object, expected, code) {
  check(object !== null && typeof object === 'object' && !Array.isArray(object), code);
  check(Object.keys(object).sort().join(',') === [...expected].sort().join(','), code);
}
function equal(a, b, code) { try { assert.deepEqual(a, b); } catch { throw new Error(code); } }
function utc(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
}
const sha1 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function verify(frame, captureSha256) {
  keys(frame, ['schemaVersion', 'kind', 'repository', 'selection', 'acquisition', 'status', 'reportedCount', 'capturedCount', 'windowCounts', 'pullRequests', 'limitations'], 'FRAME_FIELDS');
  check(frame.schemaVersion === 1 && frame.kind === 'github_metadata_temporal_frame' && frame.repository === 'encode/httpx', 'FRAME_IDENTITY');
  check(frame.status === 'complete', 'FRAME_INCOMPLETE');
  keys(frame.selection, ['frozenBeforeAcquisition', 'rationale', 'rule', 'windows'], 'SELECTION_FIELDS');
  check(frame.selection.frozenBeforeAcquisition === true, 'FREEZE_DECLARATION_MISSING');
  check(frame.selection.rationale === 'Public Python HTTP client with bounded scope for later human annotation; not selected for known favorable outcomes.' &&
    frame.selection.rule === 'All merged PRs in the fixed interval, without content/outcome filtering.', 'SELECTION_CHANGED');
  equal(frame.selection.windows, windows, 'FIXED_WINDOWS_CHANGED');
  const a = frame.acquisition;
  keys(a, ['api', 'search', 'query', 'script', 'scriptSha256', 'startedAt', 'maxRequests', 'requestTimeoutMs', 'requests', 'pages', 'completedAt'], 'ACQUISITION_FIELDS');
  check(a.api === 'https://api.github.com/graphql' && a.search === search && a.query === query, 'METADATA_QUERY_CHANGED');
  check(a.script === 'scripts/capture-temporal-frame.mjs' && a.scriptSha256 === captureSha256, 'CAPTURE_SCRIPT_HASH_MISMATCH');
  check(utc(a.startedAt) && utc(a.completedAt) && Date.parse(a.completedAt) >= Date.parse(a.startedAt), 'ACQUISITION_TIME');
  check(a.maxRequests === 10 && a.requestTimeoutMs === 60000 && Number.isInteger(a.requests) && a.requests > 0 && a.requests <= 10, 'REQUEST_BUDGET');
  check(Array.isArray(a.pages) && a.pages.length === a.requests, 'PAGE_COUNT');
  check(Number.isInteger(frame.reportedCount) && frame.reportedCount >= 0 && frame.reportedCount <= 1000, 'SEARCH_COUNT');
  let returned = 0;
  for (const [i, page] of a.pages.entries()) {
    keys(page, ['page', 'reportedCount', 'returnedCount', 'hasNextPage'], 'PAGE_FIELDS');
    check(page.page === i + 1 && page.reportedCount === frame.reportedCount, 'PAGE_TOTAL_CHANGED');
    check(Number.isInteger(page.returnedCount) && page.returnedCount >= 0 && page.returnedCount <= 100, 'PAGE_SIZE');
    check(page.hasNextPage === (i < a.pages.length - 1), 'PAGINATION_INCOMPLETE');
    check(i === a.pages.length - 1 || page.returnedCount > 0, 'EMPTY_INTERMEDIATE_PAGE');
    returned += page.returnedCount;
  }
  check(Array.isArray(frame.pullRequests) && frame.pullRequests.length === frame.reportedCount &&
    frame.capturedCount === frame.reportedCount && returned === frame.reportedCount, 'FULL_COUNT_MISMATCH');
  const numbers = new Set(), merges = new Set(), counts = { W0: 0, W1: 0, W2: 0 };
  let previous;
  for (const pr of frame.pullRequests) {
    // The exact whitelist rejects added labels, titles, source, comments or predictions.
    keys(pr, ['number', 'mergedAt', 'window', 'mergeCommit', 'parents', 'tree'], 'PR_METADATA_FIELDS');
    check(Number.isInteger(pr.number) && pr.number > 0 && !numbers.has(pr.number), 'DUPLICATE_OR_INVALID_PR');
    check(sha1(pr.mergeCommit) && !merges.has(pr.mergeCommit), 'DUPLICATE_OR_INVALID_MERGE');
    check(sha1(pr.tree) && Array.isArray(pr.parents) && pr.parents.length > 0 && pr.parents.length <= 100 &&
      pr.parents.every(sha1) && new Set(pr.parents).size === pr.parents.length && !pr.parents.includes(pr.mergeCommit), 'INVALID_COMMIT_METADATA');
    check(utc(pr.mergedAt), 'INVALID_MERGE_TIME');
    const timestamp = Date.parse(pr.mergedAt);
    const window = windows.find(w => timestamp >= Date.parse(w.start) && timestamp < Date.parse(w.endExclusive));
    check(window && pr.window === window.id, 'WINDOW_MEMBERSHIP');
    check(!previous || timestamp > previous.timestamp || timestamp === previous.timestamp && pr.number > previous.number, 'FRAME_ORDER');
    previous = { timestamp, number: pr.number };
    numbers.add(pr.number); merges.add(pr.mergeCommit); counts[window.id]++;
  }
  equal(frame.windowCounts, counts, 'WINDOW_COUNT_MISMATCH');
  equal(frame.limitations, limits, 'UNSUPPORTED_EVIDENCE_DECLARATION');
  return { counts, total: numbers.size, uniqueMergeCommits: merges.size, pages: a.pages.length };
}
function adversarialChecks(frame, hash) {
  // In-memory mutations exercise evidence failures; no altered frame is written.
  const mutations = [
    ['FIXED_WINDOWS_CHANGED', x => { x.selection.windows[0].endExclusive = '2024-04-02T00:00:00Z'; }],
    ['CAPTURE_SCRIPT_HASH_MISMATCH', x => { x.acquisition.scriptSha256 = '0'.repeat(64); }],
    ['PAGINATION_INCOMPLETE', x => { x.acquisition.pages.at(-1).hasNextPage = true; }],
    ['FULL_COUNT_MISMATCH', x => { x.capturedCount++; }],
    ['UNSUPPORTED_EVIDENCE_DECLARATION', x => { x.limitations.independentLabels = 1; }],
  ];
  if (frame.pullRequests.length) mutations.push(
    ['PR_METADATA_FIELDS', x => { x.pullRequests[0].label = 'TP'; }],
    ['WINDOW_MEMBERSHIP', x => { x.pullRequests[0].mergedAt = '2025-01-01T00:00:00Z'; }],
  );
  if (frame.pullRequests.length > 1) mutations.push(
    ['DUPLICATE_OR_INVALID_PR', x => { x.pullRequests[1].number = x.pullRequests[0].number; }],
    ['DUPLICATE_OR_INVALID_MERGE', x => { x.pullRequests[1].mergeCommit = x.pullRequests[0].mergeCommit; }],
  );
  for (const [code, mutate] of mutations) {
    const changed = structuredClone(frame); mutate(changed);
    assert.throws(() => verify(changed, hash), { message: code });
  }
  return mutations.length;
}

const report = { schemaVersion: 1, kind: 'offline_temporal_annotation_readiness',
  generatedAt: new Date().toISOString(), status: 'blocked',
  verification: { mode: 'offline', networkRequests: 0, modelCalls: 0, sourceOrLabelFilesRead: 0,
    verifier: 'scripts/verify-temporal-frame.mjs' } };
try {
  check(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--self-test', 'INVALID_ARGUMENTS');
  const [raw, capture, self] = await Promise.all([readFile(framePath), readFile(capturePath), readFile(new URL(import.meta.url))]);
  Object.assign(report.verification, { frame: 'experiments/temporal-pilot/httpx-2024-frame.json', frameSha256: digest(raw),
    captureScriptSha256: digest(capture), verifierSha256: digest(self) });
  const frame = JSON.parse(raw.toString('utf8'));
  const result = verify(frame, digest(capture));
  report.verification.passed = true;
  report.verification.checks = ['fixed_windows_and_metadata_query', 'pagination_and_full_count', 'unique_pr_and_merge_commit',
    'commit_identifiers_and_window_membership', 'capture_script_sha256', 'strict_metadata_fields_no_labels'];
  if (process.argv[2] === '--self-test') report.verification.adversarialRejections = adversarialChecks(frame, digest(capture));
  report.status = 'w0_source_preparation_only';
  report.repository = frame.repository;
  report.frame = { completeAgainstRecordedApiCount: true, capturedCount: result.total,
    uniqueMergeCommits: result.uniqueMergeCommits, pages: result.pages,
    counts: result.counts, zeroYieldWindows: windows.filter(w => result.counts[w.id] === 0).map(w => w.id) };
  report.windows = windows.map(w => ({ ...w, samples: result.counts[w.id],
    semanticEligibility: { status: 'unknown', count: result.counts[w.id] },
    independentHumanLabels: 0, lineage: 'not_audited',
    nextStage: w.id === 'W0' ? 'source_preparation_only' : 'keep_source_and_labels_unopened' }));
  report.annotation = { humanAnnotators: 0, assignment: 'unassigned', independentLabels: 0,
    countBasis: 'Declared frame inventory only; not an audit of external annotation systems.',
    packageStatus: 'not_ready_source_not_captured', allowedSourcePreparationWindow: 'W0',
    w0EligiblePrNumbers: frame.pullRequests.filter(pr => pr.window === 'W0').map(pr => pr.number),
    blockedSourceOrLabelWindows: ['W1', 'W2'],
    policyEnforcement: 'Readiness declaration, not a runtime access-control mechanism.',
    releaseGate: 'Freeze W0 rules before any W1 feedback-label exposure; require separate authorized gates before W1/W2 source or labels are opened.' };
  report.limitations = { preAcquisitionFreeze: 'Author declaration only; no independently timestamped preregistration proof.',
    completeness: 'Internal consistency with recorded GitHub search count; no new API query or independent enumeration.',
    sourceIdentities: 'Provider-declared commit/tree identifiers; full trees and source bytes not verified here.',
    parentCompleteness: 'Capture script records equality with API totalCount; raw totalCount not retained per commit, so not independently rederived offline.',
    lineageIndependence: 'not_audited', historicalVisibility: 'not_established',
    researchModelsAndBudgets: 'unconfigured', fullPilotFrozen: false, empiricalOutcomes: 'not_evaluated' };
} catch (error) {
  report.status = 'blocked'; report.verification.passed = false;
  report.verification.failure = error instanceof SyntaxError ? 'FRAME_JSON_INVALID' :
    /^[A-Z_]+$/.test(error.message ?? '') ? error.message : 'OFFLINE_VALIDATION_FAILED';
  process.exitCode = 1;
}
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, passed: report.verification.passed,
  counts: report.frame?.counts, adversarialRejections: report.verification.adversarialRejections,
  failure: report.verification.failure, output: 'experiments/temporal-pilot/annotation-readiness.json' }));
