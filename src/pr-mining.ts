import { digestOf, ruleVersionDigest } from './core/identity.js';
import { ProblemCaseSchema, type ProblemCase } from './core/model.js';
import { SourceCaseReferenceSchema } from './core/semantic-rule.js';
import { validateGithubPrEvidence, type StoredGithubPrEvidence } from './github-pr-evidence.js';
import {
  PR_MINING_LIMITS, PrMiningRequestInputSchema, PrMiningRequestSchema, PrMiningCandidateInputSchema, PrMiningCandidateSchema,
  type PrMiningRequestInput, type StoredPrMiningRequest, type PrMiningCandidateInput, type PrMiningCandidate,
  ExecutedPrMiningCandidateInputSchema, ExecutedPrMiningCandidateSchema, type ExecutedPrMiningCandidateInput, type ExecutedPrMiningCandidate,
} from './core/pr-mining.js';

export function miningBudget(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > PR_MINING_LIMITS.jsonBytes) throw new Error('PR mining JSON exceeds 2MB');
}
/** Derive unlabelled source cases from pinned captured bytes, never from a merge or discussion opinion. */
export function derivePrMiningRequest(input: PrMiningRequestInput, stored: StoredGithubPrEvidence): { request: StoredPrMiningRequest; cases: ProblemCase[] } {
  miningBudget(input);
  const options = PrMiningRequestInputSchema.parse(input), evidence = validateGithubPrEvidence(stored.evidence);
  if (evidence.digest !== stored.digest || evidence.digest !== options.evidenceDigest) throw new Error('Mining evidence identity mismatch');
  const { snapshot, snapshotDigest, pull, discussions } = evidence.evidence;
  const cases: ProblemCase[] = [];
  const sourceBindings = options.sources.map(selection => {
    const side = snapshot.changes.map(change => change[selection.side]).find(side => side.state !== 'absent' && side.path === selection.path);
    if (!side || side.state !== 'captured') throw new Error(`Mining source must be an exact captured side: ${selection.side}:${selection.path}`);
    const problemCase = ProblemCaseSchema.parse({
      id: `pr-case_${digestOf({ evidenceDigest: evidence.digest, ...selection })}`,
      lineageId: `pr-lineage_${digestOf({ repository: snapshot.repository.id, number: pull.number })}`,
      split: 'training', expected: 'unknown', title: `Unlabelled PR source: ${selection.side}:${selection.path}`,
      repository: snapshot.repository.id, commit: selection.side === 'before' ? snapshot.mergeBase : snapshot.head,
      path: selection.path, sourceDigest: side.sha256,
      provenance: { kind: 'imported', reference: `github-pr-evidence:${evidence.digest}#${selection.side}:${selection.path}`, reviewedBy: null, derivedFromCaseId: null },
    });
    cases.push(problemCase);
    return { caseId: problemCase.id, repository: problemCase.repository, commit: problemCase.commit, path: problemCase.path,
      sourceDigest: problemCase.sourceDigest, side: selection.side, objectId: side.objectId, mode: side.mode, byteLength: side.byteLength, caseDigest: digestOf(problemCase) };
  });
  const statementBindings = options.statements.map(selection => {
    const statement = selection.kind === 'pull' ? pull :
      (selection.kind === 'issue-comment' ? discussions.issueComments : selection.kind === 'review' ? discussions.reviews : discussions.reviewComments).find(value => value.id === selection.id);
    if (!statement) throw new Error('Selected mining statement is absent from the exact evidence');
    return { selection, digest: digestOf(statement) };
  });
  const request = PrMiningRequestSchema.parse({ schemaVersion: 1, kind: 'pr-rule-mining-request', input: options, snapshotDigest, sourceBindings, statementBindings,
    status: 'pending', synthesis: 'not_run', trust: { evidence: 'package-integrity-only', observation: 'current-api-state', historicalReviewCheckpoint: false,
      statements: 'untrusted-not-ground-truth-or-feedback', labels: 'unknown-only', identity: 'caller-declared-unverified', context: 'selected-changed-sides-only', certification: 'none' } });
  miningBudget(request);
  return { request: { digest: digestOf(request), request }, cases };
}
/** This validates provenance and syntax only. Authored mechanisms and detector claims remain unverified. */
export function derivePrMiningCandidate(input: PrMiningCandidateInput, stored: StoredPrMiningRequest): PrMiningCandidate {
  miningBudget(input);
  const options = PrMiningCandidateInputSchema.parse(input), request = PrMiningRequestSchema.parse(stored.request);
  if (digestOf(request) !== stored.digest || options.requestDigest !== stored.digest) throw new Error('Mining request identity mismatch');
  const { rule } = options, requested = request.input.requestedRule;
  if (rule.ruleId !== requested.ruleId || rule.version !== requested.version || rule.provenance.parentDigest !== requested.parentDigest) {
    throw new Error('Mining candidate must match the requested rule ID, version and parent digest');
  }
  const expected = new Map(request.sourceBindings.map(({ caseId, repository, commit, path, sourceDigest }) => [caseId, { caseId, repository, commit, path, sourceDigest }]));
  if (rule.provenance.sourceCases.length !== expected.size || rule.provenance.sourceCases.some(source => digestOf(SourceCaseReferenceSchema.parse(source)) !== digestOf(expected.get(source.caseId) ?? null))) {
    throw new Error('Mining candidate source cases must match every exact selected request source, with no extra cases');
  }
  if (rule.regressionCases.some(item => !expected.has(item.caseId))) throw new Error('Mining candidate regression cases must come from its selected request sources');
  if (request.input.source === 'fixture' && options.source !== 'fixture') throw new Error('A fixture mining request requires an explicit fixture candidate');
  return PrMiningCandidateSchema.parse({ schemaVersion: 1, kind: 'pr-rule-mining-candidate', id: options.id, requestDigest: stored.digest,
    evidenceDigest: request.input.evidenceDigest, snapshotDigest: request.snapshotDigest, ruleDigest: ruleVersionDigest(rule), source: options.source,
    status: 'candidate', synthesis: 'not_run', validation: 'schema-and-exact-provenance-only', semanticValidation: 'not_run', regressionExecution: 'not_run', activation: 'not_performed', certification: 'none' });
}

/** Pure persisted-record validation, NOT authorization to import claimed execution.
 * New records must arrive through the opaque trusted workspace adapter capability.
 */
export function deriveExecutedPrMiningCandidate(input: ExecutedPrMiningCandidateInput, stored: StoredPrMiningRequest): ExecutedPrMiningCandidate {
  miningBudget(input);
  const options = ExecutedPrMiningCandidateInputSchema.parse(input);
  const checked = derivePrMiningCandidate({ id: options.id, requestDigest: options.requestDigest, source: 'fixture', rule: options.rule }, stored);
  const receipt = options.executionReceipt;
  return ExecutedPrMiningCandidateSchema.parse({ ...checked, schemaVersion: 2,
    source: receipt.modelExecution === 'not_run' || stored.request.input.source === 'fixture' ? 'fixture' : 'model',
    synthesis: receipt.modelExecution, executionReceipt: receipt });
}
