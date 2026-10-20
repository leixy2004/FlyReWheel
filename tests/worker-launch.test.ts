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
const compiled = process.env.WORKER_LAUNCH_COMPILED === '1';
const nodeArgs = compiled ? [] : ['--import', 'tsx'];
const entrypoint = resolve(compiled ? 'dist/worker.js' : 'src/worker.ts');
const loaderPath = resolve(compiled ? 'dist/worker-launch.js' : 'src/worker-launch.ts');
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
  const actual = await exec(process.execPath, [...nodeArgs, entrypoint, '--check', ...flags('/nonexistent.mjs')],
   { env: { PATH: process.env.PATH }, timeout: 15000 });
  expect(JSON.parse(actual.stdout)).toMatchObject({ status: 'checked', applicationRuntime: 'blocked', applicationBootstrapRequested: true, trustedDependencies: 'not_loaded_or_verified' });
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
  const loader = pathToFileURL(loaderPath).href;
  const code = `import{loadWorkerApplication,parseWorkerLaunchOptions}from${JSON.stringify(loader)};
   const app=await loadWorkerApplication(parseWorkerLaunchOptions(process.argv.slice(1)),{EXPLICIT_KEY:'authored'});
   console.log(JSON.stringify({enabled:app.config.enabled,kind:app.runtime.backend.kind}));`;
  const actual = await exec(process.execPath, [...nodeArgs, '--input-type=module', '-e', code, '--', ...flags(path, digest)],
   { env: { PATH: process.env.PATH }, timeout: 15000 });
  expect(JSON.parse(actual.stdout)).toEqual({enabled:true,kind:'isolated-runtime'});
});

it.each([
  ['--check', '--config', 'old.json', ...flags()],
  ['--check', '--local-development', 'receipt.json', ...flags()],
  ['--check', '--config', 'a', '--local-development', 'b'],
  ['--check', '--config', 'a', '--config', 'b'], ['--config', ''],
 ].map(args => ({ args })))('rejects ambiguous inspection and launch modes', ({ args }) => {
  expect(() => parseWorkerLaunchOptions(args)).toThrow('Worker arguments');
});
it('retains config preflight, check-only status and explicit local/config start rejection in the executable', async () => {
  const run = (...args: string[]) => exec(process.execPath, [...nodeArgs, entrypoint, ...args], { env: { PATH: process.env.PATH }, timeout: 15000 });
  expect(JSON.parse((await run('--check')).stdout)).toMatchObject({ applicationRuntime: 'blocked' });
  expect(JSON.parse((await run('--check', '--config', resolve('examples/worker/preflight-only.json'))).stdout)).toMatchObject({
    status: 'blocked', configuration: 'schema-valid', resolver: 'built-in-prepared-workspace-resolver', credential: { valueRead: false } });
  await expect(run('--config', 'not-read.json')).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('configuration alone') });
  await expect(run('--local-development', 'not-read.json')).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('supports --check') });
  await expect(run('--check', '--local-development', 'absent.json')).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('inspection failed') });
  await expect(run('--unknown-sensitive-value')).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Invalid worker arguments') });
 }, 60000);
it('starts and stops the real service twice in a Node process using authored storage/queue and a loopback health socket', async () => {
  const { options } = await moduleFile();
  const code = `import{startWorkerFromOptions}from ${JSON.stringify(pathToFileURL(loaderPath).href)};
    import{startWorkerService}from ${JSON.stringify(pathToFileURL(resolve(compiled ? 'dist/worker-service.js' : 'src/worker-service.ts')).href)};
    import{EventEmitter}from 'node:events';
    let closes=0,stops=0,registrations=0;const results=[];
    for(let i=0;i<2;i++){
      const store={async close(){closes++},async reconcileExpiredApplicationJobs(){}};
      const boss=Object.assign(new EventEmitter(),{async work(){registrations++},async getQueue(){return{}},async stop(){stops++}});
      const service=await startWorkerFromOptions(${JSON.stringify(options)}, {EXPLICIT_KEY:'authored',DATABASE_URL:'postgresql://localhost/authored'}, {
        async openStore(){return store},async openQueue(){return boss},
        startService:opts=>startWorkerService({...opts,host:'127.0.0.1',port:0})
      });
      results.push(service.applicationRuntime);
      await Promise.all([service.stop(),service.stop()]);
    }
    console.log(JSON.stringify({results,closes,stops,registrations}));`;
  const actual=await exec(process.execPath,[...nodeArgs,'--input-type=module','-e',code],{env:{PATH:process.env.PATH},timeout:15000});
  expect(JSON.parse(actual.stdout)).toEqual({results:['configured','configured'],closes:2,stops:2,registrations:4});
});

it('rejects oversized modules before top-level code and verifies bytes again on a repeated load', async () => {
  const { path, options } = await moduleFile();
  await loadWorkerApplication(options, { EXPLICIT_KEY: 'authored' });
  await writeFile(path, source + '\n// altered');
  await expect(loadWorkerApplication(options, { EXPLICIT_KEY: 'authored' })).rejects.toThrow('bootstrap rejected');
  const code = '// oversized\n' + ' '.repeat(1_048_576);
  await writeFile(path, code);
  await expect(loadWorkerApplication(parseWorkerLaunchOptions(flags(path, createHash('sha256').update(code).digest('hex'))), {})).rejects.toThrow('bootstrap rejected');
});
