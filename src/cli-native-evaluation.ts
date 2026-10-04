import type { Command } from 'commander';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { readEvaluationJson, writeEvaluationJson } from './paired-evaluation.js';
import { loadNativeEvaluationBridge, runNativeEvaluationBridge } from './native-evaluation-bridge.js';
import { canonicalJson, digestOf } from './core/identity.js';

export function registerNativeEvaluationCommands(evaluation: Command) {
  const native = evaluation.command('native').description('One offline evaluation chain: builtin authored study or explicit real-W0 blocked checkpoint; zero model calls');
  native.command('init-authored').requiredOption('--directory <new-directory>')
    .action(async options => {
      const { NativeEvaluationBridgeManifestSchema, createEvaluationBridgeFixture } = await loadNativeEvaluationBridge();
      const directory = resolve(options.directory);
      await mkdir(directory, { mode: 0o700 });
      const root = await realpath(directory);
      const { studyInput, registry } = await createEvaluationBridgeFixture(root);
      const manifest = NativeEvaluationBridgeManifestSchema.parse({ schemaVersion: 1, purpose: 'offline-study',
        kind: 'authored-eligible', registry, study: { schedule: studyInput.schedule,
          configuration: studyInput.configuration, blocks: studyInput.blocks } });
      const path = join(root, 'manifest.json'); await writeEvaluationJson(path, manifest);
      process.stdout.write(`${JSON.stringify({ manifest: path, digest: digestOf(manifest), modelExecution: 'not_run',
        nextCommand: `npm run cli -- evaluation native run --manifest ${JSON.stringify(path)} --checkpoint ${JSON.stringify(join(root, 'checkpoint'))}` })}\n`);
    });
  native.command('init-w0').requiredOption('--contexts <files...>', 'Six frozen GitHub context JSON artifacts; no source fetch')
    .requiredOption('--provenance <file>', 'Existing W0 semantic eligibility/provenance ledger')
    .requiredOption('--source-commit <sha>', 'GitHub commit used to read the frozen artifacts')
    .option('--registry <file>', 'Data environment registry of all six already prepared exports; diagnostic selections remain diagnostic')
    .requiredOption('--out <new-file>')
    .action(async options => {
      const { NativeEvaluationBridgeManifestSchema } = await loadNativeEvaluationBridge();
      if (options.contexts.length !== 6) throw new Error('Supply exactly six frozen W0 context files');
      const contexts = await Promise.all(options.contexts.map((path: string) => readEvaluationJson(path, 2_000_000)));
      const manifest = NativeEvaluationBridgeManifestSchema.parse({ schemaVersion: 1, purpose: 'offline-study', kind: 'real-w0-blocked',
        sources: { sourceCommit: options.sourceCommit, contexts, provenance: await readEvaluationJson(options.provenance, 2_000_000) },
        ...(options.registry ? { registry: await readEvaluationJson(options.registry, 2_000_000) } : {}) });
      await writeEvaluationJson(options.out, manifest);
      process.stdout.write(`${JSON.stringify({ manifest: options.out, digest: digestOf(manifest), eligibility: 'blocked',
        modelExecution: 'not_run', nextAction: 'Run the same native run command to persist/reopen the explicit non-executable state' })}\n`);
    });
  native.command('run').requiredOption('--manifest <file>', 'Frozen authored study or real-W0 blocked manifest, at most 16 MB')
    .requiredOption('--checkpoint <directory>', 'Persistent PGlite/native checkpoint or immutable blocked result directory')
    .option('--timeout-ms <milliseconds>', 'Cooperative verification and dispatch admission deadline', '120000')
    .action(async options => {
      const timeout = z.coerce.number().int().min(1).max(300_000).parse(options.timeoutMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Native evaluation bridge deadline exceeded')), timeout);
      try {
        const manifest = await readEvaluationJson(options.manifest, 16_000_000);
        const result = await runNativeEvaluationBridge(manifest, resolve(options.checkpoint), controller.signal);
        // PostgreSQL JSONB can reorder keys on reopen; keep CLI artifact bytes stable.
        process.stdout.write(`${JSON.stringify(JSON.parse(canonicalJson(result)), null, 2)}\n`);
      } finally { clearTimeout(timer); }
    });
}
