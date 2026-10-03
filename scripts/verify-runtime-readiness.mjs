#!/usr/bin/env node
/** Offline inventory only: no SDK initialization, endpoint probes or daemon access. */
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--require-ready') || args.length > 1) {
  process.stderr.write('Usage: node scripts/verify-runtime-readiness.mjs [--require-ready]\n');
  process.exit(64);
}

async function readJson(relative) {
  try { return { value: JSON.parse(await readFile(join(root, relative), 'utf8')) }; }
  catch { return { error: 'unavailable-or-invalid' }; }
}

async function onPath(name) {
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(entry, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch { /* Presence only; do not print local paths or permission details. */ }
  }
  return false;
}

function revision(ref) {
  try {
    const value = execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: root, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[a-f0-9]{40}$/.test(value) ? value : null;
  } catch { return null; }
}

const packageNames = ['@alibaba-group/opensandbox', '@ai-hero/sandcastle', '@openai/codex-sdk', 'pg', 'pg-boss'];
const packages = Object.fromEntries(await Promise.all(packageNames.map(async name => {
  const result = await readJson(`node_modules/${name}/package.json`);
  const version = result.value?.version;
  return [name, typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    ? { status: 'installed', version } : { status: 'unavailable-or-invalid' }];
})));
const commands = ['docker', 'podman', 'k3s', 'kubectl', 'runc', 'runsc', 'psql', 'postgres'];
const binaries = Object.fromEntries(await Promise.all(commands.map(async name => [name, await onPath(name)])));
const profile = await readJson('deploy/workspace-worker/workspace-worker.json');
const gatewayKind = profile.value?.gateway?.kind;
// Only classify the committed template; never emit URLs, config bodies or secrets.
const templateStatus = gatewayKind === 'blocked' ? 'blocked'
  : gatewayKind === 'credential-isolated-gateway' ? 'declared-unverified' : 'unavailable-or-invalid';
const envNames = ['OPENSANDBOX_ENDPOINT', 'DATABASE_URL', 'PGHOST', 'DOCKER_HOST', 'KUBECONFIG', 'KUBERNETES_SERVICE_HOST'];

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  evidenceKind: 'offline-inventory',
  revision: { head: revision('HEAD'), tree: revision('HEAD^{tree}'), scope: 'committed identity; inventory reads current filesystem' },
  node: process.version,
  binaries,
  packages,
  environmentPresence: Object.fromEntries(envNames.map(name => [name, Boolean(process.env[name])])),
  imageGatewayTemplate: { path: 'deploy/workspace-worker/workspace-worker.json', status: templateStatus },
  runtimeReadiness: 'not-established',
  gates: [
    { id: 'trusted-bootstrap', evidence: 'not-assessed', source: 'src/worker.ts', requirement: 'Trusted application runtime and workspace resolver injected into service.' },
    { id: 'lifecycle-authority', evidence: 'not-assessed', source: 'src/adapters/opensandbox-workspace.ts', requirement: 'Independent preflight, allocation fencing, frozen collection and physical destruction verification.' },
    { id: 'protected-request-ingress', evidence: 'not-assessed', source: 'deploy/workspace-worker/README.md', requirement: 'Request readable by worker but unmodifiable by repository descendants, with protected parent and evidence storage.' },
    { id: 'immutable-image', evidence: 'not-assessed', source: 'deploy/workspace-worker/Dockerfile', requirement: 'Digest-pinned built image and actual UID, quotas, isolation and filesystem controls verified.' },
    { id: 'gateway-and-egress', evidence: 'not-assessed', source: 'src/workspace/worker-protocol.ts', requirement: 'Authenticated credential-isolated gateway and enforced network policy verified outside sandbox.' },
  ],
  liveChecksPerformed: { postgres: false, containerDaemon: false, sandbox: false, gateway: false, model: false, deployment: false },
  limitations: [
    'Binary, package and environment presence do not establish a running service or working route.',
    'Gateway classification is not schema validation or deployment evidence.',
    'This command cannot certify readiness; --require-ready always exits 78 until a separate live verifier exists.',
    'No endpoint, socket, credentials file or SDK is accessed; no runtime state is changed.',
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (args.includes('--require-ready')) process.exitCode = 78;
