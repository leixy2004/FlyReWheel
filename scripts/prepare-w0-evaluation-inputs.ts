import { isMainModule } from './lib/is-main.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { digestOf } from '../src/core/identity.js';
import { EvaluationAnnotationSchema, EvaluationDatasetSchema } from '../src/core/paired-evaluation.js';
import { RepositoryPathSchema } from '../src/core/semantic-rule.js';
import { PrMiningRequestSchema } from '../src/core/pr-mining.js';
import { EvaluationWorkspaceBindingSchema } from '../src/workspace/history-policy.js';
import { derivePrMiningRequest } from '../src/pr-mining.js';
import { validateGithubPrEvidence } from '../src/github-pr-evidence.js';
import { MEMBERS, validateFrozenPackage } from './prepare-w0-mining.js';
const root = new URL('../experiments/temporal-pilot/w0-first-three/', import.meta.url);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const put = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

/** Preparation envelope only. Real response labels/anchors remain governed by the existing annotation schema. */
export const BlindDraftSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('unassigned-source-inspection-draft'),
  packetId: z.string().uuid(), assignment: z.literal('unassigned'), formalRelease: z.literal('blocked-history-and-rubric-unverified'),
  coverage: EvaluationAnnotationSchema.shape.coverage.element.shape.state.extract(['unassessed']),
  label: z.null(), ruleDefinition: z.null(), response: z.null(),
  instruction: z.literal('Do not assign correctness labels. Historical visibility and rule rubric are unverified. Record missing context only after assignment; do not search external sources.'),
  sources: z.array(z.object({ path: RepositoryPathSchema, content: z.string().max(262144) }).strict()).min(1).max(32),
}).strict();

/** Shape validation alone cannot prove blinded content; bind every source to the pinned BEFORE bytes. */
export function validateBlindDraft(input: unknown, packageBytes: Buffer, member: typeof MEMBERS[number]) {
  const pkg = validateFrozenPackage(packageBytes, member);
  const packet = BlindDraftSchema.parse(input);
  const expected = pkg.evidence.evidence.snapshot.changes.flatMap(change => change.before.state === 'captured'
    ? [{ path: change.before.path, content: Buffer.from(change.before.bytesBase64, 'base64').toString('utf8') }] : []);
  if (digestOf(packet.sources) !== digestOf(expected)) throw new Error('Blind draft must contain exactly the frozen before sources');
  return packet;
}

