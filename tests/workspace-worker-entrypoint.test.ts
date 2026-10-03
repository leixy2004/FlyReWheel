import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runWorkspaceWorkerCommand, type AuthoredWorkspaceWorkerFixture } from '../src/workspace-worker-entrypoint.js';
import { ContextSemanticReviewModelResponseSchema, PerAnchorSemanticReviewModelResponseSchema, SemanticReviewModelResponseSchema } from '../src/core/semantic-review-model.js';
import { ProposalSchema as MatchedProposalSchema, ReviewSchema as MatchedReviewSchema } from '../src/core/matched-revision-model.js';
import { ComparisonApplicabilityModelResponseSchema } from '../src/core/comparison-applicability-model.js';
import { PrMiningModelResponseSchema } from '../src/core/pr-mining-model.js';
import { ComparisonApplicabilityWorkspaceWorkerResult, MatchedWorkspaceWorkerResult, PrMiningWorkspaceWorkerResult, SemanticReviewWorkspaceWorkerResult, WorkspaceWorkerGateway, WorkspaceWorkerResult } from '../src/workspace/worker-protocol.js';
import { workspaceEnvironment } from '../src/workspace/process.js';

const exec = promisify(execFile), project = fileURLToPath(new URL('..', import.meta.url));
const branch = 'attempt/authored--one', history = 'all-local-refs-v1';
const usage = { input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 };
const answer = { summary: 'Authored fixture only', changedFiles: [], checks: [], limitations: ['No model or sandbox was called'] };
const miningAnswer = { result: { status: 'candidate' as const,
  semantics: { title: 'Authored mining fixture', mechanism: 'A call can wait indefinitely.', invariant: 'Waits are bounded.',
    applicability: ['Calls without an outer deadline'], exceptions: [], requiredContext: ['Caller deadline'], expectedBehavior: 'An explicit bound is provided.' },
  paths: { include: ['src'], exclude: [] }, detectionAssets: [], evidenceRefs: ['case:authored-fixture'],
  rationale: 'Author-controlled executor output only; no model or sandbox was called.' } };
const insufficientAnswer = { result: { status: 'insufficient_evidence' as const,
  reasoning: 'Author-controlled fixture only; no model or sandbox was called.', missingEvidence: ['Caller context'], evidenceRefs: [] } };
const authoredAnchor = { snapshotDigest: 'b'.repeat(64), side: 'after' as const, path: 'src/read.ts', sourceDigest: 'c'.repeat(64),
  span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 2, offset: 1 } } };
const legacyReviewAnswer = { ruleDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), evidence: [],
  judgments: [{ targetId: 'd'.repeat(64), decision: 'unknown' as const, reasoning: 'Authored unknown target.', evidenceRefs: [], missingContext: ['policy'], findingAnchors: [] }] };
const perAnchorReviewAnswer = { ...legacyReviewAnswer, judgments: [{ targetId: 'd'.repeat(64), decision: 'unknown' as const,
  reasoning: 'Authored unresolved target.', evidenceRefs: [], missingContext: ['policy'], anchorJudgments: [{
    anchor: authoredAnchor, decision: 'unknown' as const, reasoning: 'Authored unresolved anchor.', evidenceRefs: [], missingContext: ['policy'],
  }] }] };
const contextReviewAnswer = { ...perAnchorReviewAnswer, repositoryContextDigests: ['e'.repeat(64)],
  evidence: [{ id: 'f'.repeat(64), kind: 'local-policy', content: 'x', anchor: { kind: 'repository-context' as const,
    contextDigest: 'e'.repeat(64), repositoryId: 'authored/repository', head: 'a'.repeat(40), path: 'policy.txt',
    objectId: 'b'.repeat(40), mode: '100644' as const, sourceDigest: 'c'.repeat(64), span: authoredAnchor.span } }] };
const applicabilityAnswer = { bindingDigest: 'a'.repeat(64), decision: 'UNKNOWN' as const, reasoning: 'Authored unresolved applicability.', evidence: [], evidenceRefs: [], missingContext: ['policy'] };
const matchedProposalAnswer = { action: 'abstain', state: null, replacement: null, rationale: 'Authored non-mutation only', evidenceRefs: [], missingEvidence: [], nextStep: null };
const matchedReviewAnswer = { judgments: [{ targetId: 'authored-target', prediction: 'unresolved', reason: 'missing_context', rationale: 'Authored unresolved issue', evidenceRefs: [], missingEvidence: ['Caller context'] }] };
const gateway = { kind: 'credential-isolated-gateway' as const, baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' };
let root: string, compiled: string, counter = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'flyrewheel-entrypoint-test-'));
  // Compile fresh into node_modules so standard ESM dependency resolution works;
  // the published dist tree is never silently reused by this acceptance test.
  compiled = await mkdtemp(join(project, 'node_modules/.worker-cli-test-'));
  await exec(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '-p', 'deploy/tsconfig.build.json', '--outDir', compiled], { cwd: project, timeout: 30_000 });
}, 30_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); await rm(compiled, { recursive: true, force: true }); });

