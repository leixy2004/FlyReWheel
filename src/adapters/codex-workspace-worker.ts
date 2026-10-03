import { Codex, type ModelReasoningEffort, type Usage } from '@openai/codex-sdk';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { validateHistoryBinding } from '../workspace/history-policy.js';
import { verifyRuntimeCheckout } from '../workspace/runtime-checkout.js';
import { CodexWorkspaceLimits, type WorkspaceLimits } from '../workspace/codex-runner.js';
import { WorkspaceWorkerGateway, WorkspaceWorkerInput, WorkspaceWorkerProcessEvidence, WorkspaceWorkerUsage } from '../workspace/worker-protocol.js';
import { enforceMatchedCodexExecution } from '../workspace/matched-codex-policy.js';

export type CodexWorkerInput = z.infer<typeof WorkspaceWorkerInput>;
/** Trusted deployment dependency, never a user/job-configurable permission switch.
 * An isolated worker must run this code AND the SDK/CLI in its own sandbox.
 * Verification must establish a credential-isolated gateway and container limits.
 */
export type CodexWorkerBoundary =
  | { kind: 'authored-test-no-isolation'; fixtureRoot: string }
  | { kind: 'isolated-runtime'; verify: () => Promise<void> };
export interface CodexWorkerDependencies {
  codexPathOverride: string;
  boundary: CodexWorkerBoundary;
  /** Trusted image configuration only. Never accepted from a run request. */
  gateway?: WorkspaceWorkerGateway;
  /** Import-only instrumentation; not a worker protocol field or authority. */
  observe?: (event: { kind: 'sdk_invocation' | 'cleanup_started' } | { kind: 'answer'; bytes: number }) => void;
}
export type ProcessEvidence = z.infer<typeof WorkspaceWorkerProcessEvidence>;
export class CodexWorkspaceWorkerError extends Error {
  constructor(message: string, readonly processEvidence: ProcessEvidence | null, readonly retainedRuntimePath: string | null,
    readonly usage: Usage | null = null) { super(message); }
}

// SDK types describe data but its JSONL parser does not validate runtime shapes.
// Keep the supported pinned-SDK event vocabulary explicit, including progress.
const ItemId = z.string().min(1).max(256);
const TextItem = z.object({ id: ItemId, type: z.enum(['agent_message', 'reasoning']), text: z.string() }).strict();
const WorkerItem = z.union([TextItem,
  z.object({ id: ItemId, type: z.literal('command_execution'), command: z.string(), aggregated_output: z.string(),
    exit_code: z.number().int().optional(), status: z.enum(['in_progress', 'completed', 'failed']) }).strict(),
  z.object({ id: ItemId, type: z.literal('file_change'), changes: z.array(z.object({ path: z.string(), kind: z.enum(['add', 'delete', 'update']) }).strict()),
    status: z.enum(['completed', 'failed']) }).strict(),
  z.object({ id: ItemId, type: z.literal('todo_list'), items: z.array(z.object({ text: z.string(), completed: z.boolean() }).strict()) }).strict(),
]);
const WorkerEvent = z.union([
  z.object({ type: z.literal('thread.started'), thread_id: ItemId }).strict(),
  z.object({ type: z.literal('turn.started') }).strict(),
  z.object({ type: z.enum(['item.started', 'item.updated', 'item.completed']), item: WorkerItem }).strict(),
  z.object({ type: z.literal('turn.completed'), usage: WorkspaceWorkerUsage }).strict(),
]);

