import { spawn } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { workspaceEnvironment, boundedProcessBytes } from '../src/workspace/process.js';
import { exportEvaluationCheckout, inspectEvaluationCheckout, evaluationWorkspaceBinding, deriveEvaluationRepository, verifyEvaluationRepository, type EvaluationVisibilityManifest } from '../src/workspace/evaluation-checkout.js';
import { recaptureEvaluationSnapshot } from '../src/evaluation-workspace-input.js';
import { validateGithubPrEvidence } from '../src/github-pr-evidence.js';
import { buildPrMiningModelInput } from '../src/adapters/pr-mining-model.js';
import { digestOf } from '../src/core/identity.js';
import { MEMBERS, validateFrozenPackage } from './prepare-w0-mining.js';

const root = new URL('../experiments/temporal-pilot/w0-first-three/', import.meta.url);
export const PLAN_COMMIT = '6fb867c0a2c8e95929bd406630646fc7e6856d54';
const MAX_BYTES = 512 * 1024 * 1024, MAX_TIME = 600_000;
const json = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const git = async (cwd: string, ...args: string[]) => (await boundedProcessBytes('/usr/bin/git', args, cwd)).toString('utf8').trim();
export async function directoryBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(path)) {
    try { const p = join(path, name), s = await lstat(p); bytes += s.isDirectory() ? await directoryBytes(p) : Math.max(s.size, s.blocks * 512); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return bytes;
}
export function fetchArgs(sha: string, source = 'https://github.com/encode/httpx.git') {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Exact SHA required');
  if (source !== 'https://github.com/encode/httpx.git' && !['/workspace/FlyReWheel', '/workspace', '/tmp'].includes(source)) throw new Error('Unapproved Git source');
  return ['-c', 'protocol.version=2', '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'fetch.unpackLimit=1',
    'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', source, sha];
}
async function worker(stage: string) {
  const plan = JSON.parse(await readFile(new URL('full-context/plan.json', root), 'utf8'));
  const savedPlan = await git(resolve('.'), 'show', `${PLAN_COMMIT}:experiments/temporal-pilot/w0-first-three/full-context/plan.json`);
  if (digestOf(JSON.parse(savedPlan)) !== digestOf(plan)) throw new Error('Published plan differs');
  const packages = await Promise.all(MEMBERS.map(async m => validateFrozenPackage(await readFile(new URL(`proxy-attempt-1/package-${m.number}.json`, root)), m)));
  const allowed = new Map<string, string>();
  for (const p of packages) for (const identity of Object.values(p.sourceIdentities)) {
    if (allowed.has(identity.commit) && allowed.get(identity.commit) !== identity.tree) throw new Error('Tree conflict');
    allowed.set(identity.commit, identity.tree);
  }
  if (digestOf([...allowed.keys()].sort()) !== digestOf([...new Set<string>(plan.items.flatMap((p: { commits: Record<string, { sha: string }> }) => Object.values(p.commits).map(v => v.sha)))].sort())) throw new Error('Plan SHA scope mismatch');
  const cache = join(stage, 'cache'); await mkdir(cache);
  await git(cache, 'init', '--quiet', '--template=', '--initial-branch=unborn', '--object-format=sha1');
  let upstreamGitFetches = 0, localCacheTransfers = 0;
  const log = async (event: unknown) => appendFile(join(stage, 'git-log.jsonl'), JSON.stringify(event) + '\n');
  const has = async (repo: string, sha: string) => { try { return await git(repo, 'cat-file', '-t', sha) === 'commit'; } catch { return false; } };
  for (const [sha, tree] of allowed) {
    if (!await has(cache, sha)) {
      let source = 'https://github.com/encode/httpx.git';
      for (const local of ['/workspace/FlyReWheel', '/workspace', '/tmp']) {
        const found = await has(local, sha); await log({ kind: 'local-cache-probe', path: local, sha, present: found });
        if (found) { source = local; break; }
      }
      const network = source.startsWith('https:');
      if (network && ++upstreamGitFetches > 9) throw new Error('Git fetch budget exhausted');
      if (!network) localCacheTransfers++;
      const before = await directoryBytes(stage), startedAt = new Date().toISOString(), args = fetchArgs(sha, source);
      await log({ kind: 'transfer-start', source, sha, args, network, upstreamGitFetches, startedAt, diskBytesBefore: before, retries: 0 });
      const env: NodeJS.ProcessEnv = { ...workspaceEnvironment(), GIT_ALLOW_PROTOCOL: network ? 'https' : 'file' };
      // Preserve existing proxy routing, never print proxy values or use credential helpers.
      for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) if (process.env[key]) env[key] = process.env[key];
      const result = await new Promise<{ code: number | null; signal: string | null; stderr: string }>((accept, reject) => {
        const child = spawn('/usr/bin/git', args, { cwd: cache, env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString('utf8')).slice(-2048); });
        child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, stderr }));
      });
      // Store only an enum diagnostic; raw stderr can contain ambient proxy details.
      const failureCategory = result.code === 0 ? null : /403|denied|forbidden/i.test(result.stderr) ? 'access-denied' : /resolve|connect|proxy/i.test(result.stderr) ? 'network-failure' : 'git-transfer-failure';
      await log({ kind: 'transfer-end', sha, network, code: result.code, signal: result.signal, failureCategory,
        completedAt: new Date().toISOString(), diskBytesAfter: await directoryBytes(stage), transportBytes: 'not-instrumented', apiRequestCost: 'not-instrumented-git-smart-http-not-GitHub-REST' });
      if (result.code !== 0) throw new Error(`Git transfer stopped: ${failureCategory}; no retry or alternate route`);
    } else await log({ kind: 'acquisition-cache-hit', sha });
    if (await git(cache, 'rev-parse', `${sha}^{tree}`) !== tree) throw new Error('Frozen commit tree mismatch');
    await log({ kind: 'identity-verified', sha, tree });
  }
  if (await git(cache, 'for-each-ref', '--format=%(refname)')) throw new Error('Acquisition cache unexpectedly has refs');
  const items = [];
  for (const p of packages) {
    const number = p.evidence.evidence.pull.number, evidence = validateGithubPrEvidence(p.evidence.evidence);
    const request = JSON.parse(await readFile(new URL(`mining-preparation/request-${number}.json`, root), 'utf8'));
    const exports = [];
    for (const side of ['before', 'after'] as const) {
      const sha = side === 'before' ? evidence.evidence.snapshot.mergeBase : evidence.evidence.snapshot.head;
      const manifest: EvaluationVisibilityManifest = { schemaVersion: 1, repositoryId: evidence.evidence.snapshot.repository.id, classification: 'unverified-evaluation-input',
        allowedHeads: [sha], checkoutSha: sha, visibility: { basis: 'caller-declared-exact-heads', declaredAsOf: null, evidenceDigests: [evidence.digest] } };
      const storePath = join(stage, 'exports');
      const exported = await exportEvaluationCheckout({ repoPath: cache, storePath, manifest });
      const binding = evaluationWorkspaceBinding(`httpx-w0-${number}-${side}`, exported);
      const derivedPath = join(stage, `derived-${number}-${side}`);
      await deriveEvaluationRepository({ repoPath: derivedPath, storePath, manifest, binding });
      await verifyEvaluationRepository(derivedPath, binding);
      const clean = await git(derivedPath, 'status', '--porcelain=v1', '--untracked-files=all') === '';
      const futureAbsent = [];
      // Probe only the already-authorized six identities, never a W1/W2 identity or ref.
      for (const other of allowed.keys()) if (!await has(exported.repoPath, other)) futureAbsent.push(other);
      let generationTemplate = null;
      if (side === 'after') {
        await recaptureEvaluationSnapshot({ digest: evidence.evidence.snapshotDigest, snapshot: evidence.evidence.snapshot }, derivedPath);
        const prepared = buildPrMiningModelInput({ request, evidence, candidateId: `w0-unexecuted-${number}`, candidateCreatedAt: request.request.input.createdAt,
          context: { kind: 'full-repository', repository: evidence.evidence.snapshot.repository.id, checkout: 'after',
            workspace: { repoPath: derivedPath, runId: `w0-${number}`, attemptId: 'context-only' }, evaluation: binding } }, { model: 'unconfigured-offline-template' });
        const { model: _model, ...template } = prepared.generation; generationTemplate = template;
      }
      // Dirty only this disposable derived checkout; the immutable baseline must still verify.
      await writeFile(join(derivedPath, 'flyrewheel-isolation-probe.tmp'), 'local isolation probe, not upstream code\n', { flag: 'wx' });
      if (!(await git(derivedPath, 'status', '--porcelain=v1', '--untracked-files=all'))) throw new Error('Dirty isolation probe not detected');
      const rechecked = await inspectEvaluationCheckout({ storePath, manifest });
      if (rechecked.recordDigest !== exported.recordDigest) throw new Error('Immutable export changed');
      await rm(derivedPath, { recursive: true });
      const record = { side, sha, tree: allowed.get(sha), manifest, binding, exportRecord: exported.record, observation: exported.observation,
        cleanBeforeProbe: clean, dirtyChangesIsolated: true, derivedCleanup: 'removed', immutableExportRetained: true,
        absentAmongAuthorizedCommitProbes: futureAbsent, generationTemplate, executable: false, configuredModel: null,
        workspacePathStatus: 'derived-probe-removed-must-rederive-before-any-execution' };
      await json(join(stage, `context-${number}-${side}.json`), record); exports.push(record);
    }
    items.push({ number, requestDigest: request.digest, contextReady: true, mode: 'full-committed-repository-at-exact-sha',
      before: exports[0]!.binding, after: exports[1]!.binding, modelExecution: 'not_run', historicalPublicAvailability: 'unproven', semanticEligibility: 'unknown', labels: 'unknown-only' });
  }
  await json(join(stage, 'result.json'), { status: 'context-ready', planCommit: PLAN_COMMIT, apiLedgerFrozen: 48, newRestApiCalls: 0,
    upstreamGitFetches, localCacheTransfers, gitTransportBytes: 'not-instrumented', gitSmartHttpRequests: 'not-instrumented-not-zero-cost',
    temporaryBytesAtCompletion: await directoryBytes(stage), cacheRefs: [], modelExecution: 'not_run', targetCodeExecution: 'not_run',
    historicalPublicAvailability: 'unproven', exportsRetained: true, derivedRepositoriesRemoved: true, items });
}

