/** Single authorized no-model trial. Secret values never enter receipts or errors. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {Sandbox} from '@alibaba-group/opensandbox';
import {Agent,fetch as scopedFetch} from 'undici';
import {localRequest} from './opensandbox-smoke-request.js';
import {BoundedOpenSandboxConnection} from '../src/adapters/opensandbox-transport.js';
const [task,owner,network,output]=process.argv.slice(2);
assert(task&&owner&&network&&output);
const info=JSON.parse(await readFile(`${task}/public.json`,'utf8'));
const apiKey=await readFile(`${task}/api-key`,'utf8');
const ca=await readFile(`${task}/tls.crt`);
const endpoint=`https://127.0.0.1:${info.port}`;
const agent=new Agent({connect:{ca,rejectUnauthorized:true}});
const receipt:any={classification:'single-no-model-lifecycle',owner,network,endpoint,allocationRequestsPrepared:0,allocationDispatches:0,events:[],status:'failed'};
const originalDispatch=agent.dispatch.bind(agent);
agent.dispatch=(options,handler)=>{
 if(options.method==='POST'&&options.path==='/v1/sandboxes'){
  receipt.allocationDispatches++;assert.equal(receipt.allocationDispatches,1,'Only one allocation dispatch allowed');
 }
 return originalDispatch(options,handler);
};
const localFetch:typeof fetch=async(input,init)=>{
 const normalized=await localRequest(input,init,endpoint);
 if(normalized.init.method==='POST'&&new URL(normalized.url).pathname==='/v1/sandboxes'){
  receipt.allocationRequestsPrepared++;assert.equal(receipt.allocationRequestsPrepared,1,'Only one prepared allocation allowed');
 }
 return await scopedFetch(normalized.url,{...normalized.init,dispatcher:agent} as any) as any;
};
const connection=new BoundedOpenSandboxConnection({endpoint,apiKey,maxResponseBytes:1024*1024,timeoutMs:20000},localFetch);
let sandbox:Sandbox|undefined;
const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
const inspect=()=>{
 const ids=docker(['ps','-aq','--filter',`label=flyrewheel.lifecycle-owner=${owner}`]).trim().split(/\s+/).filter(Boolean);
 assert.equal(ids.length,1);const obj=JSON.parse(docker(['inspect',ids[0]!]))[0];
 assert.equal(obj.Config.Labels['flyrewheel.lifecycle-owner'],owner);
 assert.deepEqual(Object.keys(obj.NetworkSettings.Networks),[network]);
 assert.equal(obj.HostConfig.NetworkMode,network);
 assert.deepEqual(obj.HostConfig.CapDrop,['ALL']);
 assert(obj.HostConfig.SecurityOpt.includes('no-new-privileges'));
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
 sandbox=await Sandbox.create({image:'sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed',
  entrypoint:['/bin/sleep','300'],resource:{cpu:'1',memory:'512Mi'},timeoutSeconds:300,
  metadata:{'flyrewheel.lifecycle-owner':owner},env:{},volumes:[],
  connectionConfig:connection,readyTimeoutSeconds:30,signal:AbortSignal.timeout(60000)});
 receipt.sandboxId=sandbox.id;
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
}catch(e){receipt.errorClass=e instanceof Error?e.name:'Unknown';receipt.status='failed';}
finally{
 if(sandbox){try{await sandbox.kill();receipt.cleanupDeleteApi=true;}catch{receipt.cleanupDeleteApi=false;}await sandbox.close().catch(()=>{});}
 await connection.closeTransport();await agent.close().catch(()=>agent.destroy());
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}
process.exitCode=receipt.status==='succeeded'?0:1;