// This trusted shim bounds raw stdout/stderr BEFORE the SDK's unbounded readline
// and stderr buffers. Linux process groups are supervision, NOT a sandbox: a
// malicious setsid descendant requires the external backend's container stop.
function supervisorSource(executable: string, evidencePath: string, cancelPath: string, limits: WorkspaceLimits,
  modelReasoningEffort?: ModelReasoningEffort, captureRawUsage = false) {
  return `#!${process.execPath}
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const executable = ${JSON.stringify(executable)};
const evidencePath = ${JSON.stringify(evidencePath)};
const cancelPath = ${JSON.stringify(cancelPath)};
const maxBytes = ${limits.maxOutputBytes};
const explicitModelSettings = ${JSON.stringify(modelReasoningEffort === undefined ? {} : { modelReasoningEffort })};
const captureRawUsage = ${captureRawUsage};
let usageLine = '', reportedUsage;
const usageDecoder = new StringDecoder('utf8');
function observeUsage(chunk) {
  if (!captureRawUsage) return;
  usageLine += usageDecoder.write(chunk);
  let newline;
  while ((newline = usageLine.indexOf('\\n')) >= 0) {
    const line = usageLine.slice(0, newline); usageLine = usageLine.slice(newline + 1);
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed') {
        reportedUsage = {};
        for (const key of ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens']) {
          const value = event.usage && event.usage[key];
          reportedUsage[key] = Number.isSafeInteger(value) && value >= 0 ? value : null;
        }
      }
    } catch {}
  }
}
let reason = 'completed', stdoutBytes = 0, stderrBytes = 0, forwardedBytes = 0;
let exitCode = null, finalized = false, timer, cancelTimer;
const child = spawn(executable, process.argv.slice(2), { env: process.env, detached: true, stdio: ['pipe','pipe','pipe'] });
function killGroup() {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') reason = 'group-stop-failed'; }
}
function fail(value) { if (reason === 'completed') reason = value; killGroup(); }
function liveGroup() {
  if (!child.pid) return false;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync('/proc/' + entry + '/stat','utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === child.pid && !['Z','X'].includes(fields[0])) return true;
    } catch(e) { if (!['ENOENT','ESRCH'].includes(e.code)) return true; }
  }
  return false;
}
async function finish() {
  if (finalized) return; finalized = true; clearTimeout(timer); clearInterval(cancelTimer); killGroup();
  if (captureRawUsage && usageLine) observeUsage(Buffer.from('\\n'));
  const deadline = Date.now() + ${Math.min(limits.cleanupTimeoutMs, 2000)};
  while (liveGroup() && Date.now() < deadline) { killGroup(); await new Promise(r => setTimeout(r, 10)); }
  const processGroupStopped = !liveGroup();
  fs.writeFileSync(evidencePath + '.tmp', JSON.stringify({reason, exitCode, stdoutBytes, stderrBytes, forwardedBytes, processGroupStopped, ...explicitModelSettings,
    ...(reportedUsage ? {reportedUsage} : {})}), {mode: 0o600});
  fs.renameSync(evidencePath + '.tmp', evidencePath);
  process.exitCode = !processGroupStopped ? 76 : reason === 'output-limit' ? 74 : reason === 'timeout' ? 75 : reason !== 'completed' ? 73 : exitCode === 0 ? 0 : 72;
}
for (const [stream, destination, label] of [[child.stdout, process.stdout, 'stdout'], [child.stderr, process.stderr, 'stderr']]) {
  stream.on('data', chunk => {
    if (label === 'stdout') stdoutBytes += chunk.length; else stderrBytes += chunk.length;
    if (stdoutBytes + stderrBytes > maxBytes) { fail('output-limit'); return; }
    if (reason !== 'completed') return;
    if (label === 'stdout') observeUsage(chunk);
    forwardedBytes += chunk.length;
    if (!destination.write(chunk)) { stream.pause(); destination.once('drain', () => stream.resume()); }
  });
}
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
child.once('error', () => { reason = 'spawn-failed'; finish(); });
child.once('exit', code => { exitCode = code; killGroup(); });
child.once('close', () => { process.stdin.unpipe(child.stdin); process.stdin.destroy(); finish(); });
process.on('SIGTERM', () => fail('cancelled'));
process.on('SIGINT', () => fail('cancelled'));
process.stdout.on('error', () => fail('output-stream-closed'));
process.stderr.on('error', () => fail('output-stream-closed'));
timer = setTimeout(() => fail('timeout'), ${limits.timeoutMs});
cancelTimer = setInterval(() => { if (fs.existsSync(cancelPath)) fail('cancelled'); }, 10);
`;
}

