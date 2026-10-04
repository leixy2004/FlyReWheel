import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkerServiceOptions } from '../src/worker-service.js';
import { loadWorkerApplication, parseWorkerLaunchOptions, startWorkerFromOptions, type WorkerLaunchResources } from '../src/worker-launch.js';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
const flags = (path = '/trusted/deploy.mjs', digest = 'a'.repeat(64)) => ['--enable-application-execution', '--application-bootstrap', path, '--application-bootstrap-sha256', digest];
const config = { schemaVersion: 1, enabled: true, model: 'authored-model',
  generationLimits: { maxInputBytes: 262144, maxOutputBytes: 131072, timeoutMs: 30000 },
  runtime: { id: 'explicit-runtime', backend: 'opensandbox', endpoint: 'https://sandbox.example.invalid',
    apiKeyEnv: 'EXPLICIT_KEY', image: `registry.example.invalid/worker@sha256:${'a'.repeat(64)}`, cpu: '1', memory: '512Mi',
    maxBundleBytes: 1048576, workerExecutable: '/opt/flyrewheel/bin/workspace-worker', gatewayHost: 'gateway.example.invalid',
    limits: { maxInputBytes: 262144, maxOutputBytes: 131072, timeoutMs: 30000, cleanupTimeoutMs: 1000, maxArtifactBytes: 1024, maxArtifacts: 1 } } };
