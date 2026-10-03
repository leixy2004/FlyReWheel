import {expect,it} from 'vitest';
import {Sandbox} from '@alibaba-group/opensandbox';
import {BoundedOpenSandboxConnection} from '../src/adapters/opensandbox-transport.js';
import {localRequest} from '../scripts/opensandbox-smoke-request.js';

function fixture(pingStatus:number){
 const origin='https://127.0.0.1:4321';
 const calls:{path:string;method:string;auth:string|undefined}[]=[];
 const fake:typeof fetch=async(input,init)=>{
  const req=await localRequest(input,init,origin);const path=new URL(req.url).pathname;
  calls.push({path,method:req.init.method,auth:req.init.headers['open-sandbox-api-key']});
  if(path==='/v1/sandboxes'&&req.init.method==='POST')return Response.json({id:'fixture',createdAt:'2026-10-03T00:00:00Z',expiresAt:null});
  if(/^\/v1\/sandboxes\/fixture\/endpoints\/(44772|18080)$/.test(path))return Response.json({endpoint:`127.0.0.1:4321/v1/sandboxes/fixture/proxy/${path.split('/').at(-1)}`});
  if(path==='/v1/sandboxes/fixture/proxy/44772/ping')return new Response(pingStatus===200?'pong':'fixture backend unavailable',{status:pingStatus});
  if(path==='/v1/sandboxes/fixture'&&req.init.method==='DELETE')return new Response(null,{status:204});
  throw new Error('unexpected fixture request');
 };
 return {calls,connection:new BoundedOpenSandboxConnection({endpoint:origin,apiKey:'fixture-only',maxResponseBytes:4096,timeoutMs:1000},fake)};
}
it('official SDK readiness preserves authenticated local proxy path through normalized Request',async()=>{
 const f=fixture(200);
 const sandbox=await Sandbox.create({connectionConfig:f.connection,image:'fixture-only',readyTimeoutSeconds:1,healthCheckPollingInterval:50});
 expect(f.calls.find(x=>x.path.endsWith('/ping'))).toEqual({path:'/v1/sandboxes/fixture/proxy/44772/ping',method:'GET',auth:'fixture-only'});
 await sandbox.kill();await sandbox.close();
 expect(f.calls.filter(x=>x.method==='POST')).toHaveLength(1);
});
it('proxy backend failure maps to SDK readiness timeout and one failure-path delete',async()=>{
 const f=fixture(502);
 await expect(Sandbox.create({connectionConfig:f.connection,image:'fixture-only',readyTimeoutSeconds:0.06,healthCheckPollingInterval:50})).rejects.toMatchObject({name:'SandboxReadyTimeoutException'});
 expect(f.calls.some(x=>x.path.endsWith('/ping'))).toBe(true);
 expect(f.calls.filter(x=>x.method==='POST')).toHaveLength(1);
 expect(f.calls.filter(x=>x.method==='DELETE')).toHaveLength(1);
});