async function rejectProjectConfiguration(path: string, fixtureRoot?: string) {
  let cursor = path;
  for (;;) {
    await lstat(join(cursor, '.codex')).then(() => { throw new Error('Repository/ancestor .codex configuration is not allowed in the worker runtime'); }, error => { if (error.code !== 'ENOENT') throw error; });
    if (cursor === fixtureRoot || dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
}

/** Official SDK 0.159.2; no fake SDK, ambient auth, resume, or remote-spawn fiction.
 * Missing boundary/executable dependencies fail closed. The fixture boundary is
 * deliberately explicit and must never be selected by a production fallback.
 */
export async function runCodexWorkspaceWorker<T>(input: CodexWorkerInput, schema: z.ZodType<T>, dependencies: CodexWorkerDependencies, signal?: AbortSignal) {
  if (process.platform !== 'linux') throw new Error('Codex workspace supervision currently requires Linux');
  input = WorkspaceWorkerInput.parse(input);
  validateHistoryBinding(input);
  if (!!input.evaluation !== !!input.evaluationBranch) throw new Error('Evaluation worker requires its bound attempt branch');
  const limits = CodexWorkspaceLimits.parse(input.limits);
  const selectedOnly = input.toolPolicy === 'selected-evidence-no-tools-v1';
  if ((input.outputContract === 'rule-revision-v1' || input.outputContract === 'rule-revision-v2' || input.outputContract === 'rule-revision-v3' || input.outputContract === 'comparison-applicability-v1' || input.outputContract === 'matched-diagnosis-v1' || input.outputContract === 'matched-proposal-v1' || input.outputContract === 'matched-review-v1') !== selectedOnly) throw new Error('Revision, comparison applicability and matched output require the fixed selected-evidence/no-tools policy');
  if (input.matchedExecution) enforceMatchedCodexExecution(input.matchedExecution, dependencies?.boundary?.kind);
  if ((!selectedOnly && input.toolPolicy !== 'full-repo-shell-v1')) throw new Error('Explicit supported workspace policies are required');
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(input.model)) throw new Error('An explicit model is required');
  const outputSchema = z.toJSONSchema(schema);
  if (Buffer.byteLength(JSON.stringify({ ...input, outputSchema })) > limits.maxInputBytes) throw new Error('Codex worker input/schema exceeds its byte limit');
  if (!dependencies?.boundary || !dependencies.codexPathOverride) throw new Error('No trusted isolated Codex runtime is configured');
  const gateway = dependencies.gateway ? WorkspaceWorkerGateway.parse(dependencies.gateway) : undefined;
  if (dependencies.boundary.kind === 'isolated-runtime') await dependencies.boundary.verify();
  else if (dependencies.boundary.kind !== 'authored-test-no-isolation') throw new Error('Unknown worker execution boundary');
  if (signal?.aborted) throw new Error('Codex worker cancelled before launch');
  if (!isAbsolute(input.workingDirectory) || await realpath(input.workingDirectory) !== input.workingDirectory) throw new Error('Worker requires a canonical absolute checkout path');
  if (!isAbsolute(dependencies.codexPathOverride) || await realpath(dependencies.codexPathOverride) !== dependencies.codexPathOverride) throw new Error('Worker executable must be a canonical trusted absolute path');
  let fixtureRoot: string | undefined;
  if (dependencies.boundary.kind === 'authored-test-no-isolation') {
    fixtureRoot = dependencies.boundary.fixtureRoot;
    if (!isAbsolute(fixtureRoot) || await realpath(fixtureRoot) !== fixtureRoot
      || relative(fixtureRoot, input.workingDirectory).startsWith('..')
      || relative(fixtureRoot, dependencies.codexPathOverride).startsWith('..')) throw new Error('Authored executable and checkout must be inside their explicit fixture root');
  }
  // Authored executables do not load Codex configuration. Their explicitly scoped
  // fixture root avoids depending on the test host's ancestor configuration.
  if (input.evaluation) {
    const observation = await verifyRuntimeCheckout(input.workingDirectory, input.evaluation.checkoutSha, input.evaluationBranch!, input.historyPolicy, fixtureRoot, input.evaluation);
    if (!observation.clean || !observation.identityValid) throw new Error('Evaluation runtime changed before worker launch');
  }
  await rejectProjectConfiguration(input.workingDirectory, fixtureRoot);
  if (!fixtureRoot) await rejectProjectConfiguration(process.cwd());
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-workspace-codex-'));
  const cancelPath = join(root, 'cancel');
  let cancellationFailure = false;
  const abort = () => {
    try { writeFileSync(cancelPath, '', { mode: 0o600 }); }
    catch { cancellationFailure = true; } // Supervisor deadline remains active.
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let evidence: ProcessEvidence | null = null;
  let value: T | undefined, usage: Usage | undefined, sessionId: string | null = null;
  let failure: unknown;
  try {
    const home = join(root, 'home'), codexHome = join(root, 'codex'), evidencePath = join(root, 'process.json');
    await mkdir(home); await mkdir(codexHome);
    const supervisor = join(root, 'bounded-codex.cjs');
    await writeFile(supervisor, supervisorSource(dependencies.codexPathOverride, evidencePath, cancelPath, limits, input.modelReasoningEffort,
      input.matchedExecution?.kind === 'authored-sdk-native-no-model'), { mode: 0o700 });
    const thread = new Codex({
      codexPathOverride: supervisor,
      env: { HOME: home, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      config: {
        model_provider: gateway ? 'flyrewheel_gateway' : 'openai',
        ...(gateway ? { model_providers: { flyrewheel_gateway: { name: 'FlyReWheel isolated gateway', base_url: gateway.baseUrl,
          wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } } } : {}),
        features: { shell_tool: !selectedOnly, unified_exec: !selectedOnly, hooks: false, shell_snapshot: false, multi_agent: false, apps: false, memories: false, goals: false, skill_mcp_dependency_install: false },
        tools: { view_image: false }, web_search: 'disabled', project_doc_max_bytes: 0, project_doc_fallback_filenames: [],
        mcp_servers: {}, shell_environment_policy: { inherit: 'none' }, history: { persistence: 'none' }, analytics: { enabled: false },
      },
    }).startThread({ model: input.model, workingDirectory: input.workingDirectory, sandboxMode: selectedOnly ? 'read-only' : 'workspace-write',
      ...(input.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: input.modelReasoningEffort }),
      approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled', additionalDirectories: [], skipGitRepoCheck: false });
    try {
      // Do not pass an SDK AbortSignal: SDK 0.159.2 removes child error
      // listeners before its asynchronous schema cleanup is finished. A caller
      // abort in that window crashes the process. Cancellation targets our
      // supervisor instead, whose raw-byte and wall-clock limits remain active.
      dependencies.observe?.({ kind: 'sdk_invocation' });
      const stream = await thread.runStreamed(input.prompt, { outputSchema });
      let response: string | undefined, completed = 0, started = 0, events = 0, eventBytes = 0;
      for await (const raw of stream.events) {
        eventBytes += Buffer.byteLength(JSON.stringify(raw));
        if (++events > 10_000 || eventBytes > limits.maxOutputBytes) throw new Error('Codex worker event stream exceeds its bounds');
        if (completed) throw new Error('Codex worker emitted an event after completion');
        if (raw.type === 'error' || raw.type === 'turn.failed') throw new Error('Codex worker reported a failed turn');
        if (['item.started', 'item.updated', 'item.completed'].includes(raw.type) && 'item' in raw
          && raw.item && ['mcp_tool_call', 'web_search', 'error'].includes(raw.item.type)) throw new Error(`Unexpected workspace tool/item: ${raw.item.type}`);
        const event = WorkerEvent.parse(raw);
        if (selectedOnly && 'item' in event && !['agent_message', 'reasoning'].includes(event.item.type)) throw new Error('Selected-evidence worker cannot use tools or change files');
        if (event.type === 'thread.started' && ++started !== 1) throw new Error('Codex worker emitted duplicate thread identity');
        if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
          if (['mcp_tool_call', 'web_search', 'error'].includes(event.item.type)) throw new Error(`Unexpected workspace tool/item: ${event.item.type}`);
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            // Match official Thread.run: completed agent messages can include
            // progress updates; the last one is the structured final response.
            response = event.item.text;
            dependencies.observe?.({ kind: 'answer', bytes: Buffer.byteLength(response, 'utf8') });
          }
        }
        if (event.type === 'turn.completed') { completed++; usage = event.usage; }
      }
      sessionId = thread.id;
      if (completed !== 1 || started !== 1 || response === undefined || !usage || !sessionId) throw new Error('Codex worker stream is missing a unique completed result, usage, or session identity');
      if (![usage.input_tokens, usage.output_tokens, usage.cached_input_tokens, usage.cache_write_input_tokens, usage.reasoning_output_tokens].every(number => Number.isSafeInteger(number) && number >= 0)) throw new Error('Invalid Codex usage');
      value = schema.parse(JSON.parse(response));
    } catch (error) { failure = error; }
    finally {
      dependencies.observe?.({ kind: 'cleanup_started' });
      // Generator cleanup has requested supervisor stop. Await an independent
      // receipt instead of treating that request as evidence of termination.
      signal?.removeEventListener('abort', abort);
      const deadline = Date.now() + limits.cleanupTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const info = await lstat(evidencePath);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Invalid process evidence');
          evidence = WorkspaceWorkerProcessEvidence.parse(JSON.parse(await readFile(evidencePath, 'utf8')));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { failure ??= error; break; }
          await delay(10);
        }
      }
    }
    if (!evidence?.processGroupStopped) throw new Error('Codex process-group stop could not be verified; retain runtime for recovery');
    if (cancellationFailure) throw new Error('Failed to deliver cancellation; process was stopped by its independent supervisor');
    if (signal?.aborted) throw new Error('Codex workspace worker cancelled');
    if (failure) throw failure;
    if (evidence.reason !== 'completed' || evidence.exitCode !== 0 || evidence.forwardedBytes > limits.maxOutputBytes) throw new Error(`Codex executable failed supervision: ${evidence.reason}`);
    if (value === undefined || !usage || !sessionId) throw new Error('Missing validated worker result');
    return { value, usage, sessionId, processEvidence: evidence, boundary: dependencies.boundary.kind };
  } catch (error) {
    const measured = WorkspaceWorkerUsage.safeParse(usage);
    throw new CodexWorkspaceWorkerError(error instanceof Error ? error.message.slice(0, 2000) : 'Codex workspace worker failed', evidence, evidence?.processGroupStopped ? null : root,
      measured.success && Object.values(measured.data).every(number => Number.isSafeInteger(number))
        && measured.data.cached_input_tokens <= measured.data.input_tokens ? measured.data : null);
  } finally {
    signal?.removeEventListener('abort', abort);
    // A process-group receipt is weaker than a container receipt. The outer runner
    // still must stop/verify the runtime before collecting artifacts and destroying it.
    if (evidence?.processGroupStopped) {
      try { await rm(root, { recursive: true, force: true }); }
      catch (error) {
        // Preserve already measured process/usage evidence if removing the
        // local runtime fails. A plain finally rejection would discard it.
        const measured = WorkspaceWorkerUsage.safeParse(usage);
        throw new CodexWorkspaceWorkerError(`Codex runtime cleanup failed: ${error instanceof Error ? error.message.slice(0, 1500) : 'Unknown cleanup error'}`,
          evidence, root, measured.success && Object.values(measured.data).every(number => Number.isSafeInteger(number))
            && measured.data.cached_input_tokens <= measured.data.input_tokens ? measured.data : null);
      }
    }
  }
}
