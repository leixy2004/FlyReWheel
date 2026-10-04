import type { Command } from 'commander';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { databaseCommand, storeFor } from './cli-database.js';
import { ApplicationJobSchema } from './application-job-contract.js';
import { PrMiningRequestInputSchema } from './core/pr-mining.js';
import { prepareMiningApplicationJob, preflightApplicationJob, inspectApplicationOperation } from './application-preflight.js';
import { inspectWorkerBootstrap } from './worker-bootstrap.js';

async function readJson(path: string) {
  if ((await stat(path)).size > 2_000_000) throw new Error('Operation input exceeds 2MB');
  const bytes = await readFile(path);
  if (bytes.length > 2_000_000) throw new Error('Operation input exceeds 2MB');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Operation input must be UTF-8 JSON'); }
}
async function writeImmutableJob(path: string, job: unknown) {
  const bytes = JSON.stringify(job, null, 2) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== bytes) throw new Error('Job output already exists with different bytes; choose a new path');
  }
}

/** Administrative configuration is a separate file, never part of a job. These
 * commands do not load modules, configure credentials, allocate runtimes or infer. */
export function registerApplicationOperationCommands(parent: Command,
  output: (value: unknown, path?: string) => Promise<void>) {
  parent.command('bootstrap-check').description('Offline configuration presence check; no deployment authority is inferred from JSON')
    .option('--config <file>', 'Explicit administrator configuration; no ambient file or module loading')
    .action(async options => {
      await output(inspectWorkerBootstrap(options.config ? await readJson(options.config) : undefined));
    });
  databaseCommand(parent, 'prepare-mining').description('Persist an exact mining request and export an immutable job; does not enqueue or execute')
    .requiredOption('--request <file>', 'Existing mining request input; referenced evidence must already be in this database')
    .requiredOption('--workspace-id <id>', 'Logical workspace ID for a deployment-owned resolver; never a filesystem path')
    .requiredOption('--candidate-created-at <iso-time>', 'Explicit authored attempt timestamp, at or after the request')
    .option('--attempt <id>', 'Explicit immutable attempt identity', 'initial')
    .requiredOption('--job-out <file>', 'New job JSON file; identical bytes may be reused, never overwritten')
    .action(async options => {
      const input = PrMiningRequestInputSchema.parse(await readJson(options.request));
      const store = await storeFor(options);
      try {
        const prepared = await prepareMiningApplicationJob(store, input, { workspaceId: options.workspaceId,
          candidateCreatedAt: options.candidateCreatedAt, attempt: options.attempt });
        await writeImmutableJob(options.jobOut, prepared.job);
        await output({ ...prepared, jobFile: options.jobOut });
      } finally { await store.close(); }
    });
  databaseCommand(parent, 'preflight').description('Check exact domain references and explicit bootstrap prerequisites without claiming a job')
    .requiredOption('--file <file>', 'Normalized application job JSON')
    .option('--config <file>', 'Separate administrator bootstrap configuration; cannot provide trusted code capabilities')
    .action(async options => {
      const job = ApplicationJobSchema.parse(await readJson(options.file));
      const bootstrapConfig = options.config ? await readJson(options.config) : undefined;
      const store = await storeFor(options);
      try { await output(await preflightApplicationJob(store, job, { bootstrapConfig })); }
      finally { await store.close(); }
    });
  databaseCommand(parent, 'recovery').description('Inspect durable job and recovery instructions; reconciles expired claims, never retries or resets')
    .requiredOption('--file <file>', 'The original exact normalized application job JSON')
    .action(async options => {
      const job = ApplicationJobSchema.parse(await readJson(options.file));
      const store = await storeFor(options);
      try { await output(await inspectApplicationOperation(store, job)); }
      finally { await store.close(); }
    });
}