async function fixture(code?: string, outputContract?: 'pr-mining-v1' | 'semantic-review-v1' | 'semantic-review-v2' | 'semantic-review-v3' | 'comparison-applicability-v1' | 'matched-proposal-v1' | 'matched-review-v1') {
  const fixtureRoot = join(root, String(++counter)); await mkdir(fixtureRoot);
  const workingDirectory = join(fixtureRoot, 'repo'); await mkdir(workingDirectory);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', args, { cwd: workingDirectory, env: { ...workspaceEnvironment(),
    GIT_AUTHOR_NAME: 'Authored', GIT_AUTHOR_EMAIL: 'authored@example.invalid', GIT_COMMITTER_NAME: 'Authored', GIT_COMMITTER_EMAIL: 'authored@example.invalid' } })).stdout.trim();
  await git('init', '-qb', 'main');
  await writeFile(join(workingDirectory, 'tracked.txt'), 'first\n');
  await writeFile(join(workingDirectory, '.gitignore'), 'ignored.txt\n');
  await git('add', '.'); await git('commit', '-qm', 'first'); const sha = await git('rev-parse', 'HEAD');
  await writeFile(join(workingDirectory, 'tracked.txt'), 'later\n'); await git('commit', '-qam', 'later');
  await git('checkout', '-qb', branch, sha);
  const codexPathOverride = join(fixtureRoot, 'authored-cli.cjs');
  await writeFile(codexPathOverride, `#!${process.execPath}\nconst send = x => console.log(JSON.stringify(x));
process.stdin.resume();process.stdin.on('end',()=> {${code ?? success()}});\n`, { mode: 0o700 });
  const requestPath = join(fixtureRoot, 'request.json');
  const input = { workingDirectory, model: 'authored-model', prompt: 'Authored protocol test only',
    ...(outputContract === undefined ? {} : { outputContract }),
    ...(outputContract?.startsWith('matched-') ? { matchedExecution: { kind: 'authored-script-controls-not-enforced' } } : {}),
    toolPolicy: outputContract === 'comparison-applicability-v1' || outputContract?.startsWith('matched-') ? 'selected-evidence-no-tools-v1' : 'full-repo-shell-v1', historyPolicy: history,
    limits: { maxInputBytes: 32_768, maxOutputBytes: 32_768, maxArtifactBytes: 4096, maxArtifacts: 4, timeoutMs: 1000, cleanupTimeoutMs: 1500 } };
  await writeFile(requestPath, JSON.stringify(input));
  const options: AuthoredWorkspaceWorkerFixture = { kind: 'authored-test-no-isolation', fixtureRoot, workingDirectory, requestPath,
    codexPathOverride, imageConfig: { schemaVersion: 1, gateway } };
  return { options, input, git, sha, repo: workingDirectory, run: () => runWorkspaceWorkerCommand(['run', requestPath], options),
    verify: () => runWorkspaceWorkerCommand(['verify', sha, branch, history], options).then(JSON.parse) };
}
function success(expression = JSON.stringify(answer)) { return `send({type:'thread.started',thread_id:'authored-session'});
send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${expression})}});
send({type:'turn.completed',usage:${JSON.stringify(usage)}});`; }

