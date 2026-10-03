import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digestOf, ruleVersionDigest } from '../src/core/identity.js';
import { SemanticRuleVersionSchema } from '../src/core/semantic-rule.js';
import { buildRevisionModelInput, validateExecutedRevisionCandidate, validateRevisionModelResponse } from '../src/revision-generation.js';
import { generateRuleRevision } from '../src/rule-revision.js';
import { QualEvoStore } from '../src/storage/store.js';
import { revisionGenerationFixture, revisionConfig, revisionDate } from './helpers/revision-generation-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const scenarios = [
  { detectionAssets: 'omitted', withContext: false, contract: 'rule-revision-v2' },
  { detectionAssets: 'empty', withContext: false, contract: 'rule-revision-v2' },
  { detectionAssets: 'omitted', withContext: true, contract: 'rule-revision-v3' },
  { detectionAssets: 'empty', withContext: true, contract: 'rule-revision-v3' },
] as const;
async function fixture(scenario: typeof scenarios[number]) {
  const f = await revisionGenerationFixture(undefined, false, scenario.withContext, scenario.detectionAssets);
  cleanup.push(f.cleanup); return f;
}
function candidateResponse(f: Awaited<ReturnType<typeof fixture>>) {
  const response = structuredClone(f.value);
  if (response.result.status !== 'candidate') throw new Error('Expected authored candidate');
  return { ...response, result: response.result };
}
function contractResponse(f: Awaited<ReturnType<typeof fixture>>) {
  const response = candidateResponse(f);
  response.result.operator = 'contract_replacement';
  response.result.diagnoses[0].category = 'contract';
  response.result.semantics = { ...f.baseInput.semantics, invariant: 'Use the declared replacement capability contract' };
  response.result.replacement = {
    priorRuleDigest: f.baseRule.digest, previousContract: 'Guard contract', proposedContract: 'Capability contract',
    evidenceRefs: [`rule:${f.baseRule.digest}`, `finding:${f.finding.id}`,
      ...(f.policyEvidence ? [`evidence:${f.policyEvidence.id}`] : [])],
    retirement: { status: 'proposed_requires_review', oldRuleAppliesWhen: 'Guard API is used',
      replacementAppliesWhen: 'Capability API is used', rationale: 'Authored transition requires validation', activation: 'not_performed' },
  };
  return response;
}

it.each(scenarios)('validates actual edits and rejects detectorless no-ops with $detectionAssets assets under $contract', async scenario => {
  const f = await fixture(scenario), prepared = buildRevisionModelInput(f.input, revisionConfig);
  expect(prepared.outputContract).toBe(scenario.contract);
  for (const field of ['applicability', 'exceptions', 'paths'] as const) {
    const response = candidateResponse(f);
    response.result.semantics = structuredClone(f.baseInput.semantics);
    if (field === 'paths') response.result.paths.exclude = ['src/unselected.ts'];
    else response.result.semantics[field] = ['Danger calls without an applicable guard'];
    expect(validateRevisionModelResponse(prepared, response)).toEqual(response);
  }
  const replacement = contractResponse(f);
  expect(validateRevisionModelResponse(prepared, replacement)).toEqual(replacement);
  f.runtime.execute = async () => ({ ...f.envelope, value: replacement });
  expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'succeeded', status: 'candidate_requires_review',
    candidate: { operator: 'contract_replacement' }, candidateInput: { rule: { detectionAssets: [] } } });

  const assetEdit = candidateResponse(f);
  assetEdit.result.detectionAssets = [{ id: 'danger', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'danger($ARG)' } }];
  expect(() => validateRevisionModelResponse(prepared, assetEdit)).toThrow('Boundary update must preserve detectionAssets');
  // A real detector addition is still a permitted contract edit, even without prose/path changes.
  const assetReplacement = contractResponse(f);
  assetReplacement.result.semantics = structuredClone(f.baseInput.semantics);
  assetReplacement.result.detectionAssets = assetEdit.result.detectionAssets;
  expect(validateRevisionModelResponse(prepared, assetReplacement)).toEqual(assetReplacement);

  for (const response of [candidateResponse(f), contractResponse(f)]) {
    response.result.semantics = structuredClone(f.baseInput.semantics);
    expect(() => validateRevisionModelResponse(prepared, response)).toThrow('requires an actual permitted edit');
    f.runtime.execute = async () => ({ ...f.envelope, value: response });
    expect(await f.adapter().generate(f.input)).toMatchObject({ execution: 'failed', stage: 'output', candidate: null,
      error: expect.stringContaining('requires an actual permitted edit'), runtimeResult: { cleanup: 'verified' } });
  }
  const malformed = candidateResponse(f);
  Reflect.deleteProperty(malformed.result, 'detectionAssets');
  expect(() => validateRevisionModelResponse(prepared, malformed)).toThrow();
  expect(await f.store.listRevisionCandidates()).toEqual([]);
  expect(await f.store.listRuleVersions()).toHaveLength(1);
}, 30_000);

