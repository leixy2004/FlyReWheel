import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRepositoryContext, makeRepositoryContextAnchor, makeRepositoryContextEvidence } from '../../src/repository-context.js';
import { buildRevisionModelInput } from '../../src/revision-generation.js';
import { ContextRevisionModelResponseSchema } from '../../src/core/revision-model.js';
import { type ContextReviewFixture } from '../../src/core/semantic-review.js';
import { captureChangeSnapshot } from '../../src/change-snapshot.js';
import { sourceDigest } from '../../src/adapters/candidates.js';
import { makeReviewEvidence, makeSnapshotAnchor } from '../../src/adapters/semantic-review-fixture.js';
import { type SemanticRuleVersion, type StoredRuleVersion } from '../../src/core/semantic-rule.js';
import { type ProblemCase } from '../../src/core/model.js';
import { reviewTargetId, type LegacyReviewFixture as ReviewFixture } from '../../src/core/semantic-review.js';
import { type RevisionModelContext, RevisionModelResponseSchema } from '../../src/core/revision-model.js';
import { QualEvoStore } from '../../src/storage/store.js';
import { openPGliteDatabase, type Database } from '../../src/storage/database.js';
import { workspaceGit } from '../../src/workspace/process.js';
import { prepareWorkspace } from '../../src/workspace/index.js';
import { type CodexWorkspaceBackend, type CodexWorkspaceRuntime } from '../../src/workspace/codex-runner.js';
import { runWorkspaceWorkerCommand } from '../../src/workspace-worker-entrypoint.js';
import { createRevisionWorkspaceModelAdapter } from '../../src/adapters/revision-model.js';

