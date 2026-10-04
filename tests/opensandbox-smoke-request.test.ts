import {expect,it} from 'vitest';
import {localRequest} from '../scripts/opensandbox-smoke-request.js';
it('preserves SDK Request method, fake auth and body as a cross-fetch URL input',async()=>{
 const fixture=new Request('https://127.0.0.1:4321/v1/sandboxes',{method:'POST',headers:{'OPEN-SANDBOX-API-KEY':'fixture-not-a-key'},body:'{"timeout":300}'});
 const r=await localRequest(fixture,undefined,'https://127.0.0.1:4321');
 expect(r.url).toBe(fixture.url);expect(r.init.method).toBe('POST');expect(r.init.headers['open-sandbox-api-key']).toBe('fixture-not-a-key');
 expect(new TextDecoder().decode(r.init.body as ArrayBuffer)).toBe('{"timeout":300}');expect(r.init.redirect).toBe('error');
});
it('rejects changed origins and excess request data without dispatch',async()=>{
 await expect(localRequest('https://example.com',{},'https://127.0.0.1:4321')).rejects.toThrow();
 await expect(localRequest(new Request('https://127.0.0.1:4321/v1/sandboxes',{method:'POST',body:'x'.repeat(65537)}),{},'https://127.0.0.1:4321')).rejects.toThrow();
});

it('forwards native Request signal and explicit method/header/signal overrides',async()=>{
 const controller=new AbortController();
 const req=new Request('https://127.0.0.1:4321/v1/sandboxes',{method:'POST',headers:{'x-fixture':'original'},body:'{}',signal:controller.signal});
 const normal=await localRequest(req.clone(),undefined,'https://127.0.0.1:4321');
 expect(normal.init.signal).toBeDefined();controller.abort();expect(normal.init.signal?.aborted).toBe(true);
 const override=new AbortController();
 const replaced=await localRequest(req,{method:'PUT',headers:{'x-fixture':'replacement'},signal:override.signal,body:'fixture'},'https://127.0.0.1:4321');
 expect(replaced.init.method).toBe('PUT');expect(replaced.init.headers['x-fixture']).toBe('replacement');expect(replaced.init.body).toBe('fixture');expect(replaced.init.signal).toBe(override.signal);
});
