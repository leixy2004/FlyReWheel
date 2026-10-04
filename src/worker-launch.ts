import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { composeWorkerApplication, type WorkerBootstrapDependencies } from './worker-bootstrap.js';
import { openSelectedStore, resolveDatabaseSelection } from './storage/connection.js';
import { openQueue } from './jobs.js';
import { startWorkerService, type WorkerServiceOptions } from './worker-service.js';

export interface WorkerLaunchOptions {
  check: boolean;
  application?: { path: string; sha256: string };
}
const invalidArguments = () => new Error('Worker arguments require explicit enable, absolute .mjs bootstrap path and SHA-256 together');
/** No environment variable or queued payload can select executable deployment code. */
export function parseWorkerLaunchOptions(args: string[]): WorkerLaunchOptions {
  let values;
  try {
    const parsed = parseArgs({ args, tokens: true, strict: true, allowPositionals: false, options: {
      check: { type: 'boolean' }, 'enable-application-execution': { type: 'boolean' },
      'application-bootstrap': { type: 'string' }, 'application-bootstrap-sha256': { type: 'string' },
    } });
    const names = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error();
    values = parsed.values;
  } catch { throw invalidArguments(); }
  const path = values['application-bootstrap'], sha256 = values['application-bootstrap-sha256'];
  const supplied = values['enable-application-execution'] !== undefined || path !== undefined || sha256 !== undefined;
  if (!supplied) return { check: values.check === true };
  if (values['enable-application-execution'] !== true || !path || !isAbsolute(path)
    || extname(path) !== '.mjs' || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw invalidArguments();
  return { check: values.check === true, application: { path, sha256 } };
}

/** Imports explicitly reviewed deployment code only after checking its top-level bytes.
 * The hash does not authenticate transitive imports or isolate arbitrary module code.
 * Deployment operators must protect the module and its dependencies from modification.
 */
export async function loadWorkerApplication(options: WorkerLaunchOptions, environment: NodeJS.ProcessEnv): Promise<WorkerServiceOptions['application']> {
  if (options.check || !options.application) return undefined;
  const { path, sha256 } = options.application;
  try {
    if (!isAbsolute(path) || extname(path) !== '.mjs' || !/^[a-f0-9]{64}$/.test(sha256)
      || await realpath(path) !== path) throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1_048_576) throw new Error();
      const bytes = Buffer.alloc(1_048_577);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > 1_048_576 || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== sha256) throw new Error();
    } finally { await file.close(); }
    const url = pathToFileURL(path); url.searchParams.set('sha256', sha256);
    const module = await import(url.href);
    if (Object.keys(module).sort().join(',') !== 'config,dependencies') throw new Error();
    const deps = module.dependencies;
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)
      || Object.keys(deps).some(key => !['authority', 'resolveWorkspace', 'createSandbox', 'transfer'].includes(key))) throw new Error();
    // Credentials come solely from the explicitly named variable in this environment.
    return composeWorkerApplication(module.config, { ...deps, environment } as WorkerBootstrapDependencies);
  } catch { throw new Error('Worker application bootstrap rejected; verify reviewed module, pinned bytes, strict configuration and trusted dependencies'); }
}

/** Test/resource seams are code-only; the executable never loads them from JSON. */
export interface WorkerLaunchResources {
  openStore: typeof openSelectedStore;
  openQueue: typeof openQueue;
  startService: typeof startWorkerService;
}
export async function startWorkerFromOptions(options: WorkerLaunchOptions, environment: NodeJS.ProcessEnv,
  resources: WorkerLaunchResources = { openStore: openSelectedStore, openQueue, startService: startWorkerService }) {
  if (options.check) throw new Error('Worker check mode cannot start services');
  const application = await loadWorkerApplication(options, environment);
  const selection = resolveDatabaseSelection({ postgres: true }, environment, { postgresOnly: true });
  if (selection.kind !== 'postgres') throw new Error('Worker requires PostgreSQL');
  const store = await resources.openStore(selection);
  let boss;
  try { boss = await resources.openQueue({ connectionString: selection.connectionString }); }
  catch (error) { await store.close(); throw error; }
  // startWorkerService owns and closes store/queue, including failed startup.
  return resources.startService({ store, boss, environment, ...(application ? { application } : {}) });
}
