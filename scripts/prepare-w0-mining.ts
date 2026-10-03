import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { W0SourcePackageSchema, validateW0SourcePackage } from './validate-w0-source-package.js';
import { PrMiningRequestInputSchema } from '../src/core/pr-mining.js';
import { buildPrMiningModelInput } from '../src/adapters/pr-mining-model.js';
import { digestOf } from '../src/core/identity.js';
import { QualEvoStore } from '../src/storage/store.js';
import { openPGliteDatabase } from '../src/storage/database.js';

const fixtureRoot = new URL('../experiments/temporal-pilot/w0-first-three/proxy-attempt-1/', import.meta.url);
export const MEMBERS = [
  { number: 3035, sha256: 'a0e1de76143154a1fd8f021c8be9f9a778a161986e5d5d03fc50e1ca92a92883', change: 'docs-tool-dependency-bump', intent: 'mkdocs-material 9.4.14 to 9.5.3', missing: ['documentation configuration', 'build results', 'project-specific defect evidence'] },
  { number: 3031, sha256: '41f3209e3209d8790127149d5928c27910048e3515cf60e786ccfd30b2247c7a', change: 'lint-tool-dependency-bump', intent: 'ruff 0.1.6 to 0.1.9', missing: ['lint configuration', 'violation examples', 'before/after lint results'] },
  { number: 3036, sha256: '9eb899563bd26d08fbd03d8b0fe0d4323243f5b20fd663d0969d81d877840ffd', change: 'ci-action-bump', intent: 'setup-python v4 to v5 in publish and test workflows', missing: ['action implementation', 'workflow run results', 'compatibility verification'] },
] as const;
const createdAt = '2026-10-03T22:52:07Z'; // Authored preparation timestamp, not historical evidence time.
const writeJson = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

export function validateFrozenPackage(bytes: Buffer, member: typeof MEMBERS[number]) {
  if (createHash('sha256').update(bytes).digest('hex') !== member.sha256) throw new Error('FROZEN_PACKAGE_BYTES_CHANGED');
  const value = W0SourcePackageSchema.parse(JSON.parse(bytes.toString('utf8')));
  validateW0SourcePackage(value);
  if (value.evidence.evidence.pull.number !== member.number) throw new Error('FROZEN_MEMBER_MISMATCH');
  return value;
}

