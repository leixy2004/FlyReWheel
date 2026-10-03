import { createHash } from 'node:crypto';
import type { CodexWorkspaceRequest, CodexWorkspaceResult } from './codex-runner.js';
import { MatchedWorkspaceWireResult } from './worker-protocol.js';
import { boundedJson, bytesDigest, hasCompletedWorkspaceProcess, validateWorkspaceExecutionBounds } from './execution-receipt.js';
import type { MatchedEvidenceSelection } from './matched-request.js';
import { MatchedDiagnosisSchema, ProposalSchema, ReviewSchema } from '../core/matched-revision-model.js';
import { validateMatchedWorkspaceEnvelope } from './matched-request.js';

function citations(refs: string[], selection: { evidenceRefs: string[]; requiredEvidenceRefs: string[] }) {
  if (refs.some(ref => !selection.evidenceRefs.includes(ref))) throw new Error('Matched result cites evidence outside its selected scope');
  if (selection.requiredEvidenceRefs.some(ref => !refs.includes(ref))) throw new Error('Matched result drops required selected citations');
}
function roster(actual: string[], selected: string[]) {
  if (actual.length !== selected.length || new Set(actual).size !== actual.length || actual.some(id => !selected.includes(id))) {
    throw new Error('Matched result must cover every selected identity exactly once');
  }
}
/** Structural/source-ID acceptance of an already completed outer result, never
 * provider attestation, monetary admission, activation or persistence authority.
 * Invalid output remains in the outer result for bounded failure diagnostics. */
export function validateMatchedWorkspaceResult(request: CodexWorkspaceRequest, result: CodexWorkspaceResult) {
  validateMatchedWorkspaceEnvelope(request, true);
  if (!request.matchedExecution || !request.matchedEvidence) throw new Error('Expected a matched workspace request');
  const selected = request.matchedEvidence;
  const worker = MatchedWorkspaceWireResult.parse(result.output);
  if (result.execution !== 'succeeded' || result.cleanup !== 'verified' || result.errors.length
    || result.requestDigest !== bytesDigest(JSON.stringify(request)) || worker.boundary !== result.backend
    || worker.outputContract !== request.outputContract) throw new Error('Matched result lacks its exact request and completed cleanup binding');
  if (worker.processEvidence.modelReasoningEffort !== request.modelReasoningEffort) throw new Error('Matched result changed the explicit forwarded reasoning setting');
  if (!hasCompletedWorkspaceProcess(worker, request.limits.maxOutputBytes)
    || worker.usage.cached_input_tokens > worker.usage.input_tokens) throw new Error('Matched result lacks bounded successful process evidence');
  boundedJson(request, request.limits.maxInputBytes, 'Matched workspace request');
  const artifacts = result.artifacts.map(artifact => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(artifact.name) || !(artifact.bytes instanceof Uint8Array)
      || createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.sha256) throw new Error('Matched artifact digest mismatch');
    return { name: artifact.name, sha256: artifact.sha256, byteLength: artifact.bytes.byteLength };
  });
  validateWorkspaceExecutionBounds({ workspaceRequestDigest: result.requestDigest, workerResult: worker,
    cleanup: 'verified', lifecycle: result.lifecycle, artifacts }, request.limits);
  validateMatchedResponse(selected, worker.value);
  return worker;
}

/** Selected source-ID binding, not independent semantic evidence assessment. */
export function validateMatchedResponse(selected: MatchedEvidenceSelection, raw: unknown) {
  if (selected.stage === 'proposal') {
    const value = ProposalSchema.parse(raw);
    citations(value.evidenceRefs, selected);
    if (value.replacement) citations(value.replacement.evidenceRefs, { ...selected, requiredEvidenceRefs: [] });
  } else if (selected.stage === 'diagnosis') {
    const value = MatchedDiagnosisSchema.parse(raw);
    roster(value.diagnoses.map(d => d.feedbackId), selected.feedback.map(f => f.feedbackId));
    for (const diagnosis of value.diagnoses) citations(diagnosis.evidenceRefs, selected.feedback.find(f => f.feedbackId === diagnosis.feedbackId)!);
  } else {
    const value = ReviewSchema.parse(raw);
    roster(value.judgments.map(j => j.targetId), selected.targets.map(t => t.targetId));
    for (const judgment of value.judgments) citations(judgment.evidenceRefs, selected.targets.find(t => t.targetId === judgment.targetId)!);
  }
}