const source = `export const config=${JSON.stringify(config)};
export const dependencies={authority:{preflight(){throw Error('MUST_NOT_RUN')},stopAndVerify(){throw Error('MUST_NOT_RUN')},async *collectFrozen(){throw Error('MUST_NOT_RUN')},destroyAndVerify(){throw Error('MUST_NOT_RUN')}},resolveWorkspace(){throw Error('MUST_NOT_RUN')}};`;
async function moduleFile(code = source) {
  const root = await mkdtemp(join(tmpdir(), 'worker-launch-')); roots.push(root);
  const path = join(root, 'bootstrap.mjs'); await writeFile(path, code);
  const sha256 = createHash('sha256').update(code).digest('hex');
  return { root, path, options: parseWorkerLaunchOptions(flags(path, sha256)) };
}
it.each([
  ['--enable-application-execution'], ['--application-bootstrap', '/trusted/a.mjs'],
  flags('relative.mjs'), flags('/trusted/a.ts'), flags('/trusted/a.mjs', 'bad'),
  [...flags(), '--enable-application-execution'], ['--check', '--check'], ['--unknown-sensitive-input'], ['file.mjs'],
].map(args => ({ args })))('rejects partial, duplicate or unsupported launch arguments without echoing input', ({ args }) => {
  expect(() => parseWorkerLaunchOptions(args)).toThrow('Worker arguments require explicit');
});
it('defaults disabled and does not load ambient deployment modules', async () => {
  expect(parseWorkerLaunchOptions([])).toEqual({ check: false });
  expect(await loadWorkerApplication({ check: false }, { QE_WORKER_APPLICATION_MODULE: '/nonexistent.mjs' })).toBeUndefined();
});
it('check mode never reads or imports a bootstrap and never opens resources', async () => {
  const options = parseWorkerLaunchOptions(['--check', ...flags('/nonexistent.mjs')]);
  expect(await loadWorkerApplication(options, {})).toBeUndefined();
  const openStore = vi.fn(), openQueue = vi.fn(), startService = vi.fn();
  await expect(startWorkerFromOptions(options, {}, { openStore, openQueue, startService })).rejects.toThrow('check mode');
  expect(openStore).not.toHaveBeenCalled(); expect(openQueue).not.toHaveBeenCalled(); expect(startService).not.toHaveBeenCalled();
  const actual = await exec(process.execPath, ['--import', 'tsx', resolve('src/worker.ts'), '--check', ...flags('/nonexistent.mjs')],
    { env: { PATH: process.env.PATH }, timeout: 15000 });
  expect(JSON.parse(actual.stdout)).toMatchObject({ status: 'checked', applicationRuntime: 'blocked', trustedDependencies: 'not_loaded_or_verified' });
});
it('composes the strict existing runtime without calling injected authority or resolver', async () => {
  const { options } = await moduleFile();
  const application = await loadWorkerApplication(options, { EXPLICIT_KEY: 'authored-private-value' });
  expect(application).toMatchObject({ config: { enabled: true, model: 'authored-model' }, runtime: { backend: { kind: 'isolated-runtime' } } });
  expect(typeof application?.resolveWorkspace).toBe('function');
  expect(JSON.stringify(application)).not.toContain('authored-private-value');
});
it('refuses altered bytes before executing top-level code, and refuses symlink aliases', async () => {
  const { root, path, options } = await moduleFile(); const marker = join(root, 'must-not-exist');
  await writeFile(path, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
  await expect(loadWorkerApplication(options, {})).rejects.toThrow('bootstrap rejected');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const alias = join(root, 'alias.mjs'); await symlink(path, alias);
  const bytes = await readFile(path); const digest = createHash('sha256').update(bytes).digest('hex');
  await expect(loadWorkerApplication(parseWorkerLaunchOptions(flags(alias, digest)), {})).rejects.toThrow('bootstrap rejected');
});
it.each([
  `throw Error('sensitive-private-value');`,
  `export default ${JSON.stringify(config)};`,
  `${source}\nexport const unexpected='sensitive-private-value';`,
  `${source}\ndependencies.environment={EXPLICIT_KEY:'sensitive-private-value'};`,
  `export const config=${JSON.stringify(config)};export const dependencies={authority:{},resolveWorkspace(){}};`,
  `export const config=${JSON.stringify({ ...config, apiKey: 'sensitive-private-value' })};export const dependencies={};`,
])('redacts imports and rejects malformed exports/configuration before opening a store', async code => {
  const { options } = await moduleFile(code); const openStore = vi.fn(), openQueue = vi.fn(), startService = vi.fn();
  try { await startWorkerFromOptions(options, {}, { openStore, openQueue, startService }); throw Error('unexpected success'); }
  catch (error) { expect(String(error)).toContain('bootstrap rejected'); expect(String(error)).not.toContain('sensitive-private-value'); }
  expect(openStore).not.toHaveBeenCalled(); expect(openQueue).not.toHaveBeenCalled(); expect(startService).not.toHaveBeenCalled();
});
it('opens resources only after composition and closes the store if queue opening fails', async () => {
  const { options } = await moduleFile(); const close = vi.fn(async () => {});
  const openStore = vi.fn(async () => ({ close })), openQueue = vi.fn(async () => { throw Error('queue failed'); }), startService = vi.fn();
  await expect(startWorkerFromOptions(options, { EXPLICIT_KEY: 'authored', DATABASE_URL: 'postgresql://localhost/authored' },
    { openStore, openQueue, startService } as unknown as WorkerLaunchResources)).rejects.toThrow('queue failed');
  expect(close).toHaveBeenCalledOnce(); expect(startService).not.toHaveBeenCalled();
});
it('passes configured application to the service and leaves default execution blocked', async () => {
  const { options } = await moduleFile(); const store = {}, boss = {}, service = {};
  const resources = { openStore: vi.fn(async () => store), openQueue: vi.fn(async () => boss), startService: vi.fn(async (_options: WorkerServiceOptions) => service) };
  const env = { EXPLICIT_KEY: 'authored', DATABASE_URL: 'postgresql://localhost/authored' };
  expect(await startWorkerFromOptions(options, env, resources as unknown as WorkerLaunchResources)).toBe(service);
  expect(resources.startService.mock.calls[0][0]).toMatchObject({ store, boss, environment: env, application: { config: { enabled: true } } });
  resources.startService.mockClear();
  await startWorkerFromOptions(parseWorkerLaunchOptions([]), env, resources as unknown as WorkerLaunchResources);
  expect(resources.startService.mock.calls[0][0]).not.toHaveProperty('application');
});

it('loads literal special-character paths through the actual Node URL importer', async () => {
  // Vitest transforms dynamic imports; use Node itself for percent/hash URL semantics.
  const { root } = await moduleFile();
  const path = join(root, "bootstrap # % ' ü.mjs"); await writeFile(path, source);
  const digest = createHash('sha256').update(source).digest('hex');
  const loader = pathToFileURL(resolve('src/worker-launch.ts')).href;
  const code = `import{loadWorkerApplication,parseWorkerLaunchOptions}from${JSON.stringify(loader)};
    const app=await loadWorkerApplication(parseWorkerLaunchOptions(process.argv.slice(1)),{EXPLICIT_KEY:'authored'});
    console.log(JSON.stringify({enabled:app.config.enabled,kind:app.runtime.backend.kind}));`;
  const actual = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, '--', ...flags(path, digest)],
    { env: { PATH: process.env.PATH }, timeout: 15000 });
  expect(JSON.parse(actual.stdout)).toEqual({enabled:true,kind:'isolated-runtime'});
});
