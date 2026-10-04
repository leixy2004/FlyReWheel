import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TrialGuard,TRIAL_WORKER_IMAGE,TRIAL_EXECD_IMAGE,observeRequest,startupCategories,errorCategory} from '../scripts/opensandbox-smoke-request.js';
function fixture(changes:object={}){
 const dir=mkdtempSync(join(tmpdir(),'trial-offline-'));const now=Date.now();
 writeFileSync(join(dir,'admission.json'),JSON.stringify({schema:1,workerImage:TRIAL_WORKER_IMAGE,execdImage:TRIAL_EXECD_IMAGE,owner:'fixture',network:'fixture-net',approvalReference:'fixture-only',startedUnixMs:now-100,deadlineUnixMs:now+60000,...changes}),{mode:0o600});
 return {dir,done:()=>rmSync(dir,{recursive:true,force:true}),guard:()=>new TrialGuard(dir,'fixture','fixture-net')};
}
it('one durable claim survives restart, including preexisting empty claims',()=>{
 const f=fixture();try{f.guard().claim();expect(()=>f.guard().claim()).toThrow();
 writeFileSync(join(f.dir,'allocation.claim'),'');expect(()=>f.guard().claim()).toThrow();}finally{f.done();}
});
it('file or directory fsync failure prevents dispatch and permanently consumes claim',()=>{
 for(const failAt of [1,2]){const f=fixture();let dispatches=0,calls=0;
 try{expect(()=>{f.guard().claim(()=>{if(++calls===failAt)throw new Error('injected');});dispatches++;}).toThrow();
 expect(dispatches).toBe(0);expect(existsSync(join(f.dir,'allocation.claim'))).toBe(true);expect(()=>f.guard().claim()).toThrow();}finally{f.done();}}
});
it('rejects expiry, future start, excess lifetime, identity mismatch and corrupt admission',()=>{
 const now=Date.now();
 for(const changes of [{deadlineUnixMs:now-1},{startedUnixMs:now+99999},{deadlineUnixMs:now+1000000},{owner:'other'},{network:'other'},{workerImage:'other'},{execdImage:'other'}]){
  const f=fixture(changes);try{expect(()=>f.guard()).toThrow();}finally{f.done();}}
 const f=fixture();try{writeFileSync(join(f.dir,'admission.json'),'{broken');expect(()=>f.guard()).toThrow();}finally{f.done();}
});
it('checks the original absolute expiry after construction',()=>{
 const f=fixture();try{const g=f.guard();expect(()=>g.remaining(g.deadline)).toThrow();}finally{f.done();}
});
it('captures before SDK delete and diagnostic failure never blocks deletion',async()=>{
 const order:string[]=[];const events:unknown[]=[];
 await observeRequest('/v1/sandboxes/fixture','DELETE',async()=>{order.push('delete');return {status:204};},()=>{order.push('capture');throw new Error('fixture-secret');},events);
 expect(order).toEqual(['capture','delete']);expect(JSON.stringify(events)).not.toContain('fixture-secret');
});
it('records bounded redacted status/errors and captures readiness failure',async()=>{
 const events:unknown[]=[];let captures=0;
 await observeRequest('/v1/sandboxes/fixture/proxy/44772/ping','GET',async()=>({status:502}),()=>{captures++;},events);
 await expect(observeRequest('/v1/sandboxes/fixture/proxy/44772/ping','GET',async()=>{throw {name:'secret',message:'secret',cause:{code:'ECONNREFUSED',secret:'secret'}};},()=>{captures++;},events)).rejects.toBeDefined();
 expect(captures).toBe(2);expect(JSON.stringify(events)).not.toContain('secret');expect(events[1]).toMatchObject({error:'connect'});
 for(let i=0;i<70;i++)await observeRequest('/secret?api-key=secret','SECRET',async()=>({status:200}),()=>{},events);
 expect(events).toHaveLength(64);expect(JSON.stringify(events)).not.toContain('secret');
 expect(errorCategory({name:'secret',code:'secret'})).toBe('other');
 expect(startupCategories('secret token=fixture\npermission denied\nexecd listening secret')).toEqual(['permission-denied','execd-start-marker']);
});
it('dispatch requires a durable successful claim and remains one-shot',()=>{
 const f=fixture();try{const g=f.guard();expect(()=>g.dispatch()).toThrow();g.claim();g.dispatch();expect(()=>g.dispatch()).toThrow();expect(()=>f.guard().dispatch()).toThrow();}finally{f.done();}
});
it('rejects symlink admission and broad file permissions',async()=>{
 const {symlinkSync,unlinkSync,chmodSync}=await import('node:fs');const f=fixture();
 try{chmodSync(join(f.dir,'admission.json'),0o644);expect(()=>f.guard()).toThrow();unlinkSync(join(f.dir,'admission.json'));
 writeFileSync(join(f.dir,'other'),'{}',{mode:0o600});symlinkSync(join(f.dir,'other'),join(f.dir,'admission.json'));expect(()=>f.guard()).toThrow();}finally{f.done();}
});
it('two competing processes can consume the persistent claim only once',async()=>{
 const {spawn}=await import('node:child_process');const f=fixture();
 const run=()=>new Promise<number|null>((resolve,reject)=>{
  const p=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
   `import {TrialGuard} from './scripts/opensandbox-smoke-request.ts';try{new TrialGuard(process.argv[1],'fixture','fixture-net').claim();}catch{process.exitCode=2;}`,f.dir],{stdio:'ignore'});
  p.once('error',reject);p.once('exit',resolve);
 });
 try{expect((await Promise.all([run(),run()])).sort()).toEqual([0,2]);}finally{f.done();}
});
