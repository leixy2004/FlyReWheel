import { Sandbox, type SandboxCreateOptions } from '@alibaba-group/opensandbox';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digestOf } from '../core/identity.js';
import { EvaluationWorkspaceBindingSchema, WorkspaceHistoryPolicySchema, validateHistoryBinding } from '../workspace/history-policy.js';
import { CodexWorkspaceRequestSchema } from '../workspace/codex-runner.js';
import { enforceMatchedCodexExecution } from '../workspace/matched-codex-policy.js';
import { buildWorkspaceWorkerInput } from '../workspace/worker-protocol.js';
import type { CodexWorkspaceBackend, CodexWorkspaceRequest, CodexWorkspaceRuntime, RuntimeObservation,
  CollectedArtifact, SandboxStopReceipt, SandboxDestroyReceipt, WorkspaceLimits } from '../workspace/codex-runner.js';
import type { WorkspaceRecord } from '../workspace/index.js';
import { transferSandcastleWorkspace, type SandcastleTransferTarget } from '../workspace/sandcastle-transfer.js';
import { BoundedOpenSandboxConnection } from './opensandbox-transport.js';

const ROOT = '/workspace/repo';
const INPUT = '/run/flyrewheel/request.json';
const Observation = z.object({ expectedSha: z.string().regex(/^[a-f0-9]{40}$/), headSha: z.string().regex(/^[a-f0-9]{40}$/),
  clean: z.boolean(), identityValid: z.boolean(), historyPolicy: WorkspaceHistoryPolicySchema, evaluation: EvaluationWorkspaceBindingSchema.optional() }).strict();
const Config = z.object({ endpoint: z.string().url(), apiKey: z.string(),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  cpu: z.string().regex(/^[1-9][0-9]*m?$|^0\.[0-9]+$/), memory: z.string().regex(/^[1-9][0-9]*(Mi|Gi)$/),
  maxBundleBytes: z.number().int().min(1).max(1_073_741_824),
  workerExecutable: z.string().regex(/^\/opt\/flyrewheel\/[a-zA-Z0-9/._-]+$/),
  gatewayHost: z.string().regex(/^(?!.*\.\.)(?!.*[\/:*])[a-zA-Z0-9][a-zA-Z0-9.-]*$/),
}).strict();
export type OpenSandboxWorkspaceConfig = z.infer<typeof Config>;
export interface OpenSandboxAllocation { allocationId: string; sandboxId?: string }

/** These operations need deployment-specific authority OUTSIDE the sandbox.
 * SDK pause/interrupt/kill/getInfo do NOT implement these guarantees.
 * This trusted dependency is never a job field, boolean opt-in, or user claim.
 */
export interface OpenSandboxLifecycleAuthority {
  /** Verify k3s/runtime isolation, quotas, immutable worker+control storage, a
   * secret-free authenticated gateway route, and durable allocation fencing.
   * Throw before create unless all are actually configured and checked.
   */
  preflight(config: Readonly<Omit<OpenSandboxWorkspaceConfig, 'apiKey'>>, allocation: Readonly<OpenSandboxAllocation>): Promise<void>;
  /** Fence admission for allocationId, reconcile late/unknown creates, stop all
   * workload descendants, and independently observe a frozen immutable snapshot.
   */
  stopAndVerify(allocation: Readonly<OpenSandboxAllocation>): Promise<SandboxStopReceipt>;
  /** Read frozen regular-file evidence via an OUT-OF-BAND snapshot/volume reader.
   * Reject symlinks, special files and traversal before opening; never resume execd.
   */
  collectFrozen(allocation: Readonly<OpenSandboxAllocation>, limits: Pick<WorkspaceLimits, 'maxArtifactBytes' | 'maxArtifacts'>): AsyncIterable<{
    name: string; chunks: AsyncIterable<Uint8Array>;
  }>;
  /** Independently verify physical resource removal, including orphan allocations
   * with this allocationId. API acknowledgement or an API 404 is insufficient.
   */
  destroyAndVerify(allocation: Readonly<OpenSandboxAllocation>): Promise<SandboxDestroyReceipt>;
}
export type OpenSandboxClient = Pick<Sandbox, 'id' | 'commands' | 'files' | 'kill' | 'close'>;
export interface OpenSandboxWorkspaceDependencies {
  authority?: OpenSandboxLifecycleAuthority;
  /** Test seam using official SDK shapes. Production default is Sandbox.create. */
  createSandbox?: (options: SandboxCreateOptions) => Promise<OpenSandboxClient>;
  transfer?: (workspace: Readonly<WorkspaceRecord>, target: SandcastleTransferTarget,
    options: { maxBundleBytes: number; signal: AbortSignal }) => Promise<void>;
}