it.each(scenarios)('round-trips an authored SDK detectorless revision with $detectionAssets assets under $contract without rewriting the base', async scenario => {
  const f = await fixture(scenario), prepared = buildRevisionModelInput(f.input, revisionConfig);
  const baseBytes = JSON.stringify(f.baseInput), baseDigest = ruleVersionDigest(f.baseInput), inputDigest = digestOf(prepared.graph);
  const alternateBase = structuredClone(f.baseInput);
  if (scenario.detectionAssets === 'omitted') alternateBase.detectionAssets = [];
  else delete alternateBase.detectionAssets;
  expect(SemanticRuleVersionSchema.parse(alternateBase)).toEqual(alternateBase);
  expect(ruleVersionDigest(alternateBase)).not.toBe(baseDigest);
  expect(prepared.generation.prompt).toContain(`"baseRule":${baseBytes}`);
  expect(prepared.graph.baseRule.rule).toEqual(f.baseInput);

  await f.sdk();
  const generated = await generateRuleRevision(f.store, { requestDigest: f.request.digest, candidateId: f.input.candidateId,
    candidateCreatedAt: revisionDate, context: f.context }, revisionConfig, f.dependency);
  expect(generated).toMatchObject({ execution: 'succeeded', status: 'candidate_requires_review', modelExecution: 'not_run',
    candidate: { schemaVersion: scenario.withContext ? 3 : 2, operator: 'boundary_update', source: 'fixture', activation: 'not_performed' },
    executionReceipt: { baseRuleDigest: baseDigest, inputDigest, workerResult: { outputContract: scenario.contract, sessionId: 'authored-sdk-session' } } });
  if (generated.execution !== 'succeeded' || generated.status !== 'candidate_requires_review') throw new Error(JSON.stringify(generated));
  const { saved, candidateInput } = generated;
  expect(candidateInput.rule.detectionAssets).toEqual([]);
  expect(candidateInput.rule.provenance.parentDigest).toBe(baseDigest);
  expect(candidateInput.rule.provenance.sourceCases).toEqual(f.baseInput.provenance.sourceCases);
  expect(candidateInput.rule.regressionCases).toEqual(f.baseInput.regressionCases);
  expect(validateExecutedRevisionCandidate(candidateInput, prepared.graph)).toEqual(saved.candidate);
  expect(await f.store.saveRevisionModelCandidate(generated.persistence)).toEqual(saved);
  expect(await f.store.getRuleVersion(baseDigest)).toEqual(f.baseRule);
  expect(await f.store.getActive(f.baseInput.ruleId)).toBeNull();
  expect(await f.store.getRevisionRequest(f.request.digest)).toEqual(f.request);
  expect(buildRevisionModelInput(f.input, revisionConfig)).toEqual(prepared);

  await f.closeStore();
  const reopened = await QualEvoStore.openPGlite(join(f.directory, 'db'));
  try {
    expect(await reopened.getRevisionCandidate(saved.digest)).toEqual(saved);
    expect(await reopened.listRevisionCandidates(f.request.digest)).toEqual([saved]);
    expect(await reopened.getRuleVersion(baseDigest)).toEqual(f.baseRule);
    expect(await reopened.getRuleVersion(saved.candidate.ruleDigest)).toEqual({ digest: saved.candidate.ruleDigest, rule: candidateInput.rule });
    expect(await reopened.getSemanticReview(f.baseReview.id)).toEqual(f.baseReview);
  } finally { await reopened.close(); }
}, 60_000);
