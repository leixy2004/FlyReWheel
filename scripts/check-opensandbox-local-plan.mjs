/** Offline deployment-plan checks; optional HTTPS /health probe never allocates. */
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const GiB = 1024 ** 3;
const Plan = z.object({
  serverHost: z.literal('127.0.0.1'),
  publishHost: z.literal('127.0.0.1'),
  networkMode: z.enum(['internal-bridge', 'bridge', 'none']),
  executionTransport: z.enum(['official-sdk', 'docker-exec']),
  useServerProxy: z.literal(true),
  proxyResolveInternal: z.literal(false),
  // These restrictions apply to the workload; the upstream extraction helper differs.
  execdExtractionHelper: z.literal('pinned-local-patch-never-started'),
  noNewPrivileges: z.literal(true),
  dropCapabilities: z.tuple([z.literal('ALL')]),
  pidsLimit: z.number().int().min(16).max(64),
  networkPolicy: z.null(),
  credentialProxy: z.literal(false),
  isolationExtension: z.literal(false),
  privileged: z.literal(false),
  addedCapabilities: z.array(z.never()).length(0),
  hostBinds: z.array(z.never()).length(0),
  apiKeySource: z.literal('task-temporary-file'),
  tls: z.literal('task-certificate-scoped-client-trust'),
  maxSandboxes: z.literal(1),
  sandboxTtlSeconds: z.number().int().min(60).max(300),
  operationDeadlineSeconds: z.number().int().min(1).max(900),
  reserveBytes: z.number().int().min(5 * GiB),
  freeBytes: z.number().int().nonnegative().nullable(),
  additionalPeakBytes: z.number().int().nonnegative().nullable(),
}).strict();

export const proposedPlan = {
  serverHost: '127.0.0.1', publishHost: '127.0.0.1', networkMode: 'internal-bridge',
  executionTransport: 'official-sdk', useServerProxy: true, proxyResolveInternal: false,
  execdExtractionHelper: 'pinned-local-patch-never-started',
  noNewPrivileges: true, dropCapabilities: ['ALL'], pidsLimit: 64, networkPolicy: null,
  credentialProxy: false, isolationExtension: false, privileged: false,
  addedCapabilities: [], hostBinds: [], apiKeySource: 'task-temporary-file',
  tls: 'task-certificate-scoped-client-trust', maxSandboxes: 1,
  sandboxTtlSeconds: 300, operationDeadlineSeconds: 900,
  reserveBytes: 5 * GiB, freeBytes: null, additionalPeakBytes: null,
};
export function checkPlan(input) {
  const plan = Plan.parse(input);
  const blockers = [];
  if (plan.networkMode === 'none' && plan.executionTransport === 'official-sdk')
    blockers.push('network-none has no routable execd HTTP endpoint; skipHealthCheck does not supply a command channel');
  if (plan.networkMode === 'none')
    blockers.push('network-none is not in the reviewed documented server network modes; actual server creation remains unverified');
  const measured = plan.freeBytes !== null && plan.additionalPeakBytes !== null;
  if (!measured) blockers.push('expanded-image/container/dependency peak budget has not been measured');
  else if (plan.freeBytes < plan.reserveBytes + plan.additionalPeakBytes)
    blockers.push('capacity estimate would consume the 5 GiB minimum reserve');
  return {
    classification: 'static-plan-only-not-runtime-evidence',
    networkMode: plan.networkMode, executionTransport: plan.executionTransport,
    needsNetAdmin: false, networkPolicyEnabled: false,
    hardeningScope: 'workload-only',
    extractionHelper: 'pinned local patch creates a network-none cap-drop-ALL read-only helper and never starts it',
    pendingActions: ['create task-only API key', 'create task-only TLS certificate/key with scoped client trust',
      'start loopback-only server and sandbox port bindings'],
    blockers,
    limitation: plan.executionTransport === 'docker-exec'
      ? 'Docker exec is an out-of-band command check, not SDK execd verification'
      : 'internal bridge blocks direct external routing but retains host/gateway reachability; production isolation is unproven',
  };
}

export function healthUrl(raw) {
  const url = new URL(raw);
  assert.equal(url.protocol, 'https:', 'HTTPS is required');
  assert.equal(url.hostname, '127.0.0.1', 'Only explicit IPv4 loopback is allowed');
  assert.equal(url.pathname, '/health', 'Only the public health route is allowed');
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'No credentials/query/fragment allowed');
  return url;
}

export function classifyHealth(status, bytes) {
  if (status !== 200) return { ok: false, kind: 'http-status', status };
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    return body?.status === 'healthy' ? { ok: true, kind: 'health-only-not-lifecycle' } : { ok: false, kind: 'unexpected-body' };
  } catch { return { ok: false, kind: 'invalid-json' }; }
}

export async function probeHealth(raw, { timeoutMs = 1000, maxBytes = 8192, ca } = {}) {
  const url = healthUrl(raw);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 5000);
  assert.ok(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 32768);
  return await new Promise(resolveProbe => {
    let done = false, timer;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolveProbe(result); };
    const request = https.get(url, { ca, rejectUnauthorized: true, agent: false, headers: { accept: 'application/json' } }, response => {
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          finish({ ok: false, kind: 'body-limit' }); response.destroy(); request.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', () => finish({ ok: false, kind: 'response-error' }));
      response.on('end', () => {
        finish(classifyHealth(response.statusCode, Buffer.concat(chunks)));
      });
    });
    request.on('error', error => finish({ ok: false, kind: 'transport-error', code: error.code ?? 'UNKNOWN' }));
    timer = setTimeout(() => { finish({ ok: false, kind: 'deadline' }); request.destroy(); }, timeoutMs);
  });
}

async function main(args) {
  if (args.length === 0) return checkPlan(proposedPlan);
  if (args.length === 2 && args[0] === '--plan') {
    const bytes = await readFile(args[1]);
    assert.ok(bytes.length <= 65536, 'Plan file exceeds bound');
    return checkPlan(JSON.parse(bytes.toString('utf8')));
  }
  if ((args.length === 2 || args.length === 4) && args[0] === '--health') {
    assert.ok(args.length === 2 || args[2] === '--ca-file', 'Expected --ca-file PUBLIC_CERT');
    const ca = args.length === 4 ? await readFile(args[3]) : undefined;
    return probeHealth(args[1], { ca });
  }
  throw new Error('Use no arguments, --plan JSON_FILE, or --health https://127.0.0.1:PORT/health [--ca-file PUBLIC_CERT]');
}
// Module URLs resolve symlinks while argv can retain the launch alias.
const launchPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (launchPath && launchPath === await realpath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.ok === false) process.exitCode = 1;
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
