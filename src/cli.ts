import { Command } from 'commander';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { RuleBundleSchema } from './core/index.js';
import { QualEvoStore } from './storage/index.js';
import { ReplayDatasetSchema, replayDataset } from './pipeline.js';
import { runDemo } from './demo.js';
import { detectAstGrep } from './adapters/index.js';
import { bundleDigest } from './core/index.js';
import { configuredCodex, resolveCodexExecutionConfig } from './model-runtime.js';
import { enqueueReplay, openQueue } from './jobs.js';
import { extractBugFixPair } from './git-evidence.js';

async function json(path: string) {
  if ((await stat(path)).size > 2_000_000) throw new Error('Input exceeds 2MB; use an explicit smaller batch');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function output(value: unknown, path?: string) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (path) await writeFile(path, text, { mode: 0o600 }); else process.stdout.write(text);
}
async function storeFor(db?: string) { return db ? QualEvoStore.openPGlite(db) : QualEvoStore.openPGlite(); }
const cli = new Command().name('flyrewheel').description('Evidence-backed quality rules; all commands are local/read-only externally by default');
cli.command('extract').requiredOption('--repo <directory>').requiredOption('--base <ref>').requiredOption('--head <ref>').requiredOption('--path <file>').requiredOption('--case-id <id>').requiredOption('--problem <description>', 'Explicit bug claim, not inferred from commit text').option('--language <language>', 'ast-grep language', 'typescript').requiredOption('--out <file>').action(async options => {
  await output(await extractBugFixPair({ repository: options.repo, base: options.base, head: options.head, path: options.path, caseId: options.caseId, language: options.language, problem: options.problem }), options.out);
});
cli.command('demo').option('--db <directory>', 'Persistent local PGlite directory').option('--out <file>').action(async options => {
  const store = await storeFor(options.db);
  try { await output(await runDemo(store), options.out); } finally { await store.close(); }
});
cli.command('replay').requiredOption('--bundle <file>').requiredOption('--dataset <file>').option('--db <directory>').option('--out <file>').option('--enable-model', 'Explicitly permit Codex inference with configured authentication').option('--attempt <id>', 'New immutable attempt identity after fixing an execution failure').action(async options => {
  const store = await storeFor(options.db);
  try {
    const bundle = RuleBundleSchema.parse(await json(options.bundle));
    const dataset = ReplayDatasetSchema.parse(await json(options.dataset));
    const adapter = options.enableModel ? configuredCodex(process.env) : undefined;
    const result = await replayDataset({ store, bundle, dataset, mode: adapter ? 'model' : 'offline_fixture', modelConfig: adapter?.executionConfig, adjudicator: adapter?.adjudicate, attempt: options.attempt });
    await output(result, options.out);
    if (result.report.metrics.executionErrors) process.exitCode = 2;
  } finally { await store.close(); }
});
cli.command('scan').requiredOption('--bundle <file>').requiredOption('--file <file>').option('--out <file>').action(async options => {
  const bundle = RuleBundleSchema.parse(await json(options.bundle));
  if (bundle.detector.kind !== 'ast-grep') throw new Error('scan uses ast-grep; Semgrep/OpenGrep JSON can be imported via the adapter');
  if ((await stat(options.file)).size > 1_000_000) throw new Error('Source exceeds 1MB');
  await output(detectAstGrep({ source: await readFile(options.file, 'utf8'), path: options.file, language: bundle.detector.language, pattern: bundle.detector.pattern, ruleId: bundle.ruleId, ruleVersion: bundle.version, bundleDigest: bundleDigest(bundle) }), options.out);
});
cli.command('synthesize').requiredOption('--input <file>', 'Explicit training bug/fix pairs; no heldout data').requiredOption('--out <file>').option('--enable-model').action(async options => {
  if (!options.enableModel) throw new Error('synthesize requires --enable-model and explicit Codex configuration');
  const result = await configuredCodex(process.env).synthesize(await json(options.input));
  await output(result, options.out);
  if (result.execution === 'failed') process.exitCode = 2;
});
cli.command('enqueue').requiredOption('--bundle <file>').requiredOption('--dataset <file>').option('--enable-model').option('--interactive').option('--attempt <id>', 'New immutable attempt identity after fixing an execution failure').action(async options => {
  if (!process.env.DATABASE_URL) throw new Error('enqueue requires an explicitly configured self-hosted DATABASE_URL');
  const execution = options.enableModel ? { mode: 'model' as const, modelConfig: resolveCodexExecutionConfig(process.env) } : { mode: 'offline_fixture' as const };
  const boss = await openQueue({ connectionString: process.env.DATABASE_URL });
  try { await output({ jobId: await enqueueReplay(boss, { bundle: RuleBundleSchema.parse(await json(options.bundle)), dataset: ReplayDatasetSchema.parse(await json(options.dataset)), ...execution, attempt: options.attempt, workload: options.interactive ? 'interactive' : 'background' }) }); }
  finally { await boss.stop({ graceful: true }); }
});
await cli.parseAsync().catch(error => { process.stderr.write(`FlyReWheel: ${error instanceof Error ? error.message : 'Command failed'}\n`); process.exitCode = 1; });
