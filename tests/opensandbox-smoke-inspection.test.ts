import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {inspectOwnedContainer,cleanupTrial,type Check} from '../scripts/opensandbox-smoke-inspection.js';
const owner='fixture-owner',network='fixture-network',key='fixture-secret-value';
// Synthetic HostConfig: historical evidence did not retain the real HostConfig.
const fixture=()=>({Config:{Labels:{'flyrewheel.lifecycle-owner':owner},Env:['PATH=/usr/bin']},
 NetworkSettings:{Networks:{[network]:{}}},HostConfig:{NetworkMode:network,CapDrop:['ALL'],SecurityOpt:['no-new-privileges=true'],Privileged:false,PortBindings:{}},
 Mounts:[],State:{Running:true,Paused:false}});
function inspect(obj:any,checks:Check[]=[],phase:'ready'|'paused'='ready'){
 return inspectOwnedContainer(()=>['fixture-id'],()=>[obj],owner,network,key,phase,c=>checks.push(c));
}
it('records bounded named expected/actual results, preserving the failing check before throw',()=>{
 const obj=fixture();obj.HostConfig.SecurityOpt=['no-new-privileges=false',key];const checks:Check[]=[];
 expect(()=>inspect(obj,checks)).toThrow('inspection:no-new-privileges');
 expect(checks.at(-1)).toEqual({phase:'ready',name:'no-new-privileges',expected:'enabled-without-conflict',actual:{shape:'array',count:1,forms:['disabled']},passed:false});
 expect(JSON.stringify(checks)).not.toContain(key);
 expect(checks.slice(0,-1).every(x=>x.passed)).toBe(true);
});
it('accepts equivalent enabled Docker forms and empty bindings representations',()=>{
 for(const opt of ['no-new-privileges','no-new-privileges=true'])for(const ports of [{},null,{'44772/tcp':null},{'44772/tcp':[{HostIp:'127.0.0.1',HostPort:'12345'}]}]){
  const obj:any=fixture();obj.HostConfig.SecurityOpt=[opt];obj.HostConfig.PortBindings=ports;
  const checks:Check[]=[];inspect(obj,checks);expect(checks).toHaveLength(14);expect(checks.every(x=>x.passed)).toBe(true);
 }
});
it('rejects absent, disabled, malformed and conflicting security forms',()=>{
 for(const opts of [undefined,null,[],['no-new-privileges=false'],['no-new-privileges=1'],['no-new-privileges=true','no-new-privileges=false']]){
  const obj:any=fixture();obj.HostConfig.SecurityOpt=opts;expect(()=>inspect(obj)).toThrow('inspection:no-new-privileges');
 }
});
it('missing policy/state fields fail their named check without a TypeError',()=>{
 for(const [path,name] of [['Config.Labels','owner-match'],['NetworkSettings.Networks','network-set'],['HostConfig.NetworkMode','network-mode'],['HostConfig.CapDrop','cap-drop'],['HostConfig.Privileged','privileged'],['Mounts','mount-count'],['HostConfig.PortBindings','port-bindings'],['Config.Env','env-shape'],['State.Running','running'],['State.Paused','paused']]){
  const obj:any=fixture();const parts=path!.split('.');const field=parts.pop()!;delete parts.reduce((v,k)=>v[k],obj)[field];
  const checks:Check[]=[];expect(()=>inspect(obj,checks)).toThrow(`inspection:${name}`);expect(checks.at(-1)?.passed).toBe(false);
 }
});
it('rejects restriction violations without retaining arbitrary Docker strings',()=>{
 for(const mutate of [
  (o:any)=>{o.Config.Labels['flyrewheel.lifecycle-owner']=key;},
  (o:any)=>{o.NetworkSettings.Networks[key]={};},
  (o:any)=>{o.HostConfig.CapDrop=[key];},
  (o:any)=>{o.HostConfig.Privileged=true;},
  (o:any)=>{o.Mounts=[{Source:key}];},
  (o:any)=>{o.HostConfig.PortBindings={secret:[{HostIp:key}]};},
  (o:any)=>{o.Config.Env=[`TOKEN=${key}`];},
 ]){const obj=fixture();mutate(obj);const checks:Check[]=[];expect(()=>inspect(obj,checks)).toThrow();expect(JSON.stringify(checks)).not.toContain(key);}
});
it('requires observed paused state; ready evidence cannot satisfy pause',()=>{
 expect(()=>inspect(fixture(),[],'paused')).toThrow('inspection:paused');const obj=fixture();obj.State.Paused=true;inspect(obj,[],'paused');
});
it('historical recorded shape is partial evidence, never a fabricated policy pass',()=>{
 const receipt=JSON.parse(readFileSync(new URL('../docs/evidence/opensandbox-retry-2026-10-04/lifecycle.json',import.meta.url),'utf8'));
 expect(receipt.errorClass).toBe('AssertionError');expect(receipt.diagnostics.ownerMatched).toBe(true);
 expect(receipt.diagnostics.running).toBe(true);expect(receipt.diagnostics.paused).toBe(false);
 expect(receipt.diagnostics).not.toHaveProperty('HostConfig');
 const checks:Check[]=[];expect(()=>inspect(receipt.diagnostics,checks)).toThrow('inspection:owner-match');
 // The true historical inspect object was not retained; this proves no upgrade from its projection.
 expect(checks.at(-1)?.passed).toBe(false);
});
it('records acquisition errors and malformed inspect before throwing, without raw errors',()=>{
 for(const kind of ['list','read','shape']){
  const checks:Check[]=[];
  expect(()=>inspectOwnedContainer(()=>{if(kind==='list')throw Error(key);return ['id'];},()=>{if(kind==='read')throw Error(key);return {};},owner,network,key,'ready',c=>checks.push(c))).toThrow();
  expect(checks.at(-1)?.name).toBe(kind==='list'?'docker-list':kind==='read'?'docker-inspect':'inspect-shape');
  expect(checks.at(-1)?.passed).toBe(false);expect(JSON.stringify(checks)).not.toContain(key);
 }
});
it('cleanup failure preserves inspection evidence, continues every action and fails success',async()=>{
 const checks:Check[]=[];const obj=fixture();obj.HostConfig.Privileged=true;expect(()=>inspect(obj,checks)).toThrow();
 const receipt:any={status:'succeeded',inspectionChecks:checks};const before=JSON.stringify(checks);const calls:string[]=[];
 await cleanupTrial(receipt,[{name:'cleanupDeleteApi',run:async()=>{calls.push('delete');throw Error(key);}},{name:'transportClosed',run:async()=>{calls.push('transport');}}],()=>{calls.push('persist');});
 expect(calls).toEqual(['delete','persist','transport','persist']);expect(receipt.status).toBe('failed');expect(receipt.cleanupDeleteApi).toBe(false);
 expect(JSON.stringify(receipt.inspectionChecks)).toBe(before);expect(JSON.stringify(receipt)).not.toContain(key);
});
it('receipt write failure cannot skip later cleanup actions',async()=>{
 const receipt:any={status:'succeeded'};const calls:string[]=[];
 await expect(cleanupTrial(receipt,[{name:'cleanupDeleteApi',run:async()=>{calls.push('delete');}},{name:'agentClosed',run:async()=>{calls.push('agent');}}],()=>{throw Error(key);})).rejects.toThrow('cleanup receipt persistence failed');
 expect(calls).toEqual(['delete','agent']);expect(receipt.status).toBe('failed');expect(receipt.agentClosed).toBe(true);
});