export const OPENSANDBOX_PRODUCTION_BLOCKERS = [
  'authoritative allocation fencing and whole-runtime stop verification',
  'out-of-band frozen artifact collection without resuming repository processes',
  'physical resource destruction verification',
  'verified immutable worker image, isolated gateway, network/storage/resource policy',
] as const;

/** Actual official-SDK adapter. It is NEVER auto-selected by the native worker.
 * Without deployment authority, prepare fails BEFORE any allocation/transfer.
 */
export function createOpenSandboxWorkspaceBackend(raw: OpenSandboxWorkspaceConfig, dependencies: OpenSandboxWorkspaceDependencies = {}): CodexWorkspaceBackend {
  const config = Object.freeze(Config.parse(raw));
  // Validate before a lease/reservation. Do not instantiate an SDK connection yet.
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search
    || config.workerExecutable.split('/').includes('..')) throw new Error('Invalid trusted OpenSandbox endpoint/worker configuration');
  const create = dependencies.createSandbox ?? (options => Sandbox.create(options));
  const transfer = dependencies.transfer ?? transferSandcastleWorkspace;
  return { kind: 'isolated-runtime', reserve(rawRequest, workspace) {
    const request = CodexWorkspaceRequestSchema.parse(rawRequest);
    if (request.matchedExecution) enforceMatchedCodexExecution(request.matchedExecution, 'isolated-runtime');
    validateHistoryBinding(request, request.expectedSha);
    if (digestOf(request.evaluation ?? null) !== digestOf(workspace.evaluation?.binding ?? null)) throw new Error('OpenSandbox evaluation workspace binding mismatch');
    return new OpenSandboxRuntime(config, dependencies.authority, create, transfer, request, workspace);
  } };
}

class OpenSandboxRuntime implements CodexWorkspaceRuntime {
  private readonly allocation: OpenSandboxAllocation = { allocationId: randomUUID() };
  private readonly abort = new AbortController();
  private sandbox?: OpenSandboxClient;
  private clientClosed = false;
  private stopped = false;
  private destroyed = false;
  private fenced = false;
  private allocated = false;
  private prepared = false;
  private executed = false;
  private collected = false;
  private setup?: Promise<RuntimeObservation>;
  private execution?: Promise<unknown>;
  private stopOperation?: Promise<SandboxStopReceipt>;
  private destroyOperation?: Promise<SandboxDestroyReceipt>;
  constructor(private readonly config: Readonly<OpenSandboxWorkspaceConfig>, private readonly authority: OpenSandboxLifecycleAuthority | undefined,
    private readonly create: NonNullable<OpenSandboxWorkspaceDependencies['createSandbox']>,
    private readonly transfer: NonNullable<OpenSandboxWorkspaceDependencies['transfer']>,
    private readonly request: Readonly<CodexWorkspaceRequest>, private readonly workspace: Readonly<WorkspaceRecord>) {}