export async function runMaterialization(stage: string) {
  await mkdir(stage); // Exclusive attempt reservation; never retry an existing stage.
  let peakBytes = 0, stopping: string | null = null, checking = false;
  let monitorTask: Promise<void> | undefined;
  const startedAt = new Date().toISOString(), started = Date.now();
  const child = spawn('/bin/bash', ['-c', 'ulimit -f 65536; exec "$@"', 'w0-budget', process.execPath, '--import', 'tsx', resolve('scripts/materialize-w0-context.ts'), '--worker', stage],
    { cwd: resolve('.'), env: process.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', (b: Buffer) => { diagnostic = (diagnostic + b.toString('utf8')).slice(-4096); });
  let termination: Promise<void> | undefined;
  const stop = (reason: string) => {
    stopping ??= reason;
    termination ??= (async () => {
      // Existing export helpers create detached groups. Enumerate descendants before
      // terminating the worker so those groups cannot survive budget cancellation.
      const descendants = async (pid: number): Promise<number[]> => {
        let children: number[] = [];
        try { children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number); } catch {}
        return [...(await Promise.all(children.map(descendants))).flat(), pid];
      };
      if (child.pid) for (const pid of await descendants(child.pid)) {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    })();
  };
  const deadline = setTimeout(() => stop('deadline-exceeded'), MAX_TIME);
  const monitor = setInterval(() => {
    if (checking) return; checking = true;
    monitorTask = (async () => {
    try { peakBytes = Math.max(peakBytes, await directoryBytes(stage)); if (peakBytes > MAX_BYTES) stop('disk-budget-exceeded'); }
    catch { stop('disk-monitor-failed'); } finally { checking = false; }
    })();
  }, 100);
  const end = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal }));
  });
  clearInterval(monitor); clearTimeout(deadline);
  await monitorTask;
  if (end.code !== 0) stop(stopping ?? 'worker-failed');
  await termination;
  peakBytes = Math.max(peakBytes, await directoryBytes(stage));
  if (peakBytes > MAX_BYTES) stopping ??= 'disk-budget-exceeded';
  if (Date.now() - started > MAX_TIME) stopping ??= 'deadline-exceeded';
  const report = { planCommit: PLAN_COMMIT, startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    ...end, status: end.code === 0 && !stopping ? 'completed' : 'failed-retained-no-retry', stopping, peakObservedTemporaryBytes: peakBytes,
    diskLimit: MAX_BYTES, timeLimitMs: MAX_TIME, perFileProcessLimit: 64 * 1024 * 1024,
    diskEnforcement: '100ms observer plus per-file rlimit; not a filesystem aggregate quota; transient overshoot cannot be ruled out',
    failureDiagnostic: end.code === 0 ? null : diagnostic.includes('Git transfer stopped') ? 'git-transfer-rejected-see-sanitized-git-log' : 'worker-error-details-retained-locally',
    evidenceRetained: true, modelExecution: 'not_run', upstreamExecution: 'not_run' };
  await json(join(stage, 'stage-report.json'), report);
  if (end.code !== 0) await writeFile(join(stage, 'failure-local.txt'), diagnostic, { flag: 'wx' });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { worker: { type: 'string' }, stage: { type: 'string' } } });
  if (values.worker) await worker(resolve(values.worker));
  else if (values.stage) console.log(JSON.stringify(await runMaterialization(resolve(values.stage)), null, 2));
  else throw new Error('Specify --stage NEW_ABSOLUTE_DIRECTORY; no automatic retries');
}