export const revisionDate = '2026-10-02T00:00:00Z';
export const revisionConfig = { enabled: true, model: 'authored-no-live-model' };
export const revisionLimits = { maxInputBytes: 262_144, maxOutputBytes: 131_072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
export const revisionUsage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
export async function revisionGenerationFixture(database?: Database, unregisteredFeedbackSource = false, withContext = false,
  detectionAssets: 'present' | 'omitted' | 'empty' = 'present') {
  const directory = await mkdtemp(join(tmpdir(), 'revision-generation-fixture-')), repoPath = join(directory, 'repo');
  let store: QualEvoStore | undefined;
  try {
    await mkdir(join(repoPath, 'src'), { recursive: true });
    const git = async (...args: string[]) => (await workspaceGit(repoPath, ...args)).trim();
    await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Authored Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    const policyPath = 'contracts/guard.txt', unusedPath = 'contracts/unused.txt';
    const policySource = 'Guard contract: an applicable explicit guard permits this exact danger call.\n';
    const unusedSource = 'UNCITED_CONTEXT_SENTINEL: unrelated private fixture bytes.\n';
    if (withContext) { await mkdir(join(repoPath, 'contracts')); await writeFile(join(repoPath, policyPath), policySource); await writeFile(join(repoPath, unusedPath), unusedSource); }
    await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n'); await git('add', '.'); await git('commit', '-m', 'authored before'); const base = await git('rev-parse', 'HEAD');
    const repository = 'fixture:revision-generation';
    const sources = [{ id: 'positive-case', path: 'src/positive.ts', source: 'danger(one);\n', expected: 'violation' as const, role: 'positive' as const },
      { id: 'safe-case', path: 'src/safe.ts', source: 'guard(one); danger(one);\n', expected: 'safe' as const, role: 'negative' as const }];
    for (const item of sources) await writeFile(join(repoPath, item.path), item.source);
    await writeFile(join(repoPath, 'src/unselected.ts'), 'export const unrelated = 0;\n');
    await git('add', '.'); await git('commit', '-m', 'authored after'); const head = await git('rev-parse', 'HEAD');
    const captured = await captureChangeSnapshot({ repositoryPath: repoPath, repositoryId: repository, baseTip: base, head });
    const db = database ?? await openPGliteDatabase(join(directory, 'db')); store = await QualEvoStore.initialize(db);
    const snapshot = await store.importChangeSnapshot(captured.snapshot);
    const repositoryContexts = withContext ? [await store.importRepositoryContext((await captureRepositoryContext({ repositoryPath: repoPath, repositoryId: repository, head, paths: [policyPath, unusedPath] })).context)] : undefined;
    const policyEvidence = repositoryContexts ? makeRepositoryContextEvidence(repositoryContexts[0], makeRepositoryContextAnchor(repositoryContexts[0], policyPath, 0, policySource.length), 'guard-contract') : undefined;
    const unusedEvidence = repositoryContexts ? makeRepositoryContextEvidence(repositoryContexts[0], makeRepositoryContextAnchor(repositoryContexts[0], unusedPath, 0, unusedSource.length), 'uncited-policy') : undefined;
    const cases: ProblemCase[] = sources.map(item => ({ id: item.id, lineageId: item.id, split: 'training', expected: item.expected,
      title: 'Authored regression case', repository, commit: head, path: item.path, sourceDigest: sourceDigest(item.source),
      provenance: { kind: 'synthetic', reference: 'fixture:revision-generation', reviewedBy: null, derivedFromCaseId: null } }));
    const baseInput: SemanticRuleVersion = { schemaVersion: 2, ruleId: 'generated-revision-rule', version: 'base',
      semantics: { title: 'Danger needs a guard', mechanism: 'Missing guard', invariant: 'Use a guard', applicability: ['Danger calls'], exceptions: [], requiredContext: withContext ? ['guard-contract'] : [], expectedBehavior: 'Preserve uncertainty' },
      scope: { repositories: [repository], paths: { include: ['src'], exclude: [] } },
      ...(detectionAssets === 'omitted' ? {} : { detectionAssets: detectionAssets === 'empty' ? [] : [
        { id: 'danger', detector: { kind: 'ast-grep' as const, language: 'typescript' as const, pattern: 'danger($ARG)' } },
      ] }),
      regressionCases: (unregisteredFeedbackSource ? sources.slice(0, 1) : sources).map(item => ({ caseId: item.id, role: item.role })),
      provenance: { sourceCases: [{ caseId: cases[0].id, repository, commit: head, path: cases[0].path, sourceDigest: cases[0].sourceDigest }],
        parentDigest: null, author: 'authored-fixture', createdAt: revisionDate, rationale: 'Authored offline rule' } };
    const baseRule = await store.importRuleVersion(baseInput, unregisteredFeedbackSource ? cases.slice(0, 1) : cases);
    const fixtures = (rule: StoredRuleVersion, states: ('safe' | 'violation' | 'unknown')[]): ReviewFixture => {
      const evidence: ReviewFixture['evidence'] = [], judgments: ReviewFixture['judgments'] = [];
      sources.forEach((item, index) => {
        const start = item.source.indexOf('danger(one)'), anchor = makeSnapshotAnchor(snapshot, 'after', item.path, start, start + 'danger(one)'.length);
        const proof = makeReviewEvidence(snapshot, anchor, 'captured-source'); evidence.push(proof);
        judgments.push({ targetId: reviewTargetId(rule.digest, snapshot.digest, index, item.path, sourceDigest(item.source)), decision: states[index],
          reasoning: 'Authored judgment only', evidenceRefs: [proof.id], findingAnchors: states[index] === 'unknown' ? [] : [anchor] });
      });
      return { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest, snapshotDigest: snapshot.digest, evidence, judgments };
    };
    const contextFixtures = (rule: StoredRuleVersion, states: ('safe' | 'violation' | 'unknown')[]): ContextReviewFixture => {
      const legacy = fixtures(rule, states);
      return { ...legacy, schemaVersion: 3, repositoryContextDigests: repositoryContexts!.map(item => item.digest), evidence: [...legacy.evidence, policyEvidence!, unusedEvidence!],
        judgments: legacy.judgments.map(judgment => ({ targetId: judgment.targetId, decision: judgment.decision, reasoning: judgment.reasoning,
          evidenceRefs: [...judgment.evidenceRefs, policyEvidence!.id], missingContext: [],
          anchorJudgments: judgment.findingAnchors.map(anchor => ({ anchor, decision: judgment.decision, reasoning: judgment.reasoning,
            evidenceRefs: [...judgment.evidenceRefs, policyEvidence!.id], missingContext: [] })) })) };
    };
    const reviewOptions = repositoryContexts ? { repositoryContextDigests: repositoryContexts.map(item => item.digest) } : {};
    const baseReview = await store.runSemanticReview({ ruleDigest: baseRule.digest, snapshotDigest: snapshot.digest,
      fixtures: withContext ? contextFixtures(baseRule, ['violation', 'violation']) : fixtures(baseRule, ['violation', 'violation']), ...reviewOptions });
    const finding = baseReview.findings.find(item => item.anchor.path === 'src/safe.ts')!;
    const feedback = await store.appendReviewFeedback({ id: 'selected-fp', findingId: finding.id, reviewId: baseReview.id, ruleDigest: baseRule.digest,
      ruleVersion: baseInput.version, source: 'fixture', actor: 'authored-fixture', kind: 'label', label: 'FP', reason: 'Guard is present at this anchor', createdAt: revisionDate });
    const request = await store.createRevisionRequest({ id: 'pending-request', baseRuleDigest: baseRule.digest, requestedRuleVersion: 'generated', feedbackIds: [feedback.id],
      requestedChange: 'Propose a guard exception; leave unrelated violations intact', actor: 'authored-fixture', source: 'fixture', createdAt: revisionDate });
    const workspace = { repoPath, runId: 'revision', attemptId: 'authored' }; await prepareWorkspace({ ...workspace, baseSha: head });
    const context: RevisionModelContext = { kind: 'selected-evidence-no-tools', workspace, snapshotDigest: snapshot.digest };
    const input = { ...await store.getRevisionGenerationEvidence(request.digest), candidateId: 'generated-candidate', candidateCreatedAt: revisionDate, context };
    const legacyValue = RevisionModelResponseSchema.parse({ policyVersion: 'diagnosis-operators-v1', requestDigest: request.digest, baseRuleDigest: baseRule.digest, requestedRuleVersion: 'generated', result: {
      status: 'candidate', operator: 'boundary_update', replacement: null, semantics: { ...baseInput.semantics, exceptions: ['An explicit applicable guard precedes the call'] }, paths: baseInput.scope.paths,
      detectionAssets: baseInput.detectionAssets ?? [], rationale: 'Authored proposal only; must be compared before any decision',
      evidenceRefs: [`rule:${baseRule.digest}`, `feedback:${feedback.id}`, `finding:${finding.id}`],
      diagnoses: [{ feedbackId: feedback.id, category: 'boundary', reasoning: 'The guarded boundary may explain this anchored FP', missingEvidence: [],
        evidenceRefs: [`feedback:${feedback.id}`, `finding:${finding.id}`], claim: 'proposal-not-established-fact' }],
    } });
    const value = withContext ? ContextRevisionModelResponseSchema.parse({ ...legacyValue,
      evidencePolicyVersion: 'selected-context-evidence-v1', repositoryContextBindings: buildRevisionModelInput(input, revisionConfig).repositoryContextBindings,
      result: { ...legacyValue.result, evidenceRefs: [...legacyValue.result.evidenceRefs, `evidence:${policyEvidence!.id}`],
        diagnoses: legacyValue.result.diagnoses.map(item => ({ ...item, evidenceRefs: [...item.evidenceRefs, `evidence:${policyEvidence!.id}`] })) } }) : legacyValue;
    const envelope = { protocolVersion: 2, outputContract: withContext ? 'rule-revision-v3' : 'rule-revision-v2', value, usage: revisionUsage, sessionId: 'authored-session',
      processEvidence: { reason: 'completed', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, forwardedBytes: 0, processGroupStopped: true }, boundary: 'authored-test-no-isolation' };
    const calls: string[] = [];
    const runtime: CodexWorkspaceRuntime = { async prepare() { calls.push('prepare'); return { expectedSha: head, headSha: head, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
      async execute() { calls.push('execute'); return envelope; }, async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
      async collect() { calls.push('collect'); return []; }, async destroy() { calls.push('destroy'); return { destroyed: true, verified: true }; } };
    const backend: CodexWorkspaceBackend = { kind: 'authored-test-no-isolation', reserve() { calls.push('reserve'); return runtime; } };
    const dependency = { id: 'authored-runtime', backend, limits: revisionLimits };
    const sdk = async (extraEvent?: unknown) => {
      const requestPath = join(directory, 'request.json'), executable = join(directory, 'authored-cli.cjs');
      await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(directory, 'sdk-args.json'))},JSON.stringify(process.argv));process.stdin.resume();process.stdin.on('end',()=>{const send=x=>console.log(JSON.stringify(x));send({type:'thread.started',thread_id:'authored-sdk-session'});${extraEvent ? `send(${JSON.stringify(extraEvent)});` : ''}send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(value)})}});send({type:'turn.completed',usage:${JSON.stringify(revisionUsage)}});});\n`, { mode: 0o700 });
      backend.reserve = (request, record) => {
        runtime.execute = async signal => {
          await writeFile(requestPath, JSON.stringify({ workingDirectory: record.worktreePath, model: request.model, prompt: request.prompt,
            outputContract: request.outputContract, toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits }));
          return JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], { kind: 'authored-test-no-isolation', fixtureRoot: directory, workingDirectory: record.worktreePath,
            requestPath, codexPathOverride: executable, imageConfig: { schemaVersion: 1, gateway: { kind: 'credential-isolated-gateway', baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } } }, signal));
        }; return runtime;
      };
    };
    return { store, db, directory, repoPath, base, head, repository, sources, cases, baseInput, baseRule, snapshot, baseReview, finding, feedback, request, input,
      context, workspace, value, envelope, calls, runtime, backend, dependency, fixtures, contextFixtures, reviewOptions, repositoryContexts, policyEvidence, unusedEvidence, policySource, unusedSource, sdk,
      adapter: () => createRevisionWorkspaceModelAdapter(revisionConfig, dependency),
      closeStore: async () => { await store!.close(); store = undefined; },
      cleanup: async () => { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
