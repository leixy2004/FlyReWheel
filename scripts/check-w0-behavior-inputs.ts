import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { validateGithubPrEvidence } from '../src/github-pr-evidence.js';
import { buildPrMiningModelInput } from '../src/adapters/pr-mining-model.js';
import { digestOf } from '../src/core/identity.js';
import { MEMBERS, validateFrozenPackage } from './prepare-w0-mining.js';
const root = new URL('../experiments/temporal-pilot/w0-first-three/', import.meta.url);
const load = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
export async function checkW0BehaviorInputs() {
  const items = [];
  for (const member of MEMBERS) {
    const pkg = validateFrozenPackage(await readFile(new URL(`proxy-attempt-1/package-${member.number}.json`, root)), member);
    const evidence = validateGithubPrEvidence(pkg.evidence.evidence);
    const request = await load(`mining-preparation/request-${member.number}.json`);
    const saved = await load(`full-context/context-${member.number}-after.json`);
    const prepared = buildPrMiningModelInput({ request, evidence, candidateId: `w0-unexecuted-${member.number}`,
      candidateCreatedAt: request.request.input.createdAt, context: { kind: 'full-repository', repository: evidence.evidence.snapshot.repository.id,
        checkout: 'after', workspace: saved.generationTemplate.context.workspace, evaluation: saved.binding } }, { model: 'offline-input-check-not-configured' });
    const { model: _model, ...generation } = prepared.generation;
    if (digestOf(generation) !== digestOf(saved.generationTemplate)) throw new Error('Frozen full-context template differs');
    const workflows = [];
    if (member.number === 3036) for (const change of evidence.evidence.snapshot.changes) {
      for (const side of ['before', 'after'] as const) {
        const source = change[side];
        if (source.state !== 'captured') throw new Error('Workflow source missing');
        const doc = parseDocument(Buffer.from(source.bytesBase64, 'base64').toString('utf8'));
        if (doc.errors.length) throw new Error('Invalid workflow YAML');
        const value = doc.toJS();
        const actions = Object.values(value.jobs as Record<string, { steps: { uses?: string }[] }>).flatMap(job => job.steps.flatMap(step => step.uses?.startsWith('actions/setup-python@') ? [step.uses] : []));
        const expected = `actions/setup-python@${side === 'before' ? 'v4' : 'v5'}`;
        if (actions.length !== 1 || actions[0] !== expected) throw new Error('Unexpected fixed action version');
        workflows.push({ path: source.path, side, syntax: 'valid', setupPython: actions[0], actionExecution: 'not_run' });
      }
    }
    items.push({ number: member.number, requestDigest: request.digest, exactFullContextTemplateRederived: true,
      sourceCases: prepared.cases.length, labels: 'unknown-only', allCaseExpectationsUnknown: prepared.cases.every(c => c.expected === 'unknown'),
      workflows, modelExecution: 'not_run', executableTemplate: false, workspaceRequiresRederivation: true });
  }
  return { schemaVersion: 1, kind: 'offline-w0-mining-input-and-workflow-check', items,
    upstreamRequests: 0, modelCalls: 0, independentHumanLabels: 0, behavioralOracle: 'none' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Supply a new output JSON path');
  await writeFile(process.argv[2], JSON.stringify(await checkW0BehaviorInputs(), null, 2) + '\n', { flag: 'wx' });
}
