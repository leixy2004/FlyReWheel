import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runCodexWorkspaceWorker, type CodexWorkerDependencies } from './adapters/codex-workspace-worker.js';
import { ContextRevisionModelResponseSchema, LegacyRevisionModelResponseSchema, RevisionModelResponseSchema } from './core/revision-model.js';
import { ComparisonApplicabilityModelResponseSchema } from './core/comparison-applicability-model.js';
import { MatchedDiagnosisSchema, ProposalSchema, ReviewSchema } from './core/matched-revision-model.js';
import { PrMiningModelResponseSchema } from './core/pr-mining-model.js';
import { ContextSemanticReviewModelResponseSchema, PerAnchorSemanticReviewModelResponseSchema, SemanticReviewModelResponseSchema } from './core/semantic-review-model.js';
import { EvaluationWorkspaceBindingSchema } from './workspace/history-policy.js';
import { verifyRuntimeCheckout } from './workspace/runtime-checkout.js';
import { ComparisonApplicabilityWorkspaceWorkerResult, MatchedDiagnosisWorkspaceWorkerResult, MatchedProposalWorkspaceWorkerResult, MatchedReviewWorkspaceWorkerResult, PrMiningWorkspaceWorkerResult, RevisionWorkspaceWorkerResult, SemanticReviewWorkspaceWorkerResult, WorkspaceWorkerAnswer, WorkspaceWorkerImageConfig, WorkspaceWorkerInput, WorkspaceWorkerResult } from './workspace/worker-protocol.js';

const ROOT = '/workspace/repo';
const REQUEST = '/run/flyrewheel/request.json';
const CONFIG = '/opt/flyrewheel/workspace-worker.json';
const CODEX = '/opt/flyrewheel/codex/bin/codex';
class ProductionBlocked extends Error {}

/** No CLI flag/environment switch enables this test seam. Tests import the function
 * into an authored harness; the shipped CLI always uses fixed production paths. */
export interface AuthoredWorkspaceWorkerFixture {
  kind: 'authored-test-no-isolation'; fixtureRoot: string; workingDirectory: string;
  requestPath: string; codexPathOverride: string; imageConfig: z.infer<typeof WorkspaceWorkerImageConfig>;
}

async function readBoundedJson(path: string, maxBytes: number) {
  if (!isAbsolute(path) || await realpath(dirname(path)) !== dirname(path)) throw new Error('Noncanonical control path');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('Invalid or oversized control file');
    const bytes = Buffer.alloc(maxBytes + 1); let size = 0;
    while (size < bytes.length) {
      const chunk = await file.read(bytes, size, bytes.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > maxBytes) throw new Error('Control file exceeds its byte bound');
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown, bytes: size };
  } finally { await file.close(); }
}

async function rootOwned(path: string, directory = false) {
  const info = await lstat(path);
  if (await realpath(path) !== path || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || info.uid !== 0 || (info.mode & 0o022) !== 0 || (!directory && info.nlink !== 1)) throw new ProductionBlocked('Immutable worker/control storage is not provisioned');
}

async function verifyLocalInstallation() {
  if (process.getuid?.() !== 10001) throw new ProductionBlocked('Worker requires its dedicated unprivileged runtime identity');
  for (const path of ['/opt', '/opt/flyrewheel', '/opt/flyrewheel/bin', '/opt/flyrewheel/codex', '/opt/flyrewheel/codex/bin']) await rootOwned(path, true);
  for (const path of [CONFIG, CODEX, '/opt/flyrewheel/bin/workspace-worker', fileURLToPath(import.meta.url)]) await rootOwned(path);
  // Local ownership is only a necessary condition. The external lifecycle
  // authority must independently verify isolation, mounts, quotas and gateway.
  for (const path of ['/run', '/run/flyrewheel']) await rootOwned(path, true);
  await rootOwned(REQUEST);
}

