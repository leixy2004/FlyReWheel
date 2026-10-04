import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { diagnoseW0FirstRead } from './diagnose-w0-first-read.js';
import { runW0Capture } from './capture-w0-first-three.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function main() {
  const [stage, publishedCommit] = process.argv.slice(2);
  if (process.argv.length !== 4 || !['--diagnose', '--capture'].includes(stage) || !/^[a-f0-9]{40}$/.test(publishedCommit ?? ''))
    throw new Error('REQUIRE_STAGE_AND_PUBLISHED_PLAN_COMMIT');
  if (!process.execArgv.includes('--use-env-proxy') || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('REQUIRE_OFFICIAL_ENV_PROXY_FLAG_AND_TLS_VERIFICATION');
  const root = new URL('../', import.meta.url);
  const directory = new URL('experiments/temporal-pilot/w0-first-three/', root);
  const planPath = 'experiments/temporal-pilot/w0-first-three/proxy-attempt-plan.json';
  const planBytes = await readFile(new URL(planPath, root));
  const plan = JSON.parse(planBytes.toString('utf8'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, timeout: 5000, maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['merge-base', '--is-ancestor', publishedCommit, 'refs/remotes/origin/codex/issue-3-w0-proxy-capture']);
  if (!git(['show', `${publishedCommit}:${planPath}`]).equals(planBytes)) throw new Error('PUBLISHED_PLAN_MISMATCH');
  const selectionBytes = await readFile(new URL('selection.json', directory));
  if (hash(selectionBytes) !== plan.selectionSha256 || plan.previousUpstreamGetRequests !== 2 ||
    plan.captureMaxGetRequests !== 47 || plan.totalGetBudget !== 50) throw new Error('PLAN_ACCOUNTING_MISMATCH');
  const original = JSON.parse(await readFile(new URL('capture-run/run.json', directory), 'utf8'));
  const previous = JSON.parse(await readFile(new URL('single-get-diagnostic.json', directory), 'utf8'));
  if (original.requests !== 1 || previous.requests !== 1 || previous.totalRequestsUsed !== 2 ||
    original.acceptedEvidenceBytes !== 0 || previous.realSourcePackages !== 0) throw new Error('PREVIOUS_ACCOUNTING_MISMATCH');
  // data: bootstrap initializes the official dispatcher without a network request.
  await fetch('data:,offline-dispatcher-check');
  const dispatcher = (globalThis as any)[Symbol.for('undici.globalDispatcher.1')]?.constructor.name;
  if (dispatcher !== 'EnvHttpProxyAgent') throw new Error('EXISTING_ENV_PROXY_DISPATCHER_NOT_ACTIVE');
  const output = new URL('proxy-attempt-1/', directory);
  if (stage === '--diagnose') {
    await mkdir(output); // Existing attempt: fail before spending another GET.
    const reserve = await open(new URL('reservation.json', output), 'wx', 0o600);
    try {
      await reserve.writeFile(JSON.stringify({ publishedPlanCommit: publishedCommit, planSha256: hash(planBytes),
        previousRequests: 2, reservedDiagnosticRequests: 1, totalRequestsReserved: 3, requestBudget: 50,
        dispatcher, existingProxyOnly: true, realSourcePackages: 0 }, null, 2) + '\n');
      await reserve.sync();
    } finally { await reserve.close(); }
    const diagnostic = await diagnoseW0FirstRead({ priorRequests: 2 });
    await writeFile(new URL('diagnostic.json', output), JSON.stringify(diagnostic, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(diagnostic, null, 2));
    if (diagnostic.status !== 'success') process.exitCode = 1;
    return;
  }
  const diagnostic = JSON.parse(await readFile(new URL('diagnostic.json', output), 'utf8'));
  if (diagnostic.status !== 'success' || diagnostic.httpStatus !== 200 || diagnostic.requests !== 1 ||
    diagnostic.totalRequestsUsed !== 3 || diagnostic.identity?.repository !== 'encode/httpx' || diagnostic.identity?.number !== 3035 ||
    diagnostic.identity.mergeCommit !== 'b871b4b8b29aca2e675645fae0c9f8e7d2a5e7d5') throw new Error('DIAGNOSTIC_GATE_NOT_PASSED');
  const captureReserve = await open(new URL('capture-reservation.json', output), 'wx', 0o600);
  try { await captureReserve.writeFile(JSON.stringify({ priorRequests: 3, maxNewRequests: 47, requestBudget: 50 }) + '\n'); await captureReserve.sync(); }
  finally { await captureReserve.close(); }
  const result = await runW0Capture(JSON.parse(selectionBytes.toString('utf8')), undefined, { priorRequests: 3 });
  for (const entry of result.packages) await writeFile(new URL(`package-${entry.evidence.evidence.pull.number}.json`, output), JSON.stringify(entry, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(new URL('capture.json', output), JSON.stringify({ ...result.summary, planCommit: publishedCommit,
    publication: 'quarantined_pending_independent_audit' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.summary.status, totalRequestsUsed: result.summary.totalRequestsUsed,
    requests: result.summary.requests, packages: result.packages.length }));
  if (result.summary.status !== 'captured_quarantined') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROXY_ATTEMPT_LOCAL_GATE_OR_IO_FAILED'); process.exitCode = 1; });
}
