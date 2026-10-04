import type { z } from 'zod';
import { access } from 'node:fs/promises';

/** Fixed research-module location, never supplied by a manifest or environment.
 * Deployment intentionally excludes research fixtures; no operational fallback.
 */
export async function loadNativeEvaluationBridge(): Promise<{
  NativeEvaluationBridgeManifestSchema: z.ZodType<Record<string, unknown>>;
  runNativeEvaluationBridge(raw: unknown, checkpointPath: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  createEvaluationBridgeFixture(root: string): Promise<{
    studyInput: { schedule: unknown; configuration: unknown; blocks: unknown }; registry: unknown;
  }>;
}> {
  const url = new URL('../experiments/matched-revision/native-evaluation-bridge.ts', import.meta.url);
  try {
    if (!import.meta.url.endsWith('.ts')) throw new Error('Research commands require the source entrypoint');
    await access(url);
  }
  catch { throw new Error('Offline native evaluation requires the source checkout and tsx: run npm run cli -- evaluation native --help there. No runtime or model was started.'); }
  return import(url.href);
}

export async function runNativeEvaluationBridge(raw: unknown, checkpointPath: string, signal: AbortSignal) {
  return (await loadNativeEvaluationBridge()).runNativeEvaluationBridge(raw, checkpointPath, signal);
}
