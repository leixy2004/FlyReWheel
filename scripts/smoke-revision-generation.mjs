// Offline compiled application smoke. Official SDK + authored CLI, no network/model/isolation claims.
// Run after npm run build. Temporary fixture Git/database/workspaces are removed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd(), fromDist = path => import(pathToFileURL(join(root, 'dist', path)));
const { QualEvoStore } = await fromDist('storage/store.js');
const { workspaceGit } = await fromDist('workspace/process.js');
const { prepareWorkspace, cleanupWorkspace } = await fromDist('workspace/index.js');
const { captureRepositoryContext, makeRepositoryContextAnchor, makeRepositoryContextEvidence } = await fromDist('repository-context.js');
const { revisionRepositoryContextBindings } = await fromDist('revision-generation.js');
const contextEnabled = process.argv.includes('--context');
const { captureChangeSnapshot } = await fromDist('change-snapshot.js');
const { sourceDigest } = await fromDist('adapters/candidates.js');
const { makeReviewEvidence, makeSnapshotAnchor } = await fromDist('adapters/semantic-review-fixture.js');
const { reviewTargetId } = await fromDist('core/semantic-review.js');
const { generateRuleRevision } = await fromDist('rule-revision.js');
const { runWorkspaceWorkerCommand } = await fromDist('workspace-worker-entrypoint.js');
const directory = await mkdtemp(join(tmpdir(), 'compiled-revision-fixture-'));
const exec = promisify(execFile);
let store;
try {
  const repoPath = join(directory, 'repo'), repository = 'fixture:compiled-revision', date = '2026-10-02T00:00:00Z';
  await mkdir(join(repoPath, 'src'), { recursive: true });
  const git = async (...args) => (await workspaceGit(repoPath, ...args)).trim();
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Authored Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  const policyPath = 'contracts/guard.txt', policySource = 'Captured contract: an applicable guard permits the exact guarded danger call.\n';
  if (contextEnabled) { await mkdir(join(repoPath, 'contracts')); await writeFile(join(repoPath, policyPath), policySource); await writeFile(join(repoPath, 'contracts/unused.txt'), 'UNCITED_CONTEXT_SENTINEL\n'); }
  await writeFile(join(repoPath, '.gitignore'), '.sandcastle/\n'); await git('add', '.'); await git('commit', '-m', 'authored before'); const base = await git('rev-parse', 'HEAD');
  const sources = [{ id: 'positive', path: 'src/positive.ts', source: 'danger(one);\n', expected: 'violation', role: 'positive' },
    { id: 'safe', path: 'src/safe.ts', source: 'guard(one); danger(one);\n', expected: 'safe', role: 'negative' }];
  for (const item of sources) await writeFile(join(repoPath, item.path), item.source);
  await git('add', '.'); await git('commit', '-m', 'authored after'); const head = await git('rev-parse', 'HEAD');
  const captured = await captureChangeSnapshot({ repositoryPath: repoPath, repositoryId: repository, baseTip: base, head });
  const dbPath = join(directory, 'db'); store = await QualEvoStore.openPGlite(dbPath);
  const snapshot = await store.importChangeSnapshot(captured.snapshot);
  const repositoryContexts = contextEnabled ? [await store.importRepositoryContext((await captureRepositoryContext({ repositoryPath: repoPath, repositoryId: repository, head, paths: [policyPath, 'contracts/unused.txt'] })).context)] : [];
  const reviewOptions = contextEnabled ? { repositoryContextDigests: repositoryContexts.map(item => item.digest) } : {};
  const policyEvidence = contextEnabled ? makeRepositoryContextEvidence(repositoryContexts[0], makeRepositoryContextAnchor(repositoryContexts[0], policyPath, 0, policySource.length), 'guard-contract') : null;
  const cases = sources.map(item => ({ id: item.id, lineageId: item.id, split: 'training', expected: item.expected, title: 'Authored compiled regression',
    repository, commit: head, path: item.path, sourceDigest: sourceDigest(item.source), provenance: { kind: 'synthetic', reference: 'fixture:compiled-revision', reviewedBy: null, derivedFromCaseId: null } }));
  const baseInput = { schemaVersion: 2, ruleId: 'compiled-revision-rule', version: 'base',
    semantics: { title: 'Danger needs a guard', mechanism: 'Missing guard', invariant: 'Use an applicable guard', applicability: ['Danger calls'], exceptions: [], requiredContext: contextEnabled ? ['guard-contract'] : [], expectedBehavior: 'Preserve unknown' },
    scope: { repositories: [repository], paths: { include: ['src'], exclude: [] } }, detectionAssets: [{ id: 'danger', detector: { kind: 'ast-grep', language: 'typescript', pattern: 'danger($ARG)' } }],
    regressionCases: sources.map(item => ({ caseId: item.id, role: item.role })),
    provenance: { sourceCases: [{ caseId: cases[0].id, repository, commit: head, path: cases[0].path, sourceDigest: cases[0].sourceDigest }], parentDigest: null, author: 'authored-fixture', createdAt: date, rationale: 'Offline smoke only' } };
  const baseRule = await store.importRuleVersion(baseInput, cases);
  const fixtures = (rule, states) => {
    const evidence = [], judgments = [];
    sources.forEach((item, index) => {
      const start = item.source.indexOf('danger(one)'), anchor = makeSnapshotAnchor(snapshot, 'after', item.path, start, start + 'danger(one)'.length);
      const proof = makeReviewEvidence(snapshot, anchor, 'captured-source'); evidence.push(proof);
      judgments.push({ targetId: reviewTargetId(rule.digest, snapshot.digest, index, item.path, sourceDigest(item.source)), decision: states[index], reasoning: 'Authored judgment only',
        evidenceRefs: [proof.id], findingAnchors: states[index] === 'unknown' ? [] : [anchor] });
    });
    if (contextEnabled) return { schemaVersion: 3, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest, snapshotDigest: snapshot.digest,
      repositoryContextDigests: reviewOptions.repositoryContextDigests, evidence: [...evidence, policyEvidence], judgments: judgments.map(j => ({
        targetId: j.targetId, decision: j.decision, reasoning: j.reasoning, evidenceRefs: [...j.evidenceRefs, policyEvidence.id], missingContext: [],
        anchorJudgments: j.findingAnchors.map(anchor => ({ anchor, decision: j.decision, reasoning: j.reasoning, evidenceRefs: [...j.evidenceRefs, policyEvidence.id], missingContext: [] })) })) };
    return { schemaVersion: 1, kind: 'semantic-review-offline-fixtures', ruleDigest: rule.digest, snapshotDigest: snapshot.digest, evidence, judgments };
  };
  const baseReview = await store.runSemanticReview({ ruleDigest: baseRule.digest, snapshotDigest: snapshot.digest, ...reviewOptions, fixtures: fixtures(baseRule, ['violation', 'violation']) });
  const finding = baseReview.findings.find(item => item.anchor.path === sources[1].path);
  const feedback = await store.appendReviewFeedback({ id: 'compiled-fp', findingId: finding.id, reviewId: baseReview.id, ruleDigest: baseRule.digest, ruleVersion: 'base',
    source: 'fixture', actor: 'authored-fixture', kind: 'label', label: 'FP', reason: 'Selected anchor has a guard', createdAt: date });
  const request = await store.createRevisionRequest({ id: 'compiled-request', baseRuleDigest: baseRule.digest, requestedRuleVersion: 'generated', feedbackIds: [feedback.id],
    requestedChange: 'Propose a guarded-call exception, preserving unrelated violations', actor: 'authored-fixture', source: 'fixture', createdAt: date });
  const response = { policyVersion: 'diagnosis-operators-v1', requestDigest: request.digest, baseRuleDigest: baseRule.digest, requestedRuleVersion: 'generated', result: { status: 'candidate', operator: 'boundary_update', replacement: null,
    semantics: { ...baseInput.semantics, exceptions: ['Applicable guard precedes call'] }, paths: baseInput.scope.paths, detectionAssets: baseInput.detectionAssets,
    rationale: 'Authored proposal, requiring local comparison', evidenceRefs: [`rule:${baseRule.digest}`, `feedback:${feedback.id}`, `finding:${finding.id}`],
    diagnoses: [{ feedbackId: feedback.id, category: 'boundary', reasoning: 'Guard boundary may explain selected FP', missingEvidence: [], evidenceRefs: [`feedback:${feedback.id}`], claim: 'proposal-not-established-fact' }] } };
  if (contextEnabled) {
    response.evidencePolicyVersion = 'selected-context-evidence-v1';
    response.repositoryContextBindings = revisionRepositoryContextBindings(await store.getRevisionGenerationEvidence(request.digest));
    response.result.evidenceRefs.push(`evidence:${policyEvidence.id}`);
    response.result.diagnoses[0].evidenceRefs.push(`evidence:${policyEvidence.id}`);
  }
  const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const executable = join(directory, 'authored-cli.cjs'), requestPath = join(directory, 'request.json'), argsPath = join(directory, 'args.json');
  const setResponse = async value => writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(process.argv));process.stdin.resume();process.stdin.on('end',()=>{const send=x=>console.log(JSON.stringify(x));send({type:'thread.started',thread_id:'compiled-revision-sdk'});send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(${JSON.stringify(value)})}});send({type:'turn.completed',usage:${JSON.stringify(usage)}});});\n`, { mode: 0o700 });
  await setResponse(response);
  const workspace = { repoPath, runId: 'revision', attemptId: 'compiled' }; await prepareWorkspace({ ...workspace, baseSha: head });
  const limits = { maxInputBytes: 262144, maxOutputBytes: 131072, maxArtifactBytes: 4096, maxArtifacts: 2, timeoutMs: 3000, cleanupTimeoutMs: 1500 };
  let runtimeExecutions = 0;
  const backend = { kind: 'authored-test-no-isolation', reserve(request, record) {
    assert.equal(request.outputContract, contextEnabled ? 'rule-revision-v3' : 'rule-revision-v2');
    if (contextEnabled) { assert.ok(request.prompt.includes(policySource.trim())); assert.ok(!request.prompt.includes('UNCITED_CONTEXT_SENTINEL')); assert.ok(!request.prompt.includes('bytesBase64')); } assert.equal(request.toolPolicy, 'selected-evidence-no-tools-v1'); assert.equal(request.expectedSha, head);
    return { async prepare() { return { expectedSha: head, headSha: head, clean: true, identityValid: true, historyPolicy: 'all-local-refs-v1' }; },
      async execute(signal) {
        runtimeExecutions++;
        await writeFile(requestPath, JSON.stringify({ workingDirectory: record.worktreePath, model: request.model, prompt: request.prompt, outputContract: request.outputContract, toolPolicy: request.toolPolicy, historyPolicy: request.historyPolicy, limits: request.limits }));
        return JSON.parse(await runWorkspaceWorkerCommand(['run', requestPath], { kind: 'authored-test-no-isolation', fixtureRoot: directory, workingDirectory: record.worktreePath, requestPath, codexPathOverride: executable,
          imageConfig: { schemaVersion: 1, gateway: { kind: 'credential-isolated-gateway', baseUrl: 'https://gateway.example.invalid/v1', allowedHost: 'gateway.example.invalid' } } }, signal));
      }, async stop() { return { stopped: true, verified: true }; }, async collect() { return []; }, async destroy() { return { destroyed: true, verified: true }; } };
  } };
  const config = { enabled: true, model: 'authored-compiled-no-model' };
  const options = { requestDigest: request.digest, candidateId: 'compiled-candidate', candidateCreatedAt: date, context: { kind: 'selected-evidence-no-tools', workspace, snapshotDigest: snapshot.digest } };
  assert.equal((await generateRuleRevision(store, options, config)).reason, 'runtime_unavailable');
  const result = await generateRuleRevision(store, options, config, { id: 'compiled-authored-runtime', backend, limits });
  assert.equal(result.execution, 'succeeded', JSON.stringify(result)); assert.equal(result.status, 'candidate_requires_review'); assert.equal(result.modelExecution, 'not_run');
  const args = await readFile(argsPath, 'utf8'); assert.ok(args.includes('shell_tool=false')); assert.ok(args.includes('unified_exec=false')); assert.ok(args.includes('read-only'));
  const saved = result.saved, rule = await store.getRuleVersion(saved.candidate.ruleDigest);
  assert.deepEqual(rule.rule.regressionCases, baseInput.regressionCases); assert.deepEqual(rule.rule.provenance.sourceCases, baseInput.provenance.sourceCases);
  assert.equal(rule.rule.provenance.parentDigest, baseRule.digest);
  const corrected = await store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: snapshot.digest, ...reviewOptions, fixtures: fixtures(rule, ['violation', 'safe']), attempt: 'corrected' });
  const comparisonInput = { id: 'compiled-comparison', requestDigest: request.digest, candidateRuleDigest: rule.digest,
    reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: corrected.id }], caseBindings: cases.map(item => ({ caseId: item.id, baseReviewId: baseReview.id })) };
  const comparison = await store.createRevisionComparison(comparisonInput); assert.equal(comparison.comparison.summary.status, 'compatible');
  const decisionInput = { id: 'compiled-accept', comparisonDigest: comparison.digest, choice: 'accept', actor: 'authored-fixture', source: 'fixture', reason: 'Local fixture decision only', createdAt: date };
  const decision = await store.recordRevisionDecision(decisionInput); assert.equal(decision.decision.activation, 'not_performed');
  const regressed = await store.runSemanticReview({ ruleDigest: rule.digest, snapshotDigest: snapshot.digest, ...reviewOptions, fixtures: fixtures(rule, ['safe', 'safe']), attempt: 'regressed' });
  const regression = await store.createRevisionComparison({ ...comparisonInput, id: 'compiled-regression', reviewPairs: [{ baseReviewId: baseReview.id, candidateReviewId: regressed.id }] });
  assert.equal(regression.comparison.summary.status, 'regressed');
  await assert.rejects(store.recordRevisionDecision({ ...decisionInput, id: 'blocked-accept', comparisonDigest: regression.digest }), error => error.code === 'REVISION_ACCEPT_BLOCKED');
  assert.equal(await store.getActive(baseInput.ruleId), null); assert.equal((await store.getReviewFinding(finding.id)).verdict, 'Unknown');
  assert.deepEqual(await store.getRevisionRequest(request.digest), request);
  assert.equal(saved.candidate.policyVersion, 'diagnosis-operators-v1'); assert.equal(saved.candidate.operator, 'boundary_update');
  const outcomes = [];
  for (const [category, operator] of [['judgment', 'retain_rule'], ['context', 'request_context'], ['mixed', 'abstain']]) {
    const responseWithoutMutation = { ...response, result: { status: 'no_rule_change', operator,
      reasoning: 'Authored no-mutation policy fixture', nextStep: 'Review the unresolved guard interpretation',
      missingEvidence: category === 'context' ? ['Helper contract'] : [], evidenceRefs: response.result.evidenceRefs,
      diagnoses: response.result.diagnoses.map(item => ({ ...item, category, missingEvidence: category === 'context' ? ['Helper contract'] : [] })) } };
    await setResponse(responseWithoutMutation);
    const outcome = await generateRuleRevision(store, { ...options, candidateId: `compiled-${category}` }, config, { id: 'compiled-authored-runtime', backend, limits });
    assert.equal(outcome.execution, 'succeeded', JSON.stringify(outcome)); assert.equal(outcome.status, 'no_rule_change');
    assert.equal(outcome.candidate, null); assert.equal(outcome.savedOutcome.outcome.result.operator, operator);
    outcomes.push(outcome.savedOutcome);
  }
  for (const category of ['judgment', 'context', 'mixed']) {
    await setResponse({ ...response, result: { ...response.result, diagnoses: response.result.diagnoses.map(item => ({ ...item, category })) } });
    const rejected = await generateRuleRevision(store, { ...options, candidateId: `compiled-rejected-${category}` }, config, { id: 'compiled-authored-runtime', backend, limits });
    assert.equal(rejected.execution, 'failed'); assert.equal(rejected.stage, 'output'); assert.equal(rejected.candidate, null);
    assert.match(rejected.error, /diagnosis\/operator mismatch/); assert.equal(rejected.runtimeResult.cleanup, 'verified');
  }
  await setResponse({ ...response, result: { ...response.result, semantics: { ...response.result.semantics, invariant: 'Unjustified rewrite' } } });
  const protectedEdit = await generateRuleRevision(store, { ...options, candidateId: 'compiled-protected-edit' }, config, { id: 'compiled-authored-runtime', backend, limits });
  assert.equal(protectedEdit.execution, 'failed'); assert.match(protectedEdit.error, /preserve invariant/);
  assert.equal((await store.listRevisionCandidates()).length, 1); assert.equal((await store.listRuleVersions()).length, 2);
  assert.equal((await cleanupWorkspace(workspace)).record.status, 'closed-clean');
  if (contextEnabled) await rm(repoPath, { recursive: true, force: true });
  await store.close(); store = await QualEvoStore.openPGlite(dbPath);
  assert.deepEqual(await store.getRevisionCandidate(saved.digest), saved); assert.deepEqual(await store.getRevisionComparison(comparison.digest), comparison); assert.deepEqual(await store.getRevisionDecision(decision.digest), decision);
  for (const outcome of outcomes) assert.deepEqual(await store.getRevisionOutcome(outcome.digest), outcome);
  assert.equal(await store.getActive(baseInput.ruleId), null);
  // Each inspection is a fresh compiled CLI process against the closed persistent
  // store. Remove the authored SDK executable and its output before any readback.
  const rulesBeforeInspection = await store.listRuleVersions();
  await store.close(); store = undefined;
  await rm(executable); await rm(argsPath);
  const runtimeExecutionsBeforeInspection = runtimeExecutions;
  const guardPath = join(directory, 'inspection-offline-guard.mjs'), networkMarker = join(directory, 'inspection-network-attempt');
  await writeFile(guardPath, `import { Socket } from 'node:net'; import { appendFileSync } from 'node:fs';\nconst reject=()=>{appendFileSync(${JSON.stringify(networkMarker)},'attempt\\n');throw new Error('REVISION_INSPECTION_SMOKE_FORBIDS_NETWORK');};\nSocket.prototype.connect=reject;globalThis.fetch=reject;\n`, { flag: 'wx' });
  let inspectionChecks = 0;
  const absent = async path => assert.rejects(access(path), error => error.code === 'ENOENT');
  const invoke = async (args, { database = true, error, environment = {} } = {}) => {
    const selectedArgs = [...args, ...(database ? ['--db', dbPath] : [])];
    const result = await exec(process.execPath, ['--import', pathToFileURL(guardPath).href, join(root, 'dist/cli.js'), ...selectedArgs], {
      cwd: root, timeout: 30_000, maxBuffer: 16_000_000,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://fixture:authored@inspection-forbidden.invalid/fixture',
        QE_ENABLE_MODEL: 'false', QE_CODEX_AUTH_MODE: 'not-configured', ...environment },
    }).then(value => ({ code: 0, ...value }), value => ({ code: value.code, stdout: value.stdout, stderr: value.stderr }));
    await absent(networkMarker); await absent(executable); await absent(argsPath);
    assert.equal(result.code, error ? 1 : 0, `${selectedArgs.join(' ')}: ${result.stderr}`);
    if (error) { assert.equal(result.stdout, ''); assert.match(result.stderr, error); }
    inspectionChecks++;
    return result.stdout;
  };
  const inspect = async args => JSON.parse(await invoke(args));
  const comparisonsLink = ['revisions', 'comparisons', '--request-digest', request.digest, '--candidate-rule-digest', rule.digest];
  const assertSummary = (summary, record, kind) => {
    const value = record[kind], proposal = value.executionReceipt.workerResult.value.result;
    assert.equal(summary.digest, record.digest); assert.equal(summary.id, value.id);
    assert.equal(summary.requestDigest, request.digest); assert.equal(summary.baseRuleDigest, baseRule.digest);
    assert.equal(summary.ruleDigest, kind === 'candidate' ? rule.digest : null);
    assert.equal(summary.status, kind === 'candidate' ? 'candidate_requires_review' : 'no_rule_change');
    assert.equal(summary.source, 'fixture'); assert.equal(summary.modelExecution, 'not_run');
    assert.equal(summary.operator, proposal.operator); assert.deepEqual(summary.diagnoses, proposal.diagnoses);
    assert.deepEqual(summary.repositoryContextBindings, value.repositoryContextBindings ?? []);
    assert.equal(summary.certification, 'none');
    assert.equal(typeof summary.nextStep, 'string'); assert.ok(summary.nextStep.length > 0);
    if (kind === 'outcome') assert.equal(summary.nextStep, value.result.nextStep);
    assert.deepEqual(summary.links.request, ['revisions', 'show', '--digest', request.digest]);
    assert.deepEqual(summary.links.baseRule, ['rules', 'show', '--digest', baseRule.digest]);
    assert.deepEqual(summary.links.rule, kind === 'candidate' ? ['rules', 'show', '--digest', rule.digest] : null);
    assert.deepEqual(summary.links.snapshot, ['snapshots', 'show', '--digest', snapshot.digest]);
    assert.deepEqual(summary.links.repositoryContexts, repositoryContexts.map(item => ['contexts', 'show', '--digest', item.digest]));
    assert.deepEqual(summary.links.comparisons, kind === 'candidate' ? comparisonsLink : null);
  };
  const showCommands = [{ kind: 'candidate', record: saved }, ...outcomes.map(record => ({ kind: 'outcome', record }))];
  const shown = new Map();
  for (const { kind, record } of showCommands) {
    const args = ['revisions', kind, '--digest', record.digest], text = await invoke(args), value = JSON.parse(text);
    const { inspection, ...raw } = value;
    assert.deepEqual(raw, record); assertSummary(inspection, record, kind);
    assert.equal(inspection.request.source, 'fixture'); assert.equal(inspection.request.actor, 'authored-fixture');
    assert.deepEqual(inspection.selectedFeedback.map(item => ({ source: item.source, label: item.label, selectedVerdict: item.selectedVerdict })),
      [{ source: 'fixture', label: 'FP', selectedVerdict: 'Unknown' }]);
    assert.equal(await invoke(args), text, 'Repeated inspection must have byte-stable JSON');
    const outputPath = join(directory, `${record[kind].id}-inspection.json`);
    assert.equal(await invoke([...args, '--out', outputPath]), '');
    assert.equal(await readFile(outputPath, 'utf8'), text);
    shown.set(record.digest, inspection);
  }
  const assertList = (value, kind, records) => {
    assert.equal(value.schemaVersion, 1); assert.equal(value.kind, `revision-${kind}-list`); assert.equal(value.certification, 'none');
    const field = `${kind}s`, sorted = [...records].sort((a, b) => a.digest.localeCompare(b.digest));
    assert.deepEqual(value[field].map(item => item.digest), sorted.map(item => item.digest));
    assert.equal(value.nextAfter, sorted.at(-1)?.digest ?? null);
    value[field].forEach((item, index) => assertSummary(item, sorted[index], kind));
  };
  const unknownDigest = '0'.repeat(64);
  for (const [kind, records] of [['candidate', [saved]], ['outcome', outcomes]]) {
    const command = ['revisions', `${kind}s`], text = await invoke(command), listing = JSON.parse(text);
    assertList(listing, kind, records); assert.equal(await invoke(command), text);
    assertList(await inspect([...command, '--request-digest', request.digest, '--limit', '100']), kind, records);
    const firstRecord = records[0], filtered = await inspect([...command, '--id', firstRecord[kind].id]);
    assertList(filtered, kind, [firstRecord]);
    const outputPath = join(directory, `${kind}s-inspection.json`);
    assert.equal(await invoke([...command, '--out', outputPath]), ''); assert.equal(await readFile(outputPath, 'utf8'), text);
    let after, paged = [];
    do {
      const page = await inspect([...command, '--request-digest', request.digest, '--limit', '1', ...(after ? ['--after', after] : [])]);
      assert.ok(page[`${kind}s`].length <= 1); assert.equal(page.nextAfter, page[`${kind}s`].at(-1)?.digest ?? null);
      if (page.nextAfter !== null) { assert.ok(!after || page.nextAfter > after); paged.push(...page[`${kind}s`]); }
      else assert.deepEqual(page[`${kind}s`], []);
      after = page.nextAfter;
    } while (after !== null);
    assert.deepEqual(paged, listing[`${kind}s`]);
    assertList(await inspect([...command, '--request-digest', unknownDigest]), kind, []);
    assertList(await inspect([...command, '--id', 'compiled-missing']), kind, []);
    for (const args of [['--request-digest', 'bad'], ['--after', 'bad'], ['--id', ''], ['--limit', '0'], ['--limit', '101'], ['--limit', '1.5']]) {
      await invoke([...command, ...args], { error: /invalid|expected|small|big|integer|limit/i });
    }
  }
  assertList(await inspect(['revisions', 'candidates', '--rule-digest', rule.digest, '--id', saved.candidate.id, '--request-digest', request.digest]), 'candidate', [saved]);
  assertList(await inspect(['revisions', 'candidates', '--rule-digest', baseRule.digest]), 'candidate', []);
  await invoke(['revisions', 'candidates', '--rule-digest', 'bad'], { error: /SHA-256|invalid/i });
  for (const kind of ['candidate', 'outcome']) {
    await invoke(['revisions', kind, '--digest', unknownDigest], { error: /Unknown revision|not found/i });
    await invoke(['revisions', kind, '--digest', 'bad'], { error: /SHA-256|invalid/i });
    await invoke(['revisions', kind], { error: /required.*digest/i });
  }
  for (const command of [['candidate', '--digest', saved.digest], ['candidates'], ['outcome', '--digest', outcomes[0].digest], ['outcomes']]) {
    await invoke(['revisions', ...command], { database: false, error: /--db.*--postgres/ });
    await invoke(['revisions', ...command, '--postgres'], { error: /never both/ });
    await invoke(['revisions', ...command, '--postgres'], { database: false, environment: { DATABASE_URL: '' }, error: /DATABASE_URL/ });
  }
  // Follow the exact comparison navigation from the candidate, and prove that
  // the candidate rule filter cannot return another rule's comparisons.
  const linkedComparisons = await inspect(shown.get(saved.digest).links.comparisons);
  assert.deepEqual(linkedComparisons.comparisons.map(item => item.digest).sort(), [comparison.digest, regression.digest].sort());
  const unrelatedComparisons = await inspect(['revisions', 'comparisons', '--request-digest', request.digest, '--candidate-rule-digest', baseRule.digest]);
  assert.deepEqual(unrelatedComparisons.comparisons, []); assert.equal(unrelatedComparisons.nextAfter, null);
  store = await QualEvoStore.openPGlite(dbPath);
  assert.deepEqual(await store.getRevisionCandidate(saved.digest), saved);
  for (const outcome of outcomes) assert.deepEqual(await store.getRevisionOutcome(outcome.digest), outcome);
  assert.deepEqual(await store.listRuleVersions(), rulesBeforeInspection);
  assert.equal((await store.listRevisionCandidates()).length, 1); assert.equal((await store.listRevisionOutcomes()).length, 3);
  assert.deepEqual(await store.getRevisionComparison(comparison.digest), comparison); assert.deepEqual(await store.getRevisionDecision(decision.digest), decision);
  assert.equal((await store.getReviewFinding(finding.id)).verdict, 'Unknown'); assert.equal(await store.getActive(baseInput.ruleId), null);
  assert.equal(runtimeExecutions, runtimeExecutionsBeforeInspection); await absent(executable); await absent(argsPath); await absent(networkMarker);
  console.log(JSON.stringify({ mode: contextEnabled ? 'compiled-authored-sdk-context-revision-generation' : 'compiled-authored-sdk-revision-generation',
    evidencePolicyVersion: saved.candidate.evidencePolicyVersion, repositoryContextBindings: saved.candidate.repositoryContextBindings, sourceRepositoryRemovedBeforeReopen: contextEnabled, modelExecution: 'not_run', isolation: 'not_verified',
    requestDigest: request.digest, candidateDigest: saved.digest, ruleDigest: rule.digest, source: saved.candidate.source,
    protocol: result.executionReceipt.workerResult.outputContract, sessionId: result.executionReceipt.workerResult.sessionId,
    policyVersion: saved.candidate.policyVersion, operator: saved.candidate.operator,
    persistedNonMutationOperators: outcomes.map(item => item.outcome.result.operator),
    diagnosisMutationMismatch: 'rejected', protectedBoundaryEdit: 'rejected',
    diagnosis: saved.candidate.diagnosis, comparison: comparison.comparison.summary, regression: regression.comparison.summary,
    regressionAcceptance: 'blocked', localDecision: decision.decision.choice, humanVerdict: 'Unknown', activation: 'not_performed',
    reopenedIdentically: true, cleanup: result.executionReceipt.cleanup, lifecycle: result.executionReceipt.lifecycle,
    inspectionVerification: { checks: inspectionChecks, candidates: 1, outcomes: 3, repeatedJson: 'byte-identical', outFiles: 'byte-identical',
      filtersAndPagination: 'passed', malformedAndMissingSelectors: 'rejected', linkedComparisons: 'exact-request-and-candidate-rule',
      recordsUnchanged: true, authoredExecutableRemoved: true, runtimeExecutionsDuringInspection: 0, networkAttempts: 0,
      modelExecution: 'not_run', certification: 'none' } }, null, 2));
} finally { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); }
