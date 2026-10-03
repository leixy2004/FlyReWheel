import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureChangeSnapshot, validateChangeSnapshot } from '../../src/change-snapshot.js';
import { validateGithubPrEvidence } from '../../src/github-pr-evidence.js';
import { buildSemanticReview } from '../../src/semantic-review.js';
import { makeReviewEvidence, makeSnapshotAnchor } from '../../src/adapters/semantic-review-fixture.js';
import { prepareWorkspace, type WorkspaceIdentity } from '../../src/workspace/index.js';
import { workspaceGit } from '../../src/workspace/process.js';
import type { CodexWorkspaceBackend, CodexWorkspaceRuntime } from '../../src/workspace/codex-runner.js';
import { runWorkspaceWorkerCommand } from '../../src/workspace-worker-entrypoint.js';
import { miningDate, miningFixture } from './pr-mining-fixture.js';
import { readAsset, semanticInputs } from './semantic-review-fixture.js';
import { revisionConfig, revisionDate, revisionGenerationFixture, revisionLimits, revisionUsage } from './revision-generation-fixture.js';

/** All executors in these queue tests are authored local programs. The official
 * Codex SDK and worker protocol really run, but no model, service, or isolation is
 * claimed. Each scenario gets a fresh persistent PGlite application database. */
