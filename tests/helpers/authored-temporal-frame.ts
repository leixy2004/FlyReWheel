import { createHash } from 'node:crypto';
// Entirely authored metadata: no saved frame, readiness report or research rows read.
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

export const authoredCollectorBytes=Buffer.from('synthetic collector bytes; never executed');
export function authoredTemporalFrame() {
  const pullRequests=windows.flatMap((w,i)=>Array.from({length:[38,13,19][i]},(_,j)=>({
    number:10000+i*100+j, mergedAt:new Date(Date.parse(w.start)+j*86400000).toISOString().replace('.000Z','Z'),
    window:w.id, mergeCommit:(1+i*100+j).toString(16).padStart(40,'0'),
    parents:['f'.repeat(40)],tree:'e'.repeat(40),
  })));
  return {schemaVersion:1,kind:'github_metadata_temporal_frame',repository:'encode/httpx',
    selection:{frozenBeforeAcquisition:true,rationale:'Public Python HTTP client with bounded scope for later human annotation; not selected for known favorable outcomes.',
      rule:'All merged PRs in the fixed interval, without content/outcome filtering.',windows:structuredClone(windows)},
    acquisition:{api:'https://api.github.com/graphql',search,query,script:'scripts/capture-temporal-frame.mjs',
      scriptSha256:createHash('sha256').update(authoredCollectorBytes).digest('hex'),
      startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:00:01Z',maxRequests:10,requestTimeoutMs:60000,
      requests:1,pages:[{page:1,reportedCount:70,returnedCount:70,hasNextPage:false}]},
    status:'complete',reportedCount:70,capturedCount:70,windowCounts:{W0:38,W1:13,W2:19},pullRequests,limitations:{...limits}};
}
