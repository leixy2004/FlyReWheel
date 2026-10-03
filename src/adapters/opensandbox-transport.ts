import { ConnectionConfig } from '@alibaba-group/opensandbox';

/** Wrap transport, not the OpenSandbox protocol. Official adapters still own all requests.
 * Caps successful/error/SSE bodies BEFORE the SDK's JSON/SSE/string buffering.
 * A time bound covers the body, unlike the SDK's header-only HTTP timeout.
 */
export function boundedOpenSandboxFetch(base: typeof fetch, maxBytes: number, timeoutMs: number): typeof fetch {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 330_000) throw new Error('Invalid OpenSandbox transport bounds');
  return async (input, init) => {
    const controller = new AbortController();
    const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const abort = () => controller.abort();
    upstream?.addEventListener('abort', abort, { once: true });
    if (upstream?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    const finish = () => { clearTimeout(timer); upstream?.removeEventListener('abort', abort); };
    try {
      const response = await base(input, { ...init, signal: controller.signal, redirect: 'error' });
      const advertised = response.headers.get('content-length');
      if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) {
        controller.abort(); await response.body?.cancel(); throw new Error('OpenSandbox response exceeds byte limit');
      }
      if (!response.body) { finish(); return response; }
      const reader = response.body.getReader();
      let total = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            controller.signal.throwIfAborted();
            const next = await reader.read();
            controller.signal.throwIfAborted();
            if (next.done) { finish(); reader.releaseLock(); target.close(); return; }
            total += next.value.byteLength;
            if (total > maxBytes) throw new Error('OpenSandbox response exceeds byte limit');
            target.enqueue(next.value);
          } catch {
            controller.abort(); finish(); await reader.cancel().catch(() => {});
            target.error(new Error('OpenSandbox response exceeded its byte/time bound or was cancelled'));
          }
        },
        async cancel() { controller.abort(); finish(); await reader.cancel().catch(() => {}); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch { finish(); controller.abort(); throw new Error('OpenSandbox bounded transport failed'); }
  };
}

/** Public ConnectionConfig extension points; no private fields or handwritten API calls.
 * Explicit empty apiKey prevents the official SDK from selecting ambient credentials.
 * No SDK telemetry/client-IP probes: we supply the complete transport implementation.
 */
export class BoundedOpenSandboxConnection extends ConnectionConfig {
  private readonly bounded: typeof fetch;
  constructor(options: { endpoint: string; apiKey: string; maxResponseBytes: number; timeoutMs: number }, baseFetch: typeof fetch = fetch) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('An explicit HTTPS OpenSandbox endpoint without embedded credentials is required');
    }
    super({ domain: options.endpoint, apiKey: options.apiKey, useServerProxy: true, disableMetrics: true,
      enableTracing: false, debug: false, requestTimeoutSeconds: options.timeoutMs / 1000 });
    const sameOrigin: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== endpoint.origin || url.username || url.password
        || !url.pathname.startsWith(endpoint.pathname.replace(/\/$/, '') + '/')) {
        throw new Error('OpenSandbox endpoint escaped its configured control-plane origin');
      }
      return baseFetch(input, init);
    };
    this.bounded = boundedOpenSandboxFetch(sameOrigin, options.maxResponseBytes, options.timeoutMs);
  }
  override get fetch() { return this.bounded; }
  override get sseFetch() { return this.bounded; }
  override withTransportIfMissing() { return this; }
  override async closeTransport() { /* fetch has no adapter-owned connection pool */ }
}
