import { expect, it, vi } from 'vitest';
import { Sandbox } from '@alibaba-group/opensandbox';
import { boundedOpenSandboxFetch, BoundedOpenSandboxConnection } from '../src/adapters/opensandbox-transport.js';

it.each([200, 500])('caps status %s bodies before SDK parsing', async status => {
  let cancelled = false;
  const fake: typeof fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } }), { status });
  const response = await boundedOpenSandboxFetch(fake, 16, 1000)('https://example.invalid');
  await expect(response.text()).rejects.toThrow(/byte\/time bound/);
  expect(cancelled).toBe(true);
});
it('rejects oversized advertised content without reading it and never redirects', async () => {
  const fake = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('abc', { headers: { 'content-length': '100' } }));
  await expect(boundedOpenSandboxFetch(fake, 10, 1000)('https://example.invalid')).rejects.toThrow(/bounded transport failed/);
  expect(fake.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
});
it('uses the actual official SDK lifecycle/command/file adapters through the bounded transport', async () => {
  const calls: { path: string; method: string; body?: string }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const path = new URL(req.url).pathname; const method = init?.method ?? req.method;
    const body = init?.body ? String(init.body) : method === 'POST' ? await req.clone().text() : undefined;
    calls.push({ path, method, body });
    if (path === '/v1/sandboxes' && method === 'POST') return Response.json({ id: 'fake', createdAt: '2026-10-01T00:00:00Z', expiresAt: null });
    if (/^\/v1\/sandboxes\/fake\/endpoints\/(44772|18080)$/.test(path)) return Response.json({ endpoint: 'sandbox.example.invalid/proxy' });
    if (path === '/proxy/command') return new Response('data: {"type":"stdout","text":"hello"}\n\ndata: {"type":"execution_complete"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    if (path === '/proxy/files/upload') return Response.json({});
    if (path === '/v1/sandboxes/fake' && method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected authored SDK request ${method} ${path}`);
  };
  const config = new BoundedOpenSandboxConnection({ endpoint: 'https://sandbox.example.invalid', apiKey: '', maxResponseBytes: 8192, timeoutMs: 1000 }, fake);
  const sandbox = await Sandbox.create({ connectionConfig: config, image: 'authored-fixture', skipHealthCheck: true });
  const events = [];
  for await (const event of sandbox.commands.runStream(['/bin/echo', 'hello'])) events.push(event);
  expect(events.map(x => x.type)).toEqual(['stdout', 'execution_complete']);
  await sandbox.files.writeFiles([{ path: '/tmp/authored', data: 'hello', mode: 600 }]);
  await sandbox.kill(); await sandbox.close();
  expect(calls.some(x => x.path === '/proxy/files/upload')).toBe(true);
  expect(JSON.parse(calls.find(x => x.path === '/proxy/command')!.body!)).toMatchObject({ argv: ['/bin/echo', 'hello'] });
  expect(config.withTransportIfMissing()).toBe(config);
});
it('rejects SDK endpoints outside the configured origin before sending headers', async () => {
  const fake = vi.fn();
  const config = new BoundedOpenSandboxConnection({ endpoint: 'https://sandbox.example.invalid', apiKey: 'authored', maxResponseBytes: 1024, timeoutMs: 100 }, fake);
  await expect(config.fetch('https://different.example.invalid/api')).rejects.toThrow(/bounded transport failed/);
  expect(fake).not.toHaveBeenCalled();
});
it('keeps a body deadline active after headers arrive', async () => {
  const fake: typeof fetch = async (_input, init) => new Response(new ReadableStream({ start(controller) {
    init!.signal!.addEventListener('abort', () => controller.error(new Error('authored abort')), { once: true });
  } }));
  const response = await boundedOpenSandboxFetch(fake, 100, 20)('https://example.invalid');
  await expect(response.text()).rejects.toThrow(/byte\/time bound/);
});
it('propagates caller cancellation during body consumption', async () => {
  const controller = new AbortController();
  const fake: typeof fetch = async (_input, init) => new Response(new ReadableStream({ start(stream) {
    init!.signal!.addEventListener('abort', () => stream.error(new Error('authored abort')), { once: true });
  } }));
  const response = await boundedOpenSandboxFetch(fake, 100, 1000)('https://example.invalid', { signal: controller.signal });
  const rejected = expect(response.text()).rejects.toThrow(/byte\/time bound/); controller.abort(); await rejected;
});