describe('immutable-image worker protocol with authored fake CLI only', () => {
  it('observes exact historical SHA while keeping later local refs and full history', async () => {
    const f = await fixture();
    expect(await f.verify()).toEqual({ expectedSha: f.sha, headSha: f.sha, clean: true, identityValid: true, historyPolicy: history });
    expect(await f.git('rev-list', '--all', '--count')).toBe('2');
    expect(JSON.parse(await runWorkspaceWorkerCommand(['verify', 'a'.repeat(40), branch, history], f.options))).toMatchObject({ headSha: f.sha, identityValid: false });
  });
  it.each(['tracked', 'ignored', 'untracked', 'assume-unchanged', 'skip-worktree', 'mode'])('does not claim cleanliness for %s changes', async kind => {
    const f = await fixture();
    if (kind === 'tracked') await writeFile(join(f.repo, 'tracked.txt'), 'changed');
    else if (kind === 'mode') { await f.git('config', 'core.filemode', 'false'); await chmod(join(f.repo, 'tracked.txt'), 0o755); }
    else if (kind === 'assume-unchanged' || kind === 'skip-worktree') await f.git('update-index', `--${kind}`, 'tracked.txt');
    else await writeFile(join(f.repo, `${kind}.txt`), 'untracked');
    expect(await f.verify()).toMatchObject({ clean: false });
  });
  it.each(['include.path', 'filter.authored.clean', 'core.fsmonitor', 'remote.origin.promisor', 'extensions.partialclone'])('rejects repository setting %s before running Git history/status', async key => {
    const f = await fixture(); await f.git('config', key, 'authored');
    await expect(f.verify()).rejects.toThrow(/configuration/);
  });
  it.each(['.git/shallow', '.git/info/grafts', '.git/objects/info/alternates', '.git/config.worktree'])('rejects partial/external history marker %s', async path => {
    const f = await fixture(); await writeFile(join(f.repo, path), f.sha + '\n');
    await expect(f.verify()).rejects.toThrow(/configuration/);
  });
  it('rejects repository/ancestor Codex config and Git control symlinks', async () => {
    const f = await fixture(); await mkdir(join(f.options.fixtureRoot, '.codex'));
    await expect(f.verify()).rejects.toThrow(/configuration/);
    await rm(join(f.options.fixtureRoot, '.codex'), { recursive: true });
    const original = await readFile(join(f.repo, '.git/config'));
    await writeFile(join(f.options.fixtureRoot, 'external-config'), original);
    await rm(join(f.repo, '.git/config')); await symlink(join(f.options.fixtureRoot, 'external-config'), join(f.repo, '.git/config'));
    await expect(f.verify()).rejects.toThrow(/control file/);
  });
  it('returns a typed official SDK result using only trusted gateway config and an empty CLI environment', async () => {
    const expression = `{...${JSON.stringify(answer)},checks:[{command:process.argv.slice(2).join(' '),outcome:'not-run',detail:JSON.stringify(Object.keys(process.env).sort())}]}`;
    const f = await fixture(success(expression)); const result = JSON.parse(await f.run());
    expect(result).toMatchObject({ protocolVersion: 1, value: { summary: answer.summary }, usage, sessionId: 'authored-session', boundary: 'authored-test-no-isolation', processEvidence: { processGroupStopped: true } });
    expect(result.value.checks[0].command).toContain('model_provider="flyrewheel_gateway"');
    expect(result.value.checks[0].command).toContain('model_providers.flyrewheel_gateway.requires_openai_auth=false');
    expect(result.value.checks[0].command).toContain('model_providers.flyrewheel_gateway.base_url="https://gateway.example.invalid/v1"');
    expect(JSON.parse(result.value.checks[0].detail)).toEqual(['CODEX_HOME', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'HOME', 'LANG', 'LC_ALL', 'PATH']);
    expect(WorkspaceWorkerResult.safeParse(result).success).toBe(true);
    expect(result).not.toHaveProperty('outputContract');
    expect(PrMiningWorkspaceWorkerResult.safeParse(result).success).toBe(false);
  });
  it.each([miningAnswer, insufficientAnswer])('uses the fixed mining schema through the official SDK with an authored executor, no model call: $result.status', async value => {
    const schema = z.toJSONSchema(PrMiningModelResponseSchema);
    const code = `const args=process.argv.slice(2),path=args[args.indexOf('--output-schema')+1];
const schema=JSON.parse(require('node:fs').readFileSync(path,'utf8'));
if(JSON.stringify(schema)!==${JSON.stringify(JSON.stringify(schema))}) throw new Error('Wrong fixed schema');
${success(JSON.stringify(value))}`;
    const f = await fixture(code, 'pr-mining-v1');
    const result = PrMiningWorkspaceWorkerResult.parse(JSON.parse(await f.run()));
    expect(result).toMatchObject({ protocolVersion: 2, outputContract: 'pr-mining-v1', value, usage,
      sessionId: 'authored-session', boundary: 'authored-test-no-isolation',
      processEvidence: { reason: 'completed', exitCode: 0, processGroupStopped: true } });
    expect(WorkspaceWorkerResult.safeParse(result).success).toBe(false);
    expect(PrMiningWorkspaceWorkerResult.safeParse({ ...result, protocolVersion: 1 }).success).toBe(false);
    expect(PrMiningWorkspaceWorkerResult.safeParse({ ...result, outputContract: 'other' }).success).toBe(false);
    expect(PrMiningWorkspaceWorkerResult.safeParse({ ...result, arbitrary: true }).success).toBe(false);
  });
  it.each(['semantic-review-v1', 'semantic-review-v2', 'semantic-review-v3'] as const)('selects the immutable fixed SDK review schema for %s', async contract => {
    const schema = z.toJSONSchema(contract === 'semantic-review-v1' ? SemanticReviewModelResponseSchema
      : contract === 'semantic-review-v2' ? PerAnchorSemanticReviewModelResponseSchema : ContextSemanticReviewModelResponseSchema);
    const value = contract === 'semantic-review-v1' ? legacyReviewAnswer : contract === 'semantic-review-v2' ? perAnchorReviewAnswer : contextReviewAnswer;
    const code = `const args=process.argv.slice(2),path=args[args.indexOf('--output-schema')+1];
const schema=JSON.parse(require('node:fs').readFileSync(path,'utf8'));
if(JSON.stringify(schema)!==${JSON.stringify(JSON.stringify(schema))}) throw new Error('Wrong fixed schema');
${success(JSON.stringify(value))}`;
    const f = await fixture(code, contract);
    expect(SemanticReviewWorkspaceWorkerResult.parse(JSON.parse(await f.run()))).toMatchObject({ protocolVersion: 2,
      outputContract: contract, value, boundary: 'authored-test-no-isolation', processEvidence: { processGroupStopped: true } });
  });
  it('uses the fixed applicability schema and disables shell and every tool in the authored SDK harness', async () => {
    const schema = z.toJSONSchema(ComparisonApplicabilityModelResponseSchema);
    const code = `const args=process.argv.slice(2),path=args[args.indexOf('--output-schema')+1];
const schema=JSON.parse(require('node:fs').readFileSync(path,'utf8'));
if(JSON.stringify(schema)!==${JSON.stringify(JSON.stringify(schema))}) throw new Error('Wrong fixed schema');
if(!args.includes('features.shell_tool=false') || !args.includes('features.unified_exec=false') || !args.includes('read-only')) throw new Error('Wrong no-tools policy');
${success(JSON.stringify(applicabilityAnswer))}`;
    const f = await fixture(code, 'comparison-applicability-v1');
    expect(ComparisonApplicabilityWorkspaceWorkerResult.parse(JSON.parse(await f.run()))).toMatchObject({ protocolVersion: 2,
      outputContract: 'comparison-applicability-v1', value: applicabilityAnswer, boundary: 'authored-test-no-isolation' });
    await writeFile(f.options.requestPath, JSON.stringify({ ...f.input, toolPolicy: 'full-repo-shell-v1' }));
    await expect(f.run()).rejects.toThrow(/selected-evidence/);
  });
  it.each([
    { id: 'cmd', type: 'command_execution', command: 'authored', aggregated_output: 'ok', exit_code: 0, status: 'completed' },
    { id: 'file', type: 'file_change', changes: [], status: 'completed' },
    { id: 'todo', type: 'todo_list', items: [] },
    { id: 'mcp', type: 'mcp_tool_call' },
    { id: 'web', type: 'web_search' },
  ])('rejects $type events for applicability even when final JSON is valid', async item => {
    const f = await fixture(`send({type:'item.completed',item:${JSON.stringify(item)}});${success(JSON.stringify(applicabilityAnswer))}`, 'comparison-applicability-v1');
    await expect(f.run()).rejects.toThrow(/cannot use tools|Unexpected workspace tool/);
  });
  it.each([perAnchorReviewAnswer, { ...applicabilityAnswer, execution: 'completed' }, { ...applicabilityAnswer, decision: 'safe' }])('rejects applicability cross-contract or provenance injection %#', async value => {
    const f = await fixture(success(JSON.stringify(value)), 'comparison-applicability-v1');
    await expect(f.run()).rejects.toThrow();
  });
  it.each(['semantic-review-v1', 'semantic-review-v2', 'semantic-review-v3'] as const)('rejects the other review version for requested %s', async contract => {
    const value = contract === 'semantic-review-v2' ? legacyReviewAnswer : perAnchorReviewAnswer;
    const f = await fixture(success(JSON.stringify(value)), contract);
    await expect(f.run()).rejects.toThrow();
  });
  it.each(['semantic-review-v1', 'semantic-review-v2'] as const)('rejects repository-context evidence in legacy %s even without the new digest field', async contract => {
    const value = contract === 'semantic-review-v1' ? legacyReviewAnswer : perAnchorReviewAnswer;
    const f = await fixture(success(JSON.stringify({ ...value, evidence: contextReviewAnswer.evidence })), contract);
    await expect(f.run()).rejects.toThrow();
  });
  it('rejects legacy/mining response confusion and model-writable provenance in the mining contract', async () => {
    for (const [value, outputContract] of [
      [answer, 'pr-mining-v1'], [miningAnswer, undefined],
      [{ result: { ...miningAnswer.result, provenance: { reviewedBy: 'claimed' } } }, 'pr-mining-v1'],
      [{ result: { ...insufficientAnswer.result, unexpected: true } }, 'pr-mining-v1'],
    ] as const) {
      const f = await fixture(success(JSON.stringify(value)), outputContract);
      await expect(f.run()).rejects.toThrow();
    }
  });
  it.each([undefined, 'pr-mining-v1'] as const)('blocks the shipped production profile before launching the CLI (contract %s)', async outputContract => {
    const f = await fixture('throw new Error("must not run")', outputContract); f.options.imageConfig.gateway = { kind: 'blocked' };
    await expect(f.run()).rejects.toThrow(/gateway connection/);
  });
  it('rejects request unknown fields, credential config, byte excess, symlinks and noncanonical paths', async () => {
    const f = await fixture();
    for (const patch of [{ gateway }, { codexPathOverride: f.options.codexPathOverride }, { apiKey: 'authored-nonsecret' },
      { outputContract: 'arbitrary-schema' }, { outputContract: null }, { outputSchema: { type: 'object' } },
      { workingDirectory: '/tmp/../tmp' }, { limits: { ...f.input.limits, maxInputBytes: 1 } }]) {
      await writeFile(f.options.requestPath, JSON.stringify({ ...f.input, ...patch })); await expect(f.run()).rejects.toThrow();
    }
    await writeFile(f.options.requestPath, ' '.repeat(2_097_153)); await expect(f.run()).rejects.toThrow(/oversized/);
    await rm(f.options.requestPath); await symlink(join(f.repo, 'tracked.txt'), f.options.requestPath); await expect(f.run()).rejects.toThrow();
  });
  it('bounds the final serialized envelope independently of raw SDK output', async () => {
    const f = await fixture(); f.input.limits.maxOutputBytes = 450;
    await writeFile(f.options.requestPath, JSON.stringify(f.input));
    await expect(f.run()).rejects.toThrow(/Serialized worker result exceeds output limit/);
  });
  it('bounds cumulative SDK event count even when raw output remains under the byte limit', async () => {
    const f = await fixture(`for(let i=0;i<10001;i++) send({type:'turn.started'});`);
    f.input.limits.maxOutputBytes = 1_048_576; f.input.limits.timeoutMs = 3000;
    await writeFile(f.options.requestPath, JSON.stringify(f.input));
    await expect(f.run()).rejects.toThrow(/event stream exceeds its bounds/);
  });
  it.each([
    [{ ...gateway, baseUrl: 'http://gateway.example.invalid/v1' }],
    [{ ...gateway, baseUrl: 'https://other.example.invalid/v1' }],
    [{ ...gateway, baseUrl: 'https://user:authored@gateway.example.invalid/v1' }],
    [{ ...gateway, baseUrl: 'https://gateway.example.invalid/v1?key=authored' }],
    [{ ...gateway, apiKey: 'authored' }],
  ])('rejects unsafe or credential-bearing trusted gateway profile %#', config => {
    expect(() => WorkspaceWorkerGateway.parse(config)).toThrow();
  });
  it.each([
    ['duplicate completion', success() + `send({type:'turn.completed',usage:${JSON.stringify(usage)}});`],
    ['post-completion item', success() + `send({type:'item.completed',item:{id:'late',type:'agent_message',text:'{}'}});`],
    ['unknown event', `send({type:'unrecognized'});`],
    ['malformed item', `send({type:'item.completed',item:{id:'bad',type:'agent_message',text:42}});`],
    ['duplicate thread', `send({type:'thread.started',thread_id:'one'});` + success()],
    ['invalid answer', success('{summary:42}')],
    ['missing completion', `send({type:'thread.started',thread_id:'one'});`],
    ['failed turn', `send({type:'turn.failed',error:{message:'authored'}});`],
  ])('rejects %s', async (_name, code) => { const f = await fixture(code); await expect(f.run()).rejects.toThrow(); });
  it('accepts supported progress, command, file and to-do events before the final answer', async () => {
    const f = await fixture(`send({type:'turn.started'});
send({type:'item.completed',item:{id:'progress',type:'agent_message',text:'Inspecting fixture'}});
send({type:'item.completed',item:{id:'reasoning',type:'reasoning',text:'Authored summary'}});
send({type:'item.completed',item:{id:'cmd',type:'command_execution',command:'authored',aggregated_output:'ok',exit_code:0,status:'completed'}});
send({type:'item.completed',item:{id:'files',type:'file_change',changes:[],status:'completed'}});
send({type:'item.updated',item:{id:'todo',type:'todo_list',items:[{text:'Inspect fixture',completed:true}]}});${success()}`);
    expect(JSON.parse(await f.run()).value).toEqual(answer);
  });
});

