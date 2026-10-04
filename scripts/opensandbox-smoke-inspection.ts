/** Trial-only diagnostics: never serialize Docker objects or exception messages. */
import assert from 'node:assert/strict';
import {noNewPrivilegesEnabled} from './opensandbox-smoke-request.js';
export function listOwnedContainers(docker:(args:string[])=>string,owner:string):string[]{
 return docker(['ps','-aq','--no-trunc','--filter',`label=flyrewheel.lifecycle-owner=${owner}`]).trim().split(/\s+/).filter(Boolean);
}
export type Check = {phase:string;name:string;expected:unknown;actual:unknown;passed:boolean};
export type Journal = (check:Check)=>void;
const object=(x:any)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const shape=(x:any)=>x===undefined?'missing':x===null?'null':Array.isArray(x)?'array':typeof x;
const count=(x:any[])=>Math.min(x.length,1025);
export function check(journal:Journal,phase:string,name:string,expected:unknown,actual:unknown,passed:boolean){
 journal({phase,name,expected,actual,passed}); // Persist before throwing, including failures.
 assert(passed,`inspection:${name}`);
}
export function inspectOwnedContainer(list:()=>string[],read:(id:string)=>unknown,
 owner:string,network:string,apiKey:string,phase:'ready'|'paused',journal:Journal):any {
 const c=(name:string,expected:unknown,actual:unknown,ok:boolean)=>check(journal,phase,name,expected,actual,ok);
 let ids:string[]=[];
 try{ids=list();}catch{c('docker-list','success','error',false);}
 c('owned-count',1,count(ids),ids.length===1);
 let objects:any;
 try{objects=read(ids[0]!);}catch{c('docker-inspect','parseable-response','error',false);}
 c('inspect-shape','one-object',Array.isArray(objects)?count(objects):shape(objects),Array.isArray(objects)&&objects.length===1&&object(objects[0]));
 const obj=objects[0];
 const idValid=typeof obj.Id==='string'&&/^[a-f0-9]{64}$/.test(obj.Id)&&obj.Id===ids[0];
 c('container-id','exact-listed-64hex-id',idValid?'match':'invalid-or-mismatch',idValid);
 c('owner-match',true,obj.Config?.Labels?.['flyrewheel.lifecycle-owner']===owner,obj.Config?.Labels?.['flyrewheel.lifecycle-owner']===owner);
 const nets=obj.NetworkSettings?.Networks;
 c('network-set','sole-owned-network',object(nets)?{count:count(Object.keys(nets)),owned:Object.hasOwn(nets,network)}:shape(nets),object(nets)&&Object.keys(nets).length===1&&Object.hasOwn(nets,network));
 c('network-mode','owned-network',obj.HostConfig?.NetworkMode===network?'match':shape(obj.HostConfig?.NetworkMode),obj.HostConfig?.NetworkMode===network);
 const caps=obj.HostConfig?.CapDrop;
 c('cap-drop','ALL-only',Array.isArray(caps)?{count:count(caps),all:caps.includes('ALL')}:shape(caps),Array.isArray(caps)&&caps.length===1&&caps[0]==='ALL');
 const opts=obj.HostConfig?.SecurityOpt;
 const flags=Array.isArray(opts)?opts.filter((x:any)=>typeof x==='string'&&x.startsWith('no-new-privileges')):[];
 const forms=flags.slice(0,8).map((x:string)=>x==='no-new-privileges'?'bare-enabled':x==='no-new-privileges=true'?'explicit-enabled':x==='no-new-privileges=false'?'disabled':'invalid');
 c('no-new-privileges','enabled-without-conflict',{shape:shape(opts),count:count(flags),forms},noNewPrivilegesEnabled(opts));
 c('privileged',false,typeof obj.HostConfig?.Privileged==='boolean'?obj.HostConfig.Privileged:shape(obj.HostConfig?.Privileged),obj.HostConfig?.Privileged===false);
 c('mount-count',0,Array.isArray(obj.Mounts)?count(obj.Mounts):shape(obj.Mounts),Array.isArray(obj.Mounts)&&obj.Mounts.length===0);
 const ports=obj.HostConfig?.PortBindings;
 // Docker represents no bindings as null or {}. Missing is not evidence.
 const validPorts=ports===null||(object(ports)&&Object.values(ports).every((v:any)=>v===null||(Array.isArray(v)&&v.every((b:any)=>object(b)&&b.HostIp==='127.0.0.1'))));
 c('port-bindings','none-or-loopback-only',{shape:shape(ports),loopbackOrNone:validPorts},validPorts);
 const env=obj.Config?.Env;
 const envValid=Array.isArray(env)&&env.every((x:any)=>typeof x==='string');
 c('env-shape','string-array',shape(env),envValid);
 const leaked=envValid&&env.some((x:string)=>x.includes(apiKey));
 c('api-key-absent',true,!leaked,!leaked);
 const statuses=['created','running','paused','restarting','removing','exited','dead'];
 const statusValid=typeof obj.State?.Status==='string'&&statuses.includes(obj.State.Status);
 c('state-status','known-docker-state',statusValid?obj.State.Status:'invalid',statusValid);
 c('running',true,typeof obj.State?.Running==='boolean'?obj.State.Running:shape(obj.State?.Running),obj.State?.Running===true);
 c('paused',phase==='paused',typeof obj.State?.Paused==='boolean'?obj.State.Paused:shape(obj.State?.Paused),obj.State?.Paused===(phase==='paused'));
 return obj;
}
export async function cleanupTrial(receipt:any,actions:{name:'cleanupDeleteApi'|'sandboxClosed'|'transportClosed'|'agentClosed';run:()=>Promise<unknown>}[],persist:()=>void){
 let persistenceFailed=false;
 for(const action of actions){
  try{await action.run();receipt[action.name]=true;}catch{receipt[action.name]=false;receipt.status='failed';}
  try{persist();}catch{persistenceFailed=true;receipt.status='failed';}
 }
 if(persistenceFailed)throw new Error('cleanup receipt persistence failed');
}