  prepare(signal: AbortSignal) {
    if (this.setup || this.fenced) return Promise.reject(new Error('OpenSandbox runtime preparation already started or fenced'));
    this.setup = this.withSignal(signal, () => this.prepareOwned());
    return this.setup;
  }
  private assertActive() { if (this.fenced) throw new Error('OpenSandbox allocation is fenced'); this.abort.signal.throwIfAborted(); }
  private async withSignal<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const abort = () => this.abort.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    try { this.assertActive(); return await action(); }
    finally { signal.removeEventListener('abort', abort); }
  }
  private async prepareOwned(): Promise<RuntimeObservation> {
    if (!this.authority) throw new Error(`OpenSandbox production blocked: ${OPENSANDBOX_PRODUCTION_BLOCKERS.join('; ')}`);
    const { apiKey: _secret, ...publicConfig } = this.config;
    try { await this.authority.preflight(publicConfig, Object.freeze({ ...this.allocation })); }
    catch { throw new Error('OpenSandbox production preflight failed; no sandbox was allocated'); }
    this.assertActive();
    const connection = new BoundedOpenSandboxConnection({ endpoint: this.config.endpoint, apiKey: this.config.apiKey,
      maxResponseBytes: Math.min(32 * 1024 * 1024, this.request.limits.maxOutputBytes + 65_536),
      timeoutMs: this.request.limits.timeoutMs });
    // Own the allocation token before invoking create. A rejected/aborted create
    // may still have allocated remotely; authority must reconcile this token.
    this.allocated = true;
    try {
      this.sandbox = await this.create({ connectionConfig: connection, image: this.config.image,
        metadata: { 'flyrewheel-allocation': this.allocation.allocationId },
        resource: { cpu: this.config.cpu, memory: this.config.memory },
        env: {}, volumes: [], entrypoint: ['/bin/sleep', 'infinity'],
        networkPolicy: { defaultAction: 'deny', egress: [{ action: 'allow', target: this.config.gatewayHost }] },
        timeoutSeconds: Math.ceil((this.request.limits.timeoutMs + 3 * this.request.limits.cleanupTimeoutMs) / 1000),
        readyTimeoutSeconds: Math.min(30, this.request.limits.timeoutMs / 1000), signal: this.abort.signal,
      });
      this.allocation.sandboxId = this.sandbox.id;
      if (this.fenced) this.closeClient();
      this.assertActive();
      await this.transfer(this.workspace, {
        exec: async (command, cwd) => this.command(command, cwd),
        upload: async (path, data) => { this.assertActive(); await this.sandbox!.files.writeFiles([{ path, data, mode: 600 }]); this.assertActive(); },
      }, { maxBundleBytes: this.config.maxBundleBytes, signal: this.abort.signal });
      this.assertActive();
      // The immutable image's trusted executable verifies SHA, branch identity,
      // full history, ignored/untracked/index state without reading repository config.
      const checked = await this.command([this.config.workerExecutable, 'verify', this.request.expectedSha,
        this.workspace.branch, this.request.historyPolicy, ...(this.request.evaluation ? [JSON.stringify(this.request.evaluation)] : [])], ROOT);
      if (checked.exitCode !== 0) throw new Error('OpenSandbox checkout verification failed');
      const observation = Observation.parse(JSON.parse(checked.stdout));
      if (observation.expectedSha !== this.request.expectedSha || observation.headSha !== this.request.expectedSha
        || !observation.identityValid || !observation.clean || observation.historyPolicy !== this.request.historyPolicy
        || digestOf(observation.evaluation ?? null) !== digestOf(this.request.evaluation ?? null)) throw new Error('OpenSandbox checkout verification failed');
      this.prepared = true;
      return observation;
    } catch { throw new Error('OpenSandbox preparation failed; allocation requires authoritative reconciliation'); }
  }

  execute(signal: AbortSignal) {
    if (!this.prepared || this.executed || this.fenced) return Promise.reject(new Error('OpenSandbox runtime is not prepared or is fenced'));
    this.executed = true;
    this.execution = this.withSignal(signal, async () => {
      const input = JSON.stringify(buildWorkspaceWorkerInput(this.request, ROOT, this.workspace.branch));
      await this.sandbox!.files.createDirectories([{ path: '/run/flyrewheel', mode: 700 }]);
      this.assertActive();
      await this.sandbox!.files.writeFiles([{ path: INPUT, data: input, mode: 600 }]);
      this.assertActive();
      const output = await this.command([this.config.workerExecutable, 'run', INPUT], ROOT);
      if (output.exitCode !== 0) throw new Error('OpenSandbox worker failed');
      return JSON.parse(output.stdout) as unknown;
    }).catch(() => { throw new Error('OpenSandbox worker failed or exceeded its bounds'); });
    return this.execution;
  }

  private async command(command: string | string[], cwd?: string) {
    this.assertActive();
    let stdout = '', stderr = '', bytes = 0, events = 0, complete = false, error = false;
    for await (const event of this.sandbox!.commands.runStream(command, { workingDirectory: cwd,
      timeoutSeconds: Math.ceil(this.request.limits.timeoutMs / 1000) }, this.abort.signal)) {
      this.assertActive();
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (++events > 10_000 || bytes > this.request.limits.maxOutputBytes) throw new Error('OpenSandbox command output exceeds limit');
      if (event.type === 'stdout' || event.type === 'stderr') {
        if (typeof event.text !== 'string' || complete) throw new Error('Invalid OpenSandbox output event');
        if (event.type === 'stdout') stdout += event.text; else stderr += event.text;
      } else if (event.type === 'execution_complete') {
        if (complete) throw new Error('Duplicate OpenSandbox completion'); complete = true;
      } else if (event.type === 'error') { error = true; }
      else if (!['init', 'execution_count', 'result'].includes(event.type)) throw new Error('Unexpected OpenSandbox command event');
    }
    if (!complete && !error) throw new Error('Missing OpenSandbox completion');
    return { stdout, stderr, exitCode: error ? 1 : 0 };
  }

  stop() {
    // Cache before abort listeners or authority callbacks can reenter stop().
    this.stopOperation ??= Promise.resolve().then(() => this.stopOwned());
    this.fenced = true; this.abort.abort();
    return this.stopOperation;
  }
  private async stopOwned(): Promise<SandboxStopReceipt> {
    // A late create/transfer cannot issue a worker command after this fence.
    // Do not await SDK work: an unresponsive create/command must not prevent
    // authority from fencing admission and reconciling this allocation token.
    // A verified receipt must cover late/unknown creates, not only a known ID.
    if (!this.allocated) { this.stopped = true; return { stopped: true, verified: true }; }
    if (!this.authority) return { stopped: false, verified: false };
    const receipt = await this.authority.stopAndVerify(Object.freeze({ ...this.allocation }));
    this.stopped = receipt.stopped === true && receipt.verified === true;
    return { stopped: this.stopped, verified: this.stopped };
  }
  async collect(limits: Pick<WorkspaceLimits, 'maxArtifactBytes' | 'maxArtifacts'>): Promise<CollectedArtifact[]> {
    if (!this.stopped || this.destroyed) throw new Error('Artifact collection requires a verified stopped runtime');
    if (!this.allocated) { this.collected = true; return []; }
    if (!this.authority) throw new Error('Frozen artifact collection capability unavailable');
    const artifacts: CollectedArtifact[] = []; const names = new Set<string>(); let total = 0;
    for await (const artifact of this.authority.collectFrozen(Object.freeze({ ...this.allocation }), limits)) {
      if (artifacts.length >= limits.maxArtifacts || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(artifact.name)
        || names.has(artifact.name)) throw new Error('Invalid or excessive frozen artifacts');
      names.add(artifact.name); const chunks: Uint8Array[] = [];
      for await (const bytes of artifact.chunks) {
        if (!(bytes instanceof Uint8Array)) throw new Error('Invalid frozen artifact chunk');
        total += bytes.byteLength;
        if (total > limits.maxArtifactBytes) throw new Error('Frozen artifact byte limit exceeded');
        chunks.push(Uint8Array.from(bytes));
      }
      artifacts.push({ name: artifact.name, bytes: Buffer.concat(chunks) });
    }
    this.collected = true;
    return artifacts;
  }
  destroy() {
    if (!this.stopped || !this.collected) return Promise.reject(new Error('Destruction requires authoritative stop and successful collection'));
    this.destroyOperation ??= Promise.resolve().then(() => this.destroyOwned());
    return this.destroyOperation;
  }
  private async destroyOwned(): Promise<SandboxDestroyReceipt> {
    if (!this.allocated) { this.destroyed = true; return { destroyed: true, verified: true }; }
    // The authority owns deletion and its independent verification, including
    // unknown/late allocations. An SDK delete acknowledgement is not evidence
    // and awaiting a stuck SDK request here would block authoritative recovery.
    const receipt = await this.authority!.destroyAndVerify(Object.freeze({ ...this.allocation }));
    this.destroyed = receipt.destroyed === true && receipt.verified === true;
    if (this.destroyed) this.closeClient();
    return { destroyed: this.destroyed, verified: this.destroyed };
  }
  private closeClient() {
    // Transport disposal is best effort, never proof of resource destruction.
    // It must not delay a verified authority receipt or throw an unhandled error.
    if (!this.sandbox || this.clientClosed) return;
    this.clientClosed = true;
    try { void this.sandbox.close().catch(() => undefined); } catch { /* local transport disposal only */ }
  }
}
