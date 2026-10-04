/** Single authorized no-model trial. Secret values never enter receipts or errors. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {Sandbox} from '@alibaba-group/opensandbox';
import {Agent,fetch as scopedFetch} from 'undici';
import {localRequest,TrialGuard,TRIAL_WORKER_IMAGE,observeRequest,startupCategories,noNewPrivilegesEnabled} from './opensandbox-smoke-request.js';
import {BoundedOpenSandboxConnection} from '../src/adapters/opensandbox-transport.js';
const [task,owner,network,output,state]=process.argv.slice(2);
assert(task&&owner&&network&&output&&state);
const guard=new TrialGuard(state,owner,network);
const info=JSON.parse(await readFile(`${task}/public.json`,'utf8'));
assert.equal(info.operatorApprovalReference,guard.approvalReference,'trial approval mismatch');
const apiKey=await readFile(`${task}/api-key`,'utf8');
const ca=await readFile(`${task}/tls.crt`);
const endpoint=`https://127.0.0.1:${info.port}`;
const agent=new Agent({connect:{ca,rejectUnauthorized:true}});
const receipt:any={classification:'single-no-model-lifecycle',owner,network,endpoint,allocationRequestsPrepared:0,allocationDispatches:0,events:[],requests:[],status:'failed'};
const originalDispatch=agent.dispatch.bind(agent);
agent.dispatch=(options,handler)=>{
 guard.remaining();
 if(options.method.toUpperCase()==='POST'&&new URL(options.path,endpoint).pathname==='/v1/sandboxes'){
  guard.dispatch();receipt.allocationDispatches++;assert.equal(receipt.allocationDispatches,1,'Only one allocation dispatch allowed');
 }
 return originalDispatch(options,handler);
};
const localFetch:typeof fetch=async(input,init)=>{
 const normalized=await localRequest(input,init,endpoint);
 if(normalized.init.method==='POST'&&new URL(normalized.url).pathname==='/v1/sandboxes'){
  guard.claim();receipt.allocationRequestsPrepared++;assert.equal(receipt.allocationRequestsPrepared,1,'Only one prepared allocation allowed');
 }
 const deadlineSignal=AbortSignal.timeout(Math.min(guard.remaining(),20000));
 const signal=normalized.init.signal?AbortSignal.any([normalized.init.signal,deadlineSignal]):deadlineSignal;
 return await observeRequest(new URL(normalized.url).pathname,normalized.init.method,
  async()=>await scopedFetch(normalized.url,{...normalized.init,signal,dispatcher:agent} as any) as any,
  captureDiagnostics,receipt.requests) as any;
};
const connection=new BoundedOpenSandboxConnection({endpoint,apiKey,maxResponseBytes:1024*1024,timeoutMs:20000},localFetch);
let sandbox:Sandbox|undefined;
const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
let captured=false;
function captureDiagnostics(){
 if(captured)return;captured=true;
 const safeDocker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:1500,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
 try{
  const ids=safeDocker(['ps','-aq','--filter',`label=flyrewheel.lifecycle-owner=${owner}`]).trim().split(/\s+/).filter(Boolean);
  if(ids.length!==1){receipt.diagnostics={status:'owned-container-unavailable',count:Math.min(ids.length,2)};return;}
  const obj=JSON.parse(safeDocker(['inspect',ids[0]!]))[0];
  assert.equal(obj.Config.Labels['flyrewheel.lifecycle-owner'],owner);
  assert(/^[a-f0-9]{64}$/.test(obj.Id)&&/^sha256:[a-f0-9]{64}$/.test(obj.Image));
  const attached=obj.NetworkSettings.Networks??{};
  const statuses=['created','running','paused','restarting','removing','exited','dead'];
  receipt.diagnostics={status:'captured',containerId:obj.Id,imageId:obj.Image,ownerMatched:true,
   networkMatched:Object.keys(attached).length===1&&Boolean(attached[network]),
   running:obj.State.Running===true,paused:obj.State.Paused===true,oomKilled:obj.State.OOMKilled===true,
   state:statuses.includes(obj.State.Status)?obj.State.Status:'unknown',exitCode:Number.isInteger(obj.State.ExitCode)?obj.State.ExitCode:null,
   publishedPortsPresent:Object.values(obj.NetworkSettings.Ports??{}).some(v=>Array.isArray(v)&&v.length>0)};
  try{const processes=safeDocker(['top',obj.Id,'-eo','comm']);
   receipt.diagnostics.execdProcessObserved=processes.split(/\r?\n/).some(line=>line.trim()==='execd');}
  catch{receipt.diagnostics.execdProcessObserved='unknown';}
  try{const logs=spawnSync('docker',['logs','--tail','100',obj.Id],{encoding:'utf8',timeout:1500,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
   if(logs.error||logs.status!==0)throw new Error('log capture failed');
   receipt.diagnostics.startupCategories=startupCategories(logs.stdout+'\n'+logs.stderr);}
  catch{receipt.diagnostics.startupCategories=['log-read-failed'];}
 }catch{receipt.diagnostics={status:'capture-failed'};}
}
const inspect=()=>{
 const ids=docker(['ps','-aq','--filter',`label=flyrewheel.lifecycle-owner=${owner}`]).trim().split(/\s+/).filter(Boolean);
 assert.equal(ids.length,1);const obj=JSON.parse(docker(['inspect',ids[0]!]))[0];
 assert.equal(obj.Config.Labels['flyrewheel.lifecycle-owner'],owner);
 assert.deepEqual(Object.keys(obj.NetworkSettings.Networks),[network]);
 assert.equal(obj.HostConfig.NetworkMode,network);
 assert.deepEqual(obj.HostConfig.CapDrop,['ALL']);
 receipt.inspectionCheck='no-new-privileges';
 assert(noNewPrivilegesEnabled(obj.HostConfig.SecurityOpt));
 receipt.inspectionCheck='remaining-container-policy';
 assert(!obj.HostConfig.Privileged);assert.equal(obj.Mounts.length,0);
 for(const bindings of Object.values(obj.HostConfig.PortBindings??{}) as any[])for(const b of bindings)assert.equal(b.HostIp,'127.0.0.1');
 assert(!JSON.stringify(obj.Config.Env).includes(apiKey));
 return obj;
};
try{
 let healthy=false;
 for(let i=0;i<40;i++){
  try{const r=await localFetch(`${endpoint}/health`,{signal:AbortSignal.timeout(1000)});healthy=r.ok&&(await r.json() as any).status==='healthy';if(healthy)break;}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 assert(healthy,'health deadline');receipt.events.push('verified-TLS-health');
 const unauth=await localFetch(`${endpoint}/v1/sandboxes`,{signal:AbortSignal.timeout(5000)});
 receipt.unauthenticatedStatus=unauth.status;assert([401,403].includes(unauth.status));await unauth.body?.cancel();
 sandbox=await Sandbox.create({image:TRIAL_WORKER_IMAGE,
  entrypoint:['/bin/sleep','300'],resource:{cpu:'1',memory:'512Mi'},timeoutSeconds:300,
  metadata:{'flyrewheel.lifecycle-owner':owner},env:{},volumes:[],
  connectionConfig:connection,readyTimeoutSeconds:30,signal:AbortSignal.timeout(60000)});
 receipt.sandboxId=sandbox.id;receipt.events.push('sdk-ready');
 receipt.inspectionCheck='container-identity-network-capabilities';
 const before=inspect();receipt.containerId=before.Id;receipt.before={status:before.State.Status,paused:before.State.Paused,network:before.HostConfig.NetworkMode};
 assert(before.State.Running);receipt.events.push('reserved-and-ready');
 const result=await sandbox.commands.run(['/usr/bin/id','-u'],{timeoutSeconds:10,workingDirectory:'/tmp'},undefined,AbortSignal.timeout(15000));
 assert(result.id);assert(result.complete&&!result.error);
 const stdout=result.logs.stdout.map(x=>x.text).join('');assert.equal(stdout.trim(),'10001');
 const status=await sandbox.commands.getCommandStatus(result.id);
 assert.equal(status.running,false);assert.equal(status.exitCode,0);
 receipt.command={argv:['/usr/bin/id','-u'],stdout:stdout.trim(),exitCode:status.exitCode,running:status.running};
 await sandbox.pause();assert.equal(inspect().State.Paused,true);receipt.events.push('paused-independently-inspected');
 await sandbox.kill();receipt.events.push('delete-api-succeeded');sandbox=undefined;
 assert.equal(docker(['ps','-aq','--filter',`label=flyrewheel.lifecycle-owner=${owner}`]).trim(),'');
 receipt.events.push('container-absence-independently-inspected');receipt.status='succeeded';
}catch(e){receipt.errorClass=e instanceof Error&&['Error','AssertionError','SandboxReadyTimeoutException','SandboxApiException','TimeoutError','AbortError'].includes(e.name)?e.name:'Unknown';receipt.status='failed';}
finally{
 if(sandbox){try{await sandbox.kill();receipt.cleanupDeleteApi=true;}catch{receipt.cleanupDeleteApi=false;}await sandbox.close().catch(()=>{});}
 try{await connection.closeTransport();}catch{receipt.transportCleanup=false;}
 await agent.destroy().catch(()=>{receipt.transportCleanup=false;});
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}
process.exitCode=receipt.status==='succeeded'?0:1;