describe.each(['source', 'compiled'] as const)('%s executable acceptance', mode => {
  const command = () => mode === 'source' ? ['--import', import.meta.resolve('tsx'), join(project, 'src/workspace-worker-entrypoint.ts')]
    : [join(compiled, 'workspace-worker-entrypoint.js')];
  it('executes the adapter verify argv in an explicit fixture harness and emits one observation', async () => {
    const f = await fixture();
    const module = mode === 'source' ? join(project, 'src/workspace-worker-entrypoint.ts') : join(compiled, 'workspace-worker-entrypoint.js');
    const harness = join(f.options.fixtureRoot, 'verify.mjs');
    await writeFile(harness, `import { workspaceWorkerMain } from ${JSON.stringify(pathToFileURL(module).href)}; await workspaceWorkerMain(process.argv.slice(2),${JSON.stringify(f.options)});`);
    const result = await exec(process.execPath, [...(mode === 'source' ? ['--import', import.meta.resolve('tsx')] : []), harness, 'verify', f.sha, branch, history], { cwd: f.repo, env: workspaceEnvironment(), timeout: 10_000 });
    expect(result.stderr).toBe(''); expect(result.stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ headSha: f.sha, clean: true, identityValid: true });
  });
  it('the unmodified production CLI refuses real ancestor config instead of using the fixture seam', async () => {
    const f = await fixture(); await mkdir(join(f.options.fixtureRoot, '.codex'));
    await expect(exec(process.execPath, [...command(), 'verify', f.sha, branch, history], { cwd: f.repo, env: workspaceEnvironment() }))
      .rejects.toMatchObject({ code: 1, stdout: '', stderr: '{"error":"WORKSPACE_WORKER_FAILED"}\n' });
  });
  it('runs the full official-SDK bridge through an authored harness without a production fixture switch', async () => {
    const f = await fixture();
    const module = mode === 'source' ? join(project, 'src/workspace-worker-entrypoint.ts') : join(compiled, 'workspace-worker-entrypoint.js');
    const harness = join(f.options.fixtureRoot, 'harness.mjs');
    await writeFile(harness, `import { workspaceWorkerMain } from ${JSON.stringify(pathToFileURL(module).href)}; await workspaceWorkerMain(['run',${JSON.stringify(f.options.requestPath)}],${JSON.stringify(f.options)});`);
    const result = await exec(process.execPath, [...(mode === 'source' ? ['--import', import.meta.resolve('tsx')] : []), harness], { cwd: f.repo, env: workspaceEnvironment(), timeout: 10_000 });
    expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout)).toMatchObject({ protocolVersion: 1, value: answer, boundary: 'authored-test-no-isolation' });
  });
  it('emits the mining envelope through an authored SDK executor harness, no model call or isolation claim', async () => {
    const f = await fixture(success(JSON.stringify(miningAnswer)), 'pr-mining-v1');
    const module = mode === 'source' ? join(project, 'src/workspace-worker-entrypoint.ts') : join(compiled, 'workspace-worker-entrypoint.js');
    const harness = join(f.options.fixtureRoot, 'mining-harness.mjs');
    await writeFile(harness, `import { workspaceWorkerMain } from ${JSON.stringify(pathToFileURL(module).href)}; await workspaceWorkerMain(['run',${JSON.stringify(f.options.requestPath)}],${JSON.stringify(f.options)});`);
    const result = await exec(process.execPath, [...(mode === 'source' ? ['--import', import.meta.resolve('tsx')] : []), harness], { cwd: f.repo, env: workspaceEnvironment(), timeout: 10_000 });
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n')).toHaveLength(2);
    expect(PrMiningWorkspaceWorkerResult.parse(JSON.parse(result.stdout))).toMatchObject({ protocolVersion: 2,
      outputContract: 'pr-mining-v1', value: miningAnswer, usage, boundary: 'authored-test-no-isolation' });
  });
  it('emits the per-anchor review envelope through the authored SDK executable harness', async () => {
    const f = await fixture(success(JSON.stringify(perAnchorReviewAnswer)), 'semantic-review-v2');
    const module = mode === 'source' ? join(project, 'src/workspace-worker-entrypoint.ts') : join(compiled, 'workspace-worker-entrypoint.js');
    const harness = join(f.options.fixtureRoot, 'review-harness.mjs');
    await writeFile(harness, `import { workspaceWorkerMain } from ${JSON.stringify(pathToFileURL(module).href)}; await workspaceWorkerMain(['run',${JSON.stringify(f.options.requestPath)}],${JSON.stringify(f.options)});`);
    const result = await exec(process.execPath, [...(mode === 'source' ? ['--import', import.meta.resolve('tsx')] : []), harness], { cwd: f.repo, env: workspaceEnvironment(), timeout: 10_000 });
    expect(result.stderr).toBe('');
    expect(SemanticReviewWorkspaceWorkerResult.parse(JSON.parse(result.stdout))).toMatchObject({ protocolVersion: 2,
      outputContract: 'semantic-review-v2', value: perAnchorReviewAnswer, boundary: 'authored-test-no-isolation' });
  });
  it('emits the applicability envelope through the authored SDK executable harness', async () => {
    const f = await fixture(success(JSON.stringify(applicabilityAnswer)), 'comparison-applicability-v1');
    const module = mode === 'source' ? join(project, 'src/workspace-worker-entrypoint.ts') : join(compiled, 'workspace-worker-entrypoint.js');
    const harness = join(f.options.fixtureRoot, 'applicability-harness.mjs');
    await writeFile(harness, `import { workspaceWorkerMain } from ${JSON.stringify(pathToFileURL(module).href)}; await workspaceWorkerMain(['run',${JSON.stringify(f.options.requestPath)}],${JSON.stringify(f.options)});`);
    const result = await exec(process.execPath, [...(mode === 'source' ? ['--import', import.meta.resolve('tsx')] : []), harness], { cwd: f.repo, env: workspaceEnvironment(), timeout: 10_000 });
    expect(result.stderr).toBe('');
    expect(ComparisonApplicabilityWorkspaceWorkerResult.parse(JSON.parse(result.stdout))).toMatchObject({ protocolVersion: 2,
      outputContract: 'comparison-applicability-v1', value: applicabilityAnswer, boundary: 'authored-test-no-isolation' });
  });
  it.each((['matched-proposal-v1', 'matched-review-v1'] as const).flatMap(contract =>
    ([undefined, 'low', 'xhigh'] as const).map(modelReasoningEffort => ({ contract, modelReasoningEffort }))))
  ('uses the fixed $contract contract with reasoning effort $modelReasoningEffort through the authored SDK executable harness', async ({ contract, modelReasoningEffort }) => {
    const value = contract === 'matched-proposal-v1' ? matchedProposalAnswer : matchedReviewAnswer;
    const schema = z.toJSONSchema(contract === 'matched-proposal-v1' ? MatchedProposalSchema : MatchedReviewSchema);
    const code = `const args=process.argv.slice(2),path=args[args.indexOf('--output-schema')+1];
require('node:fs').writeFileSync(args[args.indexOf('--cd')+1]+'/sdk-args.json',JSON.stringify(args));
if(JSON.stringify(JSON.parse(require('node:fs').readFileSync(path,'utf8')))!==${JSON.stringify(JSON.stringify(schema))}) throw new Error('Wrong fixed schema');
if(!args.includes('features.shell_tool=false') || !args.includes('features.unified_exec=false') || !args.includes('read-only')) throw new Error('Wrong no-tools policy');
${success(JSON.stringify(value))}`;
    const f = await fixture(code, contract);
    const input = { ...f.input, ...(modelReasoningEffort === undefined ? {} : { modelReasoningEffort }) };
    await writeFile(f.options.requestPath, JSON.stringify(input));
    const module = mode === 'source' ? join(project, 'src/workspace-worker-entrypoint.ts') : join(compiled, 'workspace-worker-entrypoint.js');
    const harness = join(f.options.fixtureRoot, 'matched-harness.mjs');
    await writeFile(harness, `import { workspaceWorkerMain } from ${JSON.stringify(pathToFileURL(module).href)}; await workspaceWorkerMain(['run',${JSON.stringify(f.options.requestPath)}],${JSON.stringify(f.options)});`);
    const result = await exec(process.execPath, [...(mode === 'source' ? ['--import', import.meta.resolve('tsx')] : []), harness], { cwd: f.repo, env: workspaceEnvironment(), timeout: 10_000 });
    expect(result.stderr).toBe('');
    const envelope = MatchedWorkspaceWorkerResult.parse(JSON.parse(result.stdout));
    expect(envelope).toMatchObject({ protocolVersion: 2,
      outputContract: contract, value, boundary: 'authored-test-no-isolation', processEvidence: { processGroupStopped: true } });
    const args: string[] = JSON.parse(await readFile(join(f.repo, 'sdk-args.json'), 'utf8'));
    const expected = modelReasoningEffort === undefined ? [] : [`model_reasoning_effort="${modelReasoningEffort}"`];
    expect(args.filter(arg => arg.startsWith('model_reasoning_effort='))).toEqual(expected);
    if (modelReasoningEffort === undefined) expect(envelope.processEvidence).not.toHaveProperty('modelReasoningEffort');
    else {
      expect(args[args.indexOf(expected[0]) - 1]).toBe('--config');
      expect(envelope.processEvidence.modelReasoningEffort).toBe(modelReasoningEffort);
    }
    expect(args.some(arg => /temperature|seed|max_output_tokens|resume/.test(arg))).toBe(false);
    await writeFile(f.options.requestPath, JSON.stringify({ ...input, toolPolicy: 'full-repo-shell-v1' }));
    await expect(f.run()).rejects.toThrow(/selected-evidence/);
    await writeFile(f.options.requestPath, JSON.stringify({ ...input, matchedExecution: { kind: 'enforce-frozen-controls', sampler: { temperature: 0, seed: 1 }, maxOutputTokens: 100 } }));
    await expect(f.run()).rejects.toThrow(/unsupported before dispatch/);
  });
  it.each([null, 'none', 'high '])('rejects invalid reasoning effort %# before authored CLI launch', async modelReasoningEffort => {
    const code = `require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--cd')+1]+'/launched','unexpected');${success(JSON.stringify(matchedProposalAnswer))}`;
    const f = await fixture(code, 'matched-proposal-v1');
    await writeFile(f.options.requestPath, JSON.stringify({ ...f.input, modelReasoningEffort }));
    const module = mode === 'source' ? join(project, 'src/workspace-worker-entrypoint.ts') : join(compiled, 'workspace-worker-entrypoint.js');
    const harness = join(f.options.fixtureRoot, 'invalid-reasoning-harness.mjs');
    await writeFile(harness, `import { workspaceWorkerMain } from ${JSON.stringify(pathToFileURL(module).href)}; await workspaceWorkerMain(['run',${JSON.stringify(f.options.requestPath)}],${JSON.stringify(f.options)});`);
    await expect(exec(process.execPath, [...(mode === 'source' ? ['--import', import.meta.resolve('tsx')] : []), harness],
      { cwd: f.repo, env: workspaceEnvironment(), timeout: 10_000 })).rejects.toMatchObject({
        code: 1, stdout: '', stderr: '{"error":"WORKSPACE_WORKER_FAILED"}\n' });
    await expect(access(join(f.repo, 'launched'))).rejects.toThrow();
  });
  it('fails closed on production run and unknown CLI arguments without echoing data', async () => {
    await expect(exec(process.execPath, [...command(), 'run', '/run/flyrewheel/request.json'], { cwd: project })).rejects.toMatchObject({ code: 78, stdout: '', stderr: '{"error":"WORKSPACE_WORKER_PRODUCTION_BLOCKED"}\n' });
    await expect(exec(process.execPath, [...command(), 'run', 'AUTHORED-PROMPT-MUST-NOT-ECHO'], { cwd: project })).rejects.toMatchObject({ code: 1, stdout: '', stderr: '{"error":"WORKSPACE_WORKER_FAILED"}\n' });
  });
});