async function rejectGitAncestors(path: string) {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const marker = join(parent, '.git');
    try {
      const stat = await lstat(marker);
      // This environment has empty protected .git placeholders in /tmp and /workspace.
      // A real repository directory has HEAD; gitfiles/symlinks are conservatively rejected.
      if (!stat.isDirectory()) throw new Error('Private annotation directory must be outside every Git worktree');
      try { await lstat(join(marker, 'HEAD')); throw new Error('Private annotation directory must be outside every Git worktree'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (parent === dirname(parent)) break;
  }
}

export function verifyRuffPairRecords(pairs: { side: string; commands: { command: string[]; exitCode: number; stdout: string }[] }[]) {
  if (pairs.length !== 2 || [...new Set(pairs.map(p => p.side))].sort().join(',') !== 'after,before') throw new Error('Exact before/after pair required');
  for (const pair of pairs) {
    const binary = `/opt/ruff/${pair.side}`;
    const expected = [[binary, '--version'], [binary, 'format', 'httpx', 'tests', '--diff'], [binary, 'check', 'httpx', 'tests']];
    if (digestOf(pair.commands.map(c => c.command)) !== digestOf(expected) || pair.commands.some(c => c.exitCode !== 0)
      || pair.commands[0]!.stdout.trim() !== `ruff ${pair.side === 'before' ? '0.1.6' : '0.1.9'}`) throw new Error('Exact Ruff commands/version/results required');
  }
}

export function verifyContextRecord(value: any, expected: { commit: string; tree: string; repositoryId: string }) {
  const binding = EvaluationWorkspaceBindingSchema.parse(value.binding);
  if (binding.checkoutSha !== expected.commit || binding.repositoryId !== expected.repositoryId
    || value.tree !== expected.tree || value.observation.fullCommittedTreeVerified !== true
    || binding.recordDigest !== digestOf(value.exportRecord) || binding.requestDigest !== digestOf(value.manifest)
    || value.exportRecord.requestDigest !== binding.requestDigest || digestOf(value.exportRecord.request) !== digestOf(value.manifest)
    || value.manifest.checkoutSha !== expected.commit || value.manifest.repositoryId !== expected.repositoryId
    || digestOf(value.manifest.allowedHeads) !== digestOf([expected.commit]) || digestOf(binding.allowedHeads) !== digestOf([expected.commit])
    || digestOf(binding.inventory) !== digestOf(value.exportRecord.inventory)) throw new Error('Context binding differs');
  return binding;
}

export async function prepareW0EvaluationInputs(output: string, privateDirectory: string) {
  const canonical = async (path: string) => join(await realpath(dirname(resolve(path))), basename(path));
  const inside = (parent: string, child: string) => { const p = relative(parent, child); return !p || (!p.startsWith('../') && p !== '..' && !isAbsolute(p)); };
  const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
  output = await canonical(output); privateDirectory = await canonical(privateDirectory);
  if (inside(repo, privateDirectory) || inside(output, privateDirectory) || inside(privateDirectory, output)) throw new Error('Private annotation directory must be outside repository and output');
  await rejectGitAncestors(privateDirectory);
  const frameBytes = await readFile(new URL('../httpx-2024-frame.json', root));
  const frameHash = hash(frameBytes);
  if (frameHash !== '07c1ded10a03002eed7b3f25d75c33e161876d72f71371b4cbfc1652022f477b') throw new Error('Frozen frame changed');
  const frame = JSON.parse(frameBytes.toString('utf8'));
  const checked = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./validate-temporal-frame.mjs', import.meta.url))], { env: {}, timeout: 15000, maxBuffer: 1_000_000 });
  if (JSON.parse(checked.stdout).frameSha256 !== frameHash) throw new Error('Frame validator identity differs');
  await mkdir(output); await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(join(privateDirectory, 'packets'), { mode: 0o700 });
  await mkdir(join(privateDirectory, 'facilitator'), { mode: 0o700 });
  const sourceRecords = [], packets = [], facilitator = [];
  const behavior = await read('permission-diagnosis/ledger.json');
  verifyRuffPairRecords(behavior.ruffPairs);
  for (const member of MEMBERS) {
    const packageBytes = await readFile(new URL(`proxy-attempt-1/package-${member.number}.json`, root));
    const pkg = validateFrozenPackage(packageBytes, member);
    const evidence = validateGithubPrEvidence(pkg.evidence.evidence);
    const savedRequest = await read(`mining-preparation/request-${member.number}.json`);
    const request = PrMiningRequestSchema.parse(savedRequest.request);
    if (digestOf(request) !== savedRequest.digest || derivePrMiningRequest(request.input, evidence).request.digest !== savedRequest.digest) throw new Error('Request provenance differs');
    const contexts = [];
    for (const side of ['before', 'after'] as const) {
      const value = await read(`full-context/context-${member.number}-${side}.json`);
      const identity = pkg.sourceIdentities[side === 'before' ? 'mergeBase' : 'head'];
      const sha = identity.commit;
      const binding = verifyContextRecord(value, { commit: sha, tree: identity.tree, repositoryId: evidence.evidence.snapshot.repository.id });
      contexts.push({ side, commit: sha, tree: value.tree, binding, fullCommittedTreeVerified: value.observation.fullCommittedTreeVerified });
    }
    const frameRow = frame.pullRequests.find((row: { number: number }) => row.number === member.number);
    const sources = evidence.evidence.snapshot.changes.flatMap(change => change.before.state === 'captured'
      ? [{ path: change.before.path, content: Buffer.from(change.before.bytesBase64, 'base64').toString('utf8') }] : []);
    const packet = validateBlindDraft({ schemaVersion: 1, kind: 'unassigned-source-inspection-draft', packetId: randomUUID(),
      assignment: 'unassigned', formalRelease: 'blocked-history-and-rubric-unverified', coverage: 'unassessed', label: null, ruleDefinition: null, response: null,
      instruction: 'Do not assign correctness labels. Historical visibility and rule rubric are unverified. Record missing context only after assignment; do not search external sources.', sources }, packageBytes, member);
    await put(join(privateDirectory, 'packets', `${packet.packetId}.json`), packet); packets.push(packet);
    facilitator.push({ packetId: packet.packetId, number: member.number, packetDigest: digestOf(packet), beforeContext: contexts[0], evidenceDigest: evidence.digest,
      withheld: ['after source', 'PR identity/title/author/merge state', 'discussions', 'tool results', 'assistant eligibility interpretation'], residualRisk: 'Public source paths/content may identify project or change; no guaranteed identity blinding.' });
    let toolEvidence: unknown = { status: member.number === 3035 ? 'docs-build-not-run-sdist-only-dependency' : 'action-behavior-not-run', pairedChecks: 0 };
    if (member.number === 3031) {
      for (const pair of behavior.ruffPairs) {
        const expected = contexts.find(c => c.side === pair.side);
        const raw = await read(`permission-diagnosis/result-${pair.side}.json`);
        const commands = raw.stdout.trim().split('\n').map((line: string) => JSON.parse(line)).filter((v: { kind: string }) => v.kind === 'command');
        if (pair.commit !== expected?.commit || raw.commit !== pair.commit || digestOf(commands) !== digestOf(pair.commands)
          || commands.length !== 3 || commands.some((c: { exitCode: number }) => c.exitCode !== 0)) throw new Error('Ruff behavior binding differs');
      }
      toolEvidence = { status: 'selected-official-ruff-checks-pass-both-sides', pairedChecks: 1, pairs: behavior.ruffPairs,
        interpretation: 'Tool availability only; no defect repair or semantic correctness inference.', previousFailureArtifact: '../behavior-validation/ledger.json' };
    }
    sourceRecords.push({ number: member.number, frameRow, packageSha256: member.sha256, evidenceDigest: evidence.digest,
      snapshotDigest: evidence.evidence.snapshotDigest, miningRequestDigest: savedRequest.digest, contexts,
      changedPaths: [...new Set(request.sourceBindings.map(b => b.path))], sourceBindings: request.sourceBindings, toolEvidence,
      temporal: { sourceCapture: 'current-capture', observedAtRange: [pkg.acquisition.observations.map(o => o.observedAt).sort()[0], pkg.acquisition.observations.map(o => o.observedAt).sort().at(-1)], mergedAt: frameRow.mergedAt, intendedWindow: 'W0', windowEndExclusive: '2024-04-01T00:00:00Z',
        historicalReviewCheckpoint: null, historicalPublicAvailability: 'unproven', annotationObservationCutoff: null, discussionsSelected: false,
        statementExclusion: 'All current PR/discussion statements excluded from annotation drafts; existing mining requests still carry untrusted current pull statement and are not as-of experiment inputs.' },
      split: { use: 'development-only', excludedFromHoldout: true, reason: 'Selected for exploratory development; source, changes and behavior exposed to assistants.', crossWindowLineage: 'not-audited' },
      ruleEligibility: { status: 'unknown', defectRuleSupport: 'not-established', reason: member.change, exploratoryProposals: 0,
        zeroMeaning: 'Offline exploratory reading has not established a reusable defect rule; not a measured model yield or negative label.' },
      annotations: { assignment: 'unassigned', labels: 0, coverage: 'unassessed' }, feedback: { recordsCreated: 0, status: 'not-collected' } });
  }
  await put(join(privateDirectory, 'facilitator', 'facilitator-only.json'), facilitator);
  const heldout = { schemaVersion: 1, kind: 'metadata-only-future-selection-specification', frameSha256: frameHash,
    rule: 'All members of each existing half-open UTC window, sorted by mergedAt then PR number; no content/outcome filtering or replacements.',
    status: 'pending-independent-review-not-authorized-for-acquisition',
    windows: ['W1', 'W2'].map(id => ({ ...frame.selection.windows.find((w: { id: string }) => w.id === id),
      role: id === 'W1' ? 'future-feedback-development-candidates-not-holdout' : 'future-holdout-candidates',
      members: frame.pullRequests.filter((p: { window: string }) => p.window === id).sort((a: { mergedAt: string; number: number }, b: { mergedAt: string; number: number }) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number),
      sourceAccess: 'not-performed', exclusionsApplied: [], readiness: 'blocked-lineage-visibility-labels-unverified' })),
    exclusions: ['All three exposed W0 samples excluded from holdout and evaluation denominators.', 'Unknown/disputed/unassigned labels never converted to negative.', 'Do not score until semantic lineage, cherry-pick/backport and source-overlap audit is completed.', 'Exact tree/commit duplication is a flag, not proof of shared or independent defect lineage.'],
    comparisonDenominator: null, labels: 0, sourceOrDiscussionReads: 0 };
  const ledger = { schemaVersion: 1, kind: 'w0-evaluation-preparation-provenance', sourceCheckpoint: 'a7adb0ee4c86fd6e72f5a1327ff2ac0e0a8ec760', frameSha256: frameHash,
    inventory: { metadataFrame: 70, windows: { W0: 38, W1: 13, W2: 19 }, fixedExploratorySamples: 3, changedPathsAcrossPrs: 4, sourceSides: 8, fullContextExports: 6, pairedToolChecks: 1 },
    formalInputs: { dataset: 'not-materialized-no-rule-families', annotations: 'not-materialized-no-human-authors-or-labels', runs: 'not-materialized-no-model-or-review-arms', feedback: 'not-materialized-no-developer-feedback' },
    reusedContracts: ['EvaluationDatasetSchema', 'EvaluationAnnotationSchema', 'PrMiningRequestSchema', 'EvaluationWorkspaceBindingSchema', 'validateW0SourcePackage', 'validateTemporalFrame'],
    metrics: { precision: null, recall: null, effectiveness: null, status: 'not-estimated', semanticRuleYield: null },
    blinding: { localDraftPackets: packets.length, publishedPacketBytes: 0, sourceScope: 'selected-before-files-only', fullContextNotReleasedToAnnotators: true,
      formalHistoricalRelease: false, status: 'blocked-unverified-history-and-missing-rule-rubric', assignedAnnotators: 0, externalSharing: false,
      privateManifest: 'facilitator/facilitator-only.json outside repository; random UUIDs and identity mapping not published' },
    networkRequests: 0, modelCalls: 0, independentHumanLabels: 0, runtimeFeedbackWrites: 0, items: sourceRecords };
  await put(join(output, 'provenance-ledger.json'), ledger);
  await put(join(output, 'heldout-selection.json'), heldout);
  await put(join(output, 'blind-draft.schema.json'), z.toJSONSchema(BlindDraftSchema));
  await put(join(output, 'schema-contracts.json'), { source: 'src/core/paired-evaluation.ts',
    annotationSchemaDigest: digestOf(z.toJSONSchema(EvaluationAnnotationSchema)), datasetSchemaDigest: digestOf(z.toJSONSchema(EvaluationDatasetSchema)),
    formalFormsGenerated: false, reason: 'Existing schemas require real rules/families/authors; none are fabricated.' });
  return ledger;
}
if (await isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'private-dir': { type: 'string' } } });
  if (!values.out || !values['private-dir']) throw new Error('Supply new --out and --private-dir paths');
  console.log(JSON.stringify(await prepareW0EvaluationInputs(resolve(values.out), resolve(values['private-dir'])), null, 2));
}
