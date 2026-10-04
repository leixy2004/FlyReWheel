import { describe, expect, it, vi } from 'vitest';
import { composeWorkerApplication, inspectWorkerBootstrap, startConfiguredWorkerService, WorkerBootstrapBlockedError } from '../src/worker-bootstrap.js';
import type { OpenSandboxLifecycleAuthority } from '../src/adapters/opensandbox-workspace.js';
import * as service from '../src/worker-service.js';
import type { WorkerServiceOptions } from '../src/worker-service.js';

const config = () => ({ schemaVersion: 1, enabled: true, model: 'explicit-authored-test-model',
  generationLimits: { maxInputBytes: 262144, maxOutputBytes: 131072, timeoutMs: 30000 },
  runtime: { id: 'explicit-test-runtime', backend: 'opensandbox', endpoint: 'https://sandbox.example.invalid',
    apiKeyEnv: 'TEST_SANDBOX_KEY', image: `registry.example.invalid/worker@sha256:${'a'.repeat(64)}`,
    cpu: '1000m', memory: '512Mi', maxBundleBytes: 1048576, workerExecutable: '/opt/flyrewheel/bin/workspace-worker',
    gatewayHost: 'gateway.example.invalid', limits: { maxInputBytes: 262144, maxOutputBytes: 131072,
      timeoutMs: 30000, cleanupTimeoutMs: 1000, maxArtifactBytes: 1024, maxArtifacts: 1 } } });
function dependencies() {
  // Authored code-only seams: presence is inspected but no operation may be invoked.
  const unexpected = () => { throw new Error('UNEXPECTED_RUNTIME_OPERATION'); };
  const authority: OpenSandboxLifecycleAuthority = {
    preflight: vi.fn(async () => unexpected()), stopAndVerify: vi.fn(async () => unexpected()),
    collectFrozen: vi.fn(async function* () { unexpected(); }), destroyAndVerify: vi.fn(async () => unexpected()),
  };
  return { authority, resolveWorkspace: vi.fn(async () => unexpected()),
    createSandbox: vi.fn(async () => unexpected()), transfer: vi.fn(async () => unexpected()),
    environment: { TEST_SANDBOX_KEY: 'authored-test-secret-never-printed' } };
}
describe('explicit worker bootstrap without runtime operations', () => {
  it('defaults to disabled and provides an actionable safe inspection', () => {
    const inspection = inspectWorkerBootstrap();
    expect(inspection).toMatchObject({ status: 'disabled', liveVerification: 'not_run' });
    expect(inspection.issues.map(issue => issue.code)).toEqual(['disabled', 'model_required', 'generation_limits_required',
      'runtime_required', 'lifecycle_authority_required', 'workspace_resolver_required']);
    expect(() => composeWorkerApplication({})).toThrow(WorkerBootstrapBlockedError);
  });
  it('reports each absent trusted dependency and credential, without initializing runtime work', () => {
    const result = inspectWorkerBootstrap(config(), { environment: {} });
    expect(result.issues.map(issue => issue.code)).toEqual(['lifecycle_authority_required', 'workspace_resolver_required', 'api_key_required']);
    expect(result.nextActions).toHaveLength(3);
    expect(inspectWorkerBootstrap({ enabled: true }).issues.map(issue => issue.code)).toEqual([
      'model_required', 'generation_limits_required', 'runtime_required', 'lifecycle_authority_required', 'workspace_resolver_required',
    ]);
  });
  it('composes fixed OpenSandbox dependencies and preserves exact model and limits without contacting anything', () => {
    const deps = dependencies(), raw = config(), fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('NETWORK_FORBIDDEN'); });
    try {
      expect(inspectWorkerBootstrap(raw, deps)).toMatchObject({ status: 'configured', issues: [], liveVerification: 'not_run' });
      const application = composeWorkerApplication(raw, deps);
      expect(application.runtime).toMatchObject({ id: raw.runtime.id, backend: { kind: 'isolated-runtime' }, limits: raw.runtime.limits });
      expect(application.config).toEqual({ enabled: true, model: raw.model, limits: raw.generationLimits });
      expect(application.resolveWorkspace).toBe(deps.resolveWorkspace);
      expect(JSON.stringify(application)).not.toContain(deps.environment.TEST_SANDBOX_KEY);
      expect(fetch).not.toHaveBeenCalled();
      for (const fn of [...Object.values(deps.authority), deps.resolveWorkspace, deps.createSandbox, deps.transfer]) expect(fn).not.toHaveBeenCalled();
      raw.runtime.limits.timeoutMs = 1;
      expect(application.runtime!.limits.timeoutMs).toBe(30000);
    } finally { fetch.mockRestore(); }
  });
  it.each([
    { enabled: true, apiKey: 'authored-sensitive-input' },
    { ...config(), module: 'authored-sensitive-input' },
    { ...config(), runtime: { ...config().runtime, backend: 'authored-test' } },
    { ...config(), runtime: { ...config().runtime, endpoint: 'https://user:authored-sensitive-input@example.invalid' } },
    { ...config(), runtime: { ...config().runtime, endpoint: 'authored-sensitive-input' } },
    { ...config(), runtime: { ...config().runtime, workerExecutable: '/opt/flyrewheel/../worker' } },
    { ...config(), runtime: { ...config().runtime, image: 'worker:latest' } },
  ])('rejects untrusted settings without echoing values', raw => {
    const deps = dependencies();
    expect(inspectWorkerBootstrap(raw, deps)).toMatchObject({ status: 'blocked', issues: [{ code: 'invalid_configuration' }] });
    try { composeWorkerApplication(raw, deps); throw new Error('Expected refusal'); }
    catch (error) { expect(error).toBeInstanceOf(WorkerBootstrapBlockedError); expect(JSON.stringify(error)).not.toContain('authored-sensitive-input'); }
  });
  it('requires compatible budgets and does not accept a JSON-shaped authority declaration', () => {
    const raw = config(), deps = dependencies(); raw.runtime.limits.timeoutMs++;
    expect(inspectWorkerBootstrap(raw, deps).issues.map(issue => issue.code)).toEqual(['workspace_limits_exceed_generation']);
    expect(inspectWorkerBootstrap(config(), { ...deps, authority: {} as OpenSandboxLifecycleAuthority }).issues.map(issue => issue.code))
      .toEqual(['lifecycle_authority_required']);
  });
  it('launches the existing service only after successful trusted composition', async () => {
    const marker = {} as Awaited<ReturnType<typeof service.startWorkerService>>;
    const start = vi.spyOn(service, 'startWorkerService').mockResolvedValue(marker);
    const serviceOptions = { store: {}, boss: {}, host: '127.0.0.1', port: 0 } as WorkerServiceOptions;
    try {
      expect(() => startConfiguredWorkerService(config(), { environment: {} }, serviceOptions)).toThrow(WorkerBootstrapBlockedError);
      expect(start).not.toHaveBeenCalled();
      expect(await startConfiguredWorkerService(config(), dependencies(), serviceOptions)).toBe(marker);
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0][0]).toMatchObject({ ...serviceOptions, application: {
        runtime: { backend: { kind: 'isolated-runtime' } }, config: { enabled: true, model: config().model },
      } });
    } finally { start.mockRestore(); }
  });
});
