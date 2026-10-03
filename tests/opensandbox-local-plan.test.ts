import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';
// @ts-expect-error Standalone operational script has no declaration file.
import { checkPlan, healthUrl, proposedPlan, probeHealth, classifyHealth } from '../scripts/check-opensandbox-local-plan.mjs';

describe('offline plan CLI entrypoint', () => {
  const exec = promisify(execFile);
  const script = fileURLToPath(new URL('../scripts/check-opensandbox-local-plan.mjs', import.meta.url));
  let directory: string, alias: string, invalidPlan: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'flyrewheel-plan-entrypoint-'));
    alias = join(directory, 'plan alias #.mjs');
    invalidPlan = join(directory, 'invalid.json');
    await symlink(script, alias);
    await writeFile(invalidPlan, '{}');
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  it.each(['direct', 'relative-direct', 'file-symlink', 'relative-file-symlink'] as const)
  ('rejects an invalid plan on %s launch', async launch => {
    const target = launch.includes('symlink') ? alias : script;
    const path = launch.startsWith('relative-') ? relative(directory, target) : target;
    await expect(exec(process.execPath, [path, '--plan', invalidPlan], { cwd: directory, timeout: 5000 }))
      .rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.any(String) });
    await expect(exec(process.execPath, [path, '--plan', join(directory, 'missing.json')], { cwd: directory, timeout: 5000 }))
      .rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.any(String) });
    const result = await exec(process.execPath, [path], { cwd: directory, timeout: 5000 });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(checkPlan(proposedPlan));
  });
  it.each(['eval', 'harness'] as const)('does not automatically execute on %s import', async mode => {
    const code = `await import(${JSON.stringify(pathToFileURL(script).href)}); process.stdout.write('import-only');`;
    const harness = join(directory, 'import-only.mjs');
    if (mode === 'harness') await writeFile(harness, code);
    const args = mode === 'eval' ? ['--input-type=module', '--eval', code] : [harness, '--plan', invalidPlan];
    const result = await exec(process.execPath, args, { cwd: directory, timeout: 5000 });
    expect(result).toMatchObject({ stdout: 'import-only', stderr: '' });
  });
});

async function fixture(action: (socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); action(socket); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `https://127.0.0.1:${port}/health`, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

describe('local OpenSandbox proposal validation', () => {
  it('does not demand optional NET_ADMIN policy and never claims runtime readiness', () => {
    const result = checkPlan(proposedPlan);
    expect(result.needsNetAdmin).toBe(false);
    expect(result.hardeningScope).toBe('workload-only');
    expect(result.extractionHelper).toContain('default root/network/capabilities');
    expect(result.classification).toBe('static-plan-only-not-runtime-evidence');
    expect(result.blockers).toContain('expanded-image/container/dependency peak budget has not been measured');
    expect(result.pendingActions).toHaveLength(4);
  });
  it('rejects unsafe exposure, capability additions, credentials and unbounded time', () => {
    for (const change of [{ serverHost: '0.0.0.0' }, { publishHost: '0.0.0.0' }, { networkMode: 'host' },
      { addedCapabilities: ['NET_ADMIN'] }, { privileged: true }, { hostBinds: ['/var/run/docker.sock'] },
      { proxyResolveInternal: true }, { noNewPrivileges: false }, { dropCapabilities: [] }, { pidsLimit: 10000 }, { apiKey: 'not-a-real-secret' }, { networkPolicy: { defaultAction: 'deny' } }, { sandboxTtlSeconds: 301 }]) {
      expect(() => checkPlan({ ...proposedPlan, ...change })).toThrow();
    }
  });
  it('distinguishes unreachable SDK execution from out-of-band Docker exec and enforces capacity', () => {
    expect(checkPlan({ ...proposedPlan, networkMode: 'none' }).blockers.join(' ')).toContain('no routable execd');
    expect(checkPlan({ ...proposedPlan, networkMode: 'none', executionTransport: 'docker-exec' }).limitation).toContain('not SDK execd');
    const measured = { ...proposedPlan, freeBytes: 6 * 1024 ** 3, additionalPeakBytes: 2 * 1024 ** 3 };
    expect(checkPlan(measured).blockers.join(' ')).toContain('reserve');
  });
  it('refuses nonlocal URLs, HTTP, userinfo and non-health paths before connection', () => {
    for (const url of ['http://127.0.0.1/health', 'https://localhost/health', 'https://example.com/health',
      'https://user:pass@127.0.0.1/health', 'https://127.0.0.1/sandboxes', 'https://127.0.0.1/health?key=x']) {
      expect(() => healthUrl(url)).toThrow();
    }
  });
  it('accepts only the official health body and labels it below lifecycle evidence', () => {
    expect(classifyHealth(200, Buffer.from('{"status":"healthy"}'))).toEqual({ ok: true, kind: 'health-only-not-lifecycle' });
    expect(classifyHealth(200, Buffer.from('{"status":"ok"}')).ok).toBe(false);
    expect(classifyHealth(200, Buffer.from('invalid')).kind).toBe('invalid-json');
    expect(classifyHealth(302, Buffer.from('')).kind).toBe('http-status');
  });
  it('reports real TCP refusal without claiming a health or lifecycle receipt', async () => {
    const unused = await fixture(() => {}); await unused.close();
    expect(await probeHealth(unused.url)).toMatchObject({ ok: false, kind: 'transport-error', code: 'ECONNREFUSED' });
  });
  it('refuses plaintext on an HTTPS endpoint instead of downgrading TLS', async () => {
    const plaintext = await fixture(socket => { socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')); });
    try { expect(await probeHealth(plaintext.url)).toMatchObject({ ok: false, kind: 'transport-error', code: 'EPROTO' }); }
    finally { await plaintext.close(); }
  });
  it('bounds a real TCP peer that stalls the TLS handshake', async () => {
    const stalled = await fixture(socket => socket.on('data', () => {}));
    try { expect(await probeHealth(stalled.url, { timeoutMs: 75 })).toEqual({ ok: false, kind: 'deadline' }); }
    finally { await stalled.close(); }
  });
});