export async function applicationJobsFixture() {
  const revision = await revisionGenerationFixture();
  try {
    const { store, directory } = revision;
    const repoPath = join(directory, 'application-repo');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    const git = async (...args: string[]) => (await workspaceGit(repoPath, ...args)).trim();
    await git('init', '--initial-branch=main');
    await git('config', 'user.name', 'Authored Queue Fixture');
    await git('config', 'user.email', 'queue-fixture@example.invalid');
    const before = '\ufeff// Policy: local evidence only\r\nfunction run() { return 0; }\r\n';
    const after = '\ufeff// Policy: local evidence only\r\nfunction run() { dangerousRead(); dangerousRead(); }\r\n';
    await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n');
    await writeFile(join(repoPath, 'src/sample.ts'), before);
    await git('add', '.'); await git('commit', '-m', 'authored queue before');
    const base = await git('rev-parse', 'HEAD');
    await writeFile(join(repoPath, 'src/sample.ts'), after);
    await git('add', '.'); await git('commit', '-m', 'authored queue after');
    const head = await git('rev-parse', 'HEAD');
    const mining = miningFixture();
    const captured = await captureChangeSnapshot({ repositoryPath: repoPath,
      repositoryId: mining.evidence.evidence.snapshot.repository.id, baseTip: base, head });
    const snapshot = validateChangeSnapshot({ ...captured.snapshot,
      prMetadata: mining.evidence.evidence.snapshot.prMetadata });
    const evidence = validateGithubPrEvidence({ ...mining.evidence.evidence,
      snapshot: snapshot.snapshot, snapshotDigest: snapshot.digest,
      pull: { ...mining.evidence.evidence.pull, baseTip: base, head } });
    await store.importGithubPrEvidence(evidence.evidence);
    const miningRequest = await store.createPrMiningRequest({ ...mining.input,
      evidenceDigest: evidence.digest, source: 'supplied' });
    const original = semanticInputs({ before, after, assets: [readAsset] });
    const repository = snapshot.snapshot.repository.id;
    const problemCase = { ...original.problemCase, repository, commit: base };
    const rule = await store.importRuleVersion({ ...original.rule.rule,
      scope: { ...original.rule.rule.scope, repositories: [repository] },
      provenance: { ...original.rule.rule.provenance,
        sourceCases: original.rule.rule.provenance.sourceCases.map(item => ({ ...item, repository, commit: base })) } }, [problemCase]);
    const target = buildSemanticReview({ rule, snapshot }).coverage.targets[0];
    const offset = after.indexOf('dangerousRead()');
    const anchor = makeSnapshotAnchor(snapshot, 'after', target.path, offset, offset + 'dangerousRead()'.length);
    const proof = makeReviewEvidence(snapshot, makeSnapshotAnchor(snapshot, 'before', target.path, 0, before.length), 'local-policy');
    const values: Record<string, unknown> = {
      'pr-mining-v1': { result: { status: 'candidate', semantics: mining.candidate.rule.semantics,
        paths: { include: ['src'], exclude: [] }, detectionAssets: [],
        rationale: 'Authored queued SDK fixture, no model execution or human approval.',
        evidenceRefs: [`case:${miningRequest.request.sourceBindings[0].caseId}`,
          `statement:${miningRequest.request.statementBindings[0].digest}`] } },
      'semantic-review-v2': { ruleDigest: rule.digest, snapshotDigest: snapshot.digest, evidence: [proof],
        judgments: [{ targetId: target.id, decision: 'violation',
          reasoning: 'Authored queue fixture judgment; no human correctness claim.', evidenceRefs: [proof.id], missingContext: [],
          anchorJudgments: [{ anchor, decision: 'violation', reasoning: 'Authored exact-source anchor.', evidenceRefs: [proof.id], missingContext: [] }] }] },
      'rule-revision-v2': revision.value,
    };
    const calls: string[] = [];
    const executions: string[] = [];
    const resolved: Array<{ workspaceId: string; jobDigest: string; expectedSha: string }> = [];
    const workspaces = new Map<string, WorkspaceIdentity>();
    let sequence = 0;
    const faults: { executeFailures: number; executeHangs: number; destroyFailure: boolean; onExecute?: () => void } =
      { executeFailures: 0, executeHangs: 0, destroyFailure: false };
    const backend: CodexWorkspaceBackend = {
      kind: 'authored-test-no-isolation',
      reserve(request, record) {
        const contract = request.outputContract;
        if (!contract) throw new Error('Application fixture requires a typed output contract');
        calls.push(`reserve:${contract}`);
        const number = ++sequence;
        const runtime: CodexWorkspaceRuntime = {
          async prepare() {
            calls.push('prepare');
            return { expectedSha: request.expectedSha, headSha: request.expectedSha,
              clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' };
          },
          async execute(signal) {
            calls.push('execute'); executions.push(contract); faults.onExecute?.();
            if (faults.executeFailures > 0) { faults.executeFailures--; throw new Error('Authored recoverable executor failure'); }
            if (faults.executeHangs > 0) { faults.executeHangs--; return new Promise(() => {}); }
            const requestPath = join(directory, `queue-request-${number}.json`);
            const executable = join(directory, `queue-cli-${number}.cjs`);
            await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const send=x=>console.log(JSON.stringify(x));send({type:'thread.started',thread_id:'authored-queue-sdk-session'});send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(values[contract])})}});send({type:'turn.completed',usage:${JSON.stringify(revisionUsage)}});});\n`, { mode: 0o700 });
            await writeFile(requestPath, JSON.stringify({ workingDirectory: record.worktreePath, model: request.model,
              prompt: request.prompt, outputContract: request.outputContract, toolPolicy: request.toolPolicy,
              historyPolicy: request.historyPolicy, limits: request.limits }));
            return JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], {
              kind: 'authored-test-no-isolation', fixtureRoot: directory, workingDirectory: record.worktreePath,
              requestPath, codexPathOverride: executable,
              imageConfig: { schemaVersion: 1, gateway: { kind: 'credential-isolated-gateway',
                baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } },
            }, signal));
          },
          async stop() { calls.push('stop'); return { stopped: true, verified: true }; },
          async collect() { calls.push('collect'); return []; },
          async destroy() { calls.push('destroy'); return { destroyed: !faults.destroyFailure, verified: !faults.destroyFailure }; },
        };
        return runtime;
      },
    };
    const resolveWorkspace = async (selection: { workspaceId: string; jobDigest: string; expectedSha: string }) => {
      resolved.push(selection);
      if (!['mining-workspace', 'review-workspace', 'revision-workspace'].includes(selection.workspaceId)) throw new Error('Unknown trusted workspace');
      let workspace = workspaces.get(selection.jobDigest);
      if (!workspace) {
        workspace = { repoPath: selection.workspaceId === 'revision-workspace' ? revision.repoPath : repoPath,
          runId: 'application-queue', attemptId: selection.jobDigest.slice(0, 24) };
        await prepareWorkspace({ ...workspace, baseSha: selection.expectedSha });
        workspaces.set(selection.jobDigest, workspace);
      }
      return workspace;
    };
    const jobs = {
      mining: { schemaVersion: 1 as const, kind: 'pr-mining' as const, requestDigest: miningRequest.digest,
        workspaceId: 'mining-workspace', candidateCreatedAt: miningDate },
      review: { schemaVersion: 1 as const, kind: 'semantic-review' as const, ruleDigest: rule.digest,
        snapshotDigest: snapshot.digest, workspaceId: 'review-workspace' },
      revision: { schemaVersion: 1 as const, kind: 'revision-generation' as const, requestDigest: revision.request.digest,
        snapshotDigest: revision.snapshot.digest, workspaceId: 'revision-workspace', candidateCreatedAt: revisionDate },
    };
    return { ...revision, storePath: join(directory, 'db'), jobs, miningRequest, reviewRule: rule, reviewSnapshot: snapshot,
      values, calls, executions, resolved, workspaces, faults, backend, resolveWorkspace,
      dependency: { id: 'authored-queue-runtime', backend, limits: revisionLimits }, config: revisionConfig };
  } catch (error) { await revision.cleanup(); throw error; }
}