export async function runWorkspaceWorkerCommand(args: string[], fixture?: AuthoredWorkspaceWorkerFixture, signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'linux') throw new Error('Workspace worker requires Linux');
  const cwd = fixture?.workingDirectory ?? process.cwd();
  if (fixture) {
    if (fixture.kind !== 'authored-test-no-isolation' || !isAbsolute(fixture.fixtureRoot)
      || await realpath(fixture.fixtureRoot) !== fixture.fixtureRoot) throw new Error('Invalid authored fixture root');
    for (const path of [cwd, fixture.requestPath, fixture.codexPathOverride]) {
      if (!isAbsolute(path) || relative(fixture.fixtureRoot, path).startsWith('..')) throw new Error('Authored paths must remain inside fixture root');
    }
  }
  if (args[0] === 'verify' && (args.length === 4 || args.length === 5)) {
    if (args[4] && Buffer.byteLength(args[4]) > 100_000) throw new Error('Evaluation binding exceeds byte bound');
    const evaluation = args[4] === undefined ? undefined : EvaluationWorkspaceBindingSchema.parse(JSON.parse(args[4]));
    const observation = await verifyRuntimeCheckout(cwd, args[1], args[2], args[3], fixture?.fixtureRoot, evaluation);
    return JSON.stringify(observation) + '\n';
  }
  if (args[0] !== 'run' || args.length !== 2 || args[1] !== (fixture?.requestPath ?? REQUEST)) throw new Error('Expected verify SHA BRANCH POLICY [EVALUATION_JSON] or run /run/flyrewheel/request.json');
  if (!fixture && cwd !== ROOT) throw new ProductionBlocked('Worker requires the fixed runtime checkout');
  const config = WorkspaceWorkerImageConfig.parse(fixture?.imageConfig ?? (await readBoundedJson(CONFIG, 4096)).value);
  if (config.gateway.kind === 'blocked') throw new ProductionBlocked('Production gateway connection is not configured or verified');
  if (!fixture) {
    await verifyLocalInstallation();
  }
  const request = await readBoundedJson(args[1], 2_097_152);
  const input = WorkspaceWorkerInput.parse(request.value);
  if (input.outputContract === 'matched-diagnosis-v1' && !fixture) throw new ProductionBlocked('Matched diagnosis is authored SDK-native only');
  if (input.workingDirectory !== cwd || request.bytes > input.limits.maxInputBytes) throw new Error('Worker request path or byte limit mismatch');
  const dependencies: CodexWorkerDependencies = {
    codexPathOverride: fixture?.codexPathOverride ?? CODEX,
    gateway: config.gateway,
    boundary: fixture ? { kind: 'authored-test-no-isolation', fixtureRoot: fixture.fixtureRoot }
      : { kind: 'isolated-runtime', verify: verifyLocalInstallation },
  };
  // Select from fixed trusted schemas only, never a request-supplied schema.
  const result = input.outputContract === 'matched-diagnosis-v1'
    ? MatchedDiagnosisWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'matched-diagnosis-v1',
      ...await runCodexWorkspaceWorker(input, MatchedDiagnosisSchema, dependencies, signal) })
    : input.outputContract === 'matched-proposal-v1'
    ? MatchedProposalWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'matched-proposal-v1',
      ...await runCodexWorkspaceWorker(input, ProposalSchema, dependencies, signal) })
    : input.outputContract === 'matched-review-v1'
    ? MatchedReviewWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'matched-review-v1',
      ...await runCodexWorkspaceWorker(input, ReviewSchema, dependencies, signal) })
    : input.outputContract === 'comparison-applicability-v1'
    ? ComparisonApplicabilityWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'comparison-applicability-v1',
      ...await runCodexWorkspaceWorker(input, ComparisonApplicabilityModelResponseSchema, dependencies, signal) })
    : input.outputContract === 'rule-revision-v3'
    ? RevisionWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'rule-revision-v3',
      ...await runCodexWorkspaceWorker(input, ContextRevisionModelResponseSchema, dependencies, signal) })
    : input.outputContract === 'rule-revision-v2'
    ? RevisionWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'rule-revision-v2',
      ...await runCodexWorkspaceWorker(input, RevisionModelResponseSchema, dependencies, signal) })
    : input.outputContract === 'rule-revision-v1'
    ? RevisionWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'rule-revision-v1',
      ...await runCodexWorkspaceWorker(input, LegacyRevisionModelResponseSchema, dependencies, signal) })
    : input.outputContract === 'pr-mining-v1'
    ? PrMiningWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'pr-mining-v1',
      ...await runCodexWorkspaceWorker(input, PrMiningModelResponseSchema, dependencies, signal) })
    : input.outputContract === 'semantic-review-v3'
    ? SemanticReviewWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'semantic-review-v3',
      ...await runCodexWorkspaceWorker(input, ContextSemanticReviewModelResponseSchema, dependencies, signal) })
    : input.outputContract === 'semantic-review-v2'
    ? SemanticReviewWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'semantic-review-v2',
      ...await runCodexWorkspaceWorker(input, PerAnchorSemanticReviewModelResponseSchema, dependencies, signal) })
    : input.outputContract === 'semantic-review-v1'
    ? SemanticReviewWorkspaceWorkerResult.parse({ protocolVersion: 2, outputContract: 'semantic-review-v1',
      ...await runCodexWorkspaceWorker(input, SemanticReviewModelResponseSchema, dependencies, signal) })
    : WorkspaceWorkerResult.parse({ protocolVersion: 1,
      ...await runCodexWorkspaceWorker(input, WorkspaceWorkerAnswer, dependencies, signal) });
  const output = JSON.stringify(result) + '\n';
  if (Buffer.byteLength(output) > input.limits.maxOutputBytes) throw new Error('Serialized worker result exceeds output limit');
  return output;
}

/** Fixed diagnostics never echo request contents, SDK output, paths or credentials. */
export async function workspaceWorkerMain(args: string[], fixture?: AuthoredWorkspaceWorkerFixture) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGTERM', abort); process.on('SIGINT', abort);
  try { process.stdout.write(await runWorkspaceWorkerCommand(args, fixture, controller.signal)); }
  catch (error) {
    const blocked = error instanceof ProductionBlocked;
    process.stderr.write(JSON.stringify({ error: blocked ? 'WORKSPACE_WORKER_PRODUCTION_BLOCKED' : 'WORKSPACE_WORKER_FAILED' }) + '\n');
    process.exitCode = blocked ? 78 : 1;
  } finally { process.off('SIGTERM', abort); process.off('SIGINT', abort); }
}

// Node resolves module URLs through symlinks; argv can retain the launch alias.
const launchPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (launchPath && launchPath === await realpath(fileURLToPath(import.meta.url))) await workspaceWorkerMain(process.argv.slice(2));