/** Offline orchestration of the existing import, request derivation and pure prompt builder. */
export async function prepareW0Mining(dbPath: string, output: string) {
  // All three immutable packages pass before creating any store.
  const packages = await Promise.all(MEMBERS.map(async member => validateFrozenPackage(
    await readFile(new URL(`package-${member.number}.json`, fixtureRoot)), member)));
  // Exclusive fresh directory prevents accidental reuse of an operational/research store.
  await mkdir(resolve(output));
  await mkdir(resolve(dbPath));
  const db = await openPGliteDatabase(resolve(dbPath));
  let store = await QualEvoStore.initialize(db);
  const exports = [];
  let counts: Record<string, number> = {};
  try {
    for (const [index, pkg] of packages.entries()) {
      const member = MEMBERS[index]!;
      const evidence = await store.importGithubPrEvidence(pkg.evidence.evidence);
      const sources = evidence.evidence.snapshot.changes.flatMap(change => (['before', 'after'] as const).flatMap(side =>
        change[side].state === 'captured' ? [{ side, path: change[side].path }] : []));
      const input = PrMiningRequestInputSchema.parse({ id: `w0-exploratory-${member.number}`, evidenceDigest: evidence.digest,
        sources, statements: [{ kind: 'pull' }], requestedRule: { ruleId: `httpx-w0-${member.number}`, version: 'exploratory-1', parentDigest: null },
        objective: 'Assess whether the selected changed sources support a reusable semantic invariant. Preserve unknowns; return insufficient_evidence when support is missing. Merge, approvals, version bumps and third-party release notes are not defect or correctness labels.',
        actor: 'assistant-offline-exploratory-preparation-not-human-labeler', source: 'supplied', createdAt });
      const request = await store.createPrMiningRequest(input);
      if (digestOf(await store.createPrMiningRequest(input)) !== digestOf(request)) throw new Error('IDEMPOTENCE_FAILED');
      // Pure builder requires a model string. This sentinel is stripped from the exported template.
      // There is deliberately no configured model, transport, workspace request or execution call.
      const prepared = buildPrMiningModelInput({ evidence, request, candidateId: `w0-unexecuted-${member.number}`,
        candidateCreatedAt: createdAt, context: { kind: 'selected-evidence' } }, { model: 'unconfigured-offline-template' });
      const { model: _unconfigured, ...generationTemplate } = prepared.generation;
      exports.push({ number: member.number, evidence, input, request,
        template: { kind: 'unconfigured-mining-input-template', executable: false, model: null, modelExecution: 'not_run', generationTemplate },
        ledger: { number: member.number, packageSha256: member.sha256, evidenceDigest: evidence.digest, requestDigest: request.digest,
          sourceCapture: 'captured', changeType: member.change, exploratoryIntent: member.intent,
          formalSemanticEligibility: 'unknown', defectRuleSupport: 'not_established', exploratoryRuleProposals: 0,
          zeroYieldMeaning: 'Offline assistant reading found no sufficiently supported defect rule; not an executed mining outcome or gold label.',
          mining: 'not_run', fullRepositoryAvailable: false, missingEvidence: ['full repository checkout', ...member.missing],
          historicalW0Feedback: false, historicalSourceAvailability: 'not_established', labels: 'unknown-only',
          beforeCommit: evidence.evidence.snapshot.mergeBase, afterCommit: evidence.evidence.snapshot.head,
          context: 'selected-changed-sides-only', selectedSourceSides: sources.length, selectedStatements: ['pull'],
          nativeAgentAudit: 'exploratory-only-not-independent-human-labels', evaluationReady: false } });
    }
    for (const table of ['qe_github_pr_evidence', 'qe_pr_mining_requests', 'qe_problem_cases', 'qe_pr_mining_candidates', 'qe_rule_bundles', 'qe_feedback', 'qe_semantic_review_feedback']) {
      counts[table] = Number((await db.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`)).rows[0]!.count);
    }
    const expectedCounts = [3, 3, 8, 0, 0, 0, 0];
    if (Object.values(counts).some((count, index) => count !== expectedCounts[index])) throw new Error('UNEXPECTED_STORE_COUNTS');
    await store.close();
    store = await QualEvoStore.openPGlite(resolve(dbPath));
    for (const item of exports) {
      if (digestOf(await store.getPrMiningRequest(item.request.digest)) !== digestOf(item.request)
        || digestOf(await store.getGithubPrEvidence(item.evidence.digest)) !== digestOf(item.evidence)) throw new Error('REOPEN_IDENTITY_FAILED');
      for (const binding of item.request.request.sourceBindings) {
        const c = await store.getProblemCase(binding.caseId);
        if (c.expected !== 'unknown' || c.split !== 'training' || c.commit !== (binding.side === 'before' ? item.ledger.beforeCommit : item.ledger.afterCommit)) throw new Error('CASE_BINDING_FAILED');
      }
    }
  } finally { await store.close(); }
  for (const item of exports) {
    await writeJson(join(output, `request-input-${item.number}.json`), item.input);
    await writeJson(join(output, `request-${item.number}.json`), item.request);
    await writeJson(join(output, `generation-template-${item.number}.json`), item.template);
  }
  const report = { schemaVersion: 1, kind: 'offline-w0-mining-preparation', createdAt, inputCommit: '04155f2d4fafa7063e55caedaa3f2353b85fc268',
    upstreamRequestsThisStep: 0, cumulativeUpstreamRequests: 48, additionalUpstreamRequestsPlanned: 0,
    store: 'fresh-isolated-local-pglite', reopenedAndVerified: true, idempotenceVerified: true, counts,
    modelExecution: 'not_run', configuredModel: null, humanLabels: 0, candidates: 0, evaluationReady: false,
    scope: 'User-authorized offline exploratory request preparation; original capture receipts remain immutable.',
    items: exports.map(item => item.ledger) };
  await writeJson(join(output, 'ledger.json'), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { db: { type: 'string' }, out: { type: 'string' } }, strict: true });
  if (!values.db || !values.out) throw new Error('Usage: node --import tsx scripts/prepare-w0-mining.ts --db NEW_ISOLATED_DIRECTORY --out OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await prepareW0Mining(values.db, values.out), null, 2));
}
