import { it,expect } from 'vitest';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,cpSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from '../experiments/construction/fixture.js';
import { freeze,readiness } from '../experiments/construction/contracts.js';
import { register,registryRoot,registeredInputs } from '../experiments/construction/registry.js';
import { writeReplay,verifyReplay } from '../experiments/construction/runner.js';
import { digestOf } from '../src/core/identity.js';
function setup(){
 const c=fixture();c.repository=`authored/registry-test-${randomUUID()}`;
 const f=freeze(c,'2026-10-13T00:00:01Z');
 const receipt={pr:1,packetDigest:c.roster[0].packetDigest,outcome:'completed',candidates:[]};
 const parent=mkdtempSync(join(tmpdir(),'registry-test-'));
 const cohort=join(registryRoot,digestOf({repository:c.repository}));
 return {c,f,receipt,parent,cohort,clean:()=>{rmSync(parent,{recursive:true,force:true});rmSync(cohort,{recursive:true,force:true});}};
}
it('changed output directory allows exact replay only, never replacement or omission',()=>{
 const s=setup();try{
  writeReplay(join(s.parent,'first'),s.f,[s.receipt]);
  writeReplay(join(s.parent,'same'),s.f,[s.receipt]);
  expect(verifyReplay(join(s.parent,'same')).status).toBe('verified-authored-only');
  expect(()=>writeReplay(join(s.parent,'replace'),s.f,[{...s.receipt,outcome:'interrupted'}])).toThrow(/conflict/);
  expect(()=>writeReplay(join(s.parent,'omit'),s.f,[])).toThrow(/omit/);
  expect(JSON.parse(readFileSync(join(s.parent,'replace','failure.json'),'utf8')).status).toBe('failed');
 }finally{s.clean();}
});
it('copied outputs cannot substitute another receipt even with updated local digest',()=>{
 const s=setup();try{
  const first=join(s.parent,'first'),copy=join(s.parent,'copy');writeReplay(first,s.f,[s.receipt]);cpSync(first,copy,{recursive:true});
  expect(verifyReplay(copy).status).toBe('verified-authored-only');
  const inputs=[{...s.receipt,outcome:'interrupted'}];
  writeFileSync(join(copy,'inputs.json'),JSON.stringify({frozen:s.f,inputs}));
  writeFileSync(join(copy,'reservation.json'),JSON.stringify({inputDigest:digestOf(inputs)}));
  expect(()=>verifyReplay(copy)).toThrow(/conflict/);
 }finally{s.clean();}
});
it('resumes reserved immutable receipts after interruption without new construction',()=>{
 const s=setup();try{
  register(s.f,[s.receipt]); // Simulate death after reservation before output materialization.
  const out=join(s.parent,'recovered');const saved=registeredInputs(s.c.repository);
  expect(saved.inputs).toEqual([s.receipt]);writeReplay(out,saved.frozen,saved.inputs);
  expect(JSON.parse(readFileSync(join(out,'registration.json'),'utf8')).slots[0].state).toBe('replayed');
  expect(()=>register(s.f,[{...s.receipt,outcome:'interrupted'}])).toThrow(/conflict/);
  const second={...s.receipt,pr:2,packetDigest:s.c.roster[1].packetDigest};
  expect(register(s.f,[s.receipt,second]).slots.map(s=>s.state)).toEqual(['replayed','reserved']);
 }finally{s.clean();}
});
it('invalid source-bound receipt consumes its identified slot; correction is not a retry',()=>{
 const s=setup();try{
  const bad={...s.receipt,packetDigest:'0'.repeat(64)};
  expect(()=>writeReplay(join(s.parent,'bad'),s.f,[bad])).toThrow(/binding/);
  expect(()=>writeReplay(join(s.parent,'corrected'),s.f,[s.receipt])).toThrow(/conflict/);
 }finally{s.clean();}
});
it('refreeze, partial slot corruption and slot symlinks fail closed',()=>{
 const s=setup();try{
  register(s.f,[s.receipt]);s.c.instructions+=' changed';
  expect(()=>register(freeze(s.c,'2026-10-13T00:00:02Z'),[s.receipt])).toThrow(/conflict/);
  const slot=join(s.cohort,'pr-1.json');writeFileSync(slot,'{');
  expect(()=>register(s.f,[s.receipt])).toThrow();
  rmSync(slot);const external=join(s.parent,'outside.json');writeFileSync(external,'{}');symlinkSync(external,slot);
  expect(()=>register(s.f,[s.receipt])).toThrow(/regular file/);
 }finally{s.clean();}
});
it('real-source and real repository configurations never become authored freezes',()=>{
 const c=fixture();c.repository='encode/httpx';expect(readiness(c).status).toBe('blocked');expect(()=>freeze(c,'2026-10-13T00:00:01Z')).toThrow(/namespace/);
 c.origin='development-public-source';c.constructor={kind:'model',provider:'explicit-test',model:'explicit-test',version:'test',seed:1,temperature:0,instructionsDigest:digestOf(c.instructions)};
 expect(readiness(c).blockers.join(' ')).toMatch(/no empirical freeze/);
 expect(()=>freeze(c,'2026-10-13T00:00:01Z')).toThrow();
});

it('does not steal a concurrent or interrupted cohort lock',()=>{
 const s=setup();try{
  register(s.f,[s.receipt]);mkdirSync(join(s.cohort,'.lock'));
  expect(()=>register(s.f,[s.receipt])).toThrow(/no automatic lock takeover/);
  expect(()=>registeredInputs(s.c.repository)).toThrow(/no automatic lock takeover/);
 }finally{s.clean();}
});
