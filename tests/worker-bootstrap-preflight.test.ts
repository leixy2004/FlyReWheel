import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { preflightWorkerBootstrap, composeWorkerApplication } from '../src/worker-bootstrap.js';

const example = async () => JSON.parse(await readFile('examples/worker/preflight-only.json', 'utf8'));
it('constructs the built-in resolver without accessing credential values, workspaces, network or authority', async () => {
  const config = await example(), environment = new Proxy({}, { get() { throw new Error('CREDENTIAL_VALUE_READ'); } });
  const result = preflightWorkerBootstrap(config, new Set(['OPENSANDBOX_API_KEY']), { environment });
  expect(result).toMatchObject({ status: 'blocked', configuration: 'schema-valid', resolver: 'built-in-prepared-workspace-resolver',
    lifecycleAuthority: 'missing-no-built-in-production-factory', credential: { presence: 'name-present-value-unread', valueRead: false, authentication: 'not_verified' } });
  expect(result.issues.map(issue => issue.code)).toEqual(['lifecycle_authority_required']);
  const missing = preflightWorkerBootstrap(config);
  expect(missing.issues.map(issue => issue.code)).toEqual(['lifecycle_authority_required', 'api_key_required']);
  expect(preflightWorkerBootstrap(undefined).issues.map(issue => issue.code)).toContain('workspace_resolver_required');
  expect(preflightWorkerBootstrap({ ...config, module: '/tmp/forbidden.js' }).configuration).toBe('invalid');
});
it('reuses the existing resolver factory during trusted composition and rejects simultaneous resolver sources', async () => {
  const config = await example(), unexpected = vi.fn(async () => { throw new Error('UNEXPECTED_OPERATION'); });
  const authority = { preflight: unexpected, stopAndVerify: unexpected, destroyAndVerify: unexpected,
    collectFrozen: vi.fn(async function* () { throw new Error('UNEXPECTED_COLLECTION'); }) };
  // Authored test value only. This composition test performs no authentication or runtime operation.
  const app = composeWorkerApplication(config, { authority, environment: { OPENSANDBOX_API_KEY: 'authored-noncredential' } });
  expect(typeof app.resolveWorkspace).toBe('function');
  expect(app.runtime?.backend.kind).toBe('isolated-runtime');
  expect(unexpected).not.toHaveBeenCalled(); expect(authority.collectFrozen).not.toHaveBeenCalled();
  expect(preflightWorkerBootstrap(config, new Set(), { resolveWorkspace: unexpected }).issues[0].code).toBe('invalid_configuration');
});
