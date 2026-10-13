import { describe,it,expect } from 'vitest';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freeze,validateFreeze,readiness,ConfigSchema } from '../experiments/construction/contracts.js';
import { fixture } from '../experiments/construction/fixture.js';
import { replay,writeReplay,verifyReplay } from '../experiments/construction/runner.js';
const time='2026-10-13T00:00:01Z';
const candidate=(path:string)=>({path,side:'after',start:1,end:2,scope:'authored',applicability:'operation',invariant:'guard protects operation',exception:'none',requiredContext:[]});
const receipt=(c=fixture(),candidates:unknown[]=[])=>({pr:1,packetDigest:c.roster[0].packetDigest,outcome:'completed',candidates});
describe('offline construction freeze',()=>{
 it('refuses unconfigured model and all empirical freezes',()=>{
  const c=fixture();c.constructor={kind:'unconfigured',missing:['model unknown']};
  expect(readiness(c).blockers).toContain('model unknown');expect(()=>freeze(c,time)).toThrow();
  c.origin='development-public-source';expect(()=>freeze(c,time)).toThrow(/empirical freeze/);
 });
 it('binds configuration and rejects late or W1-exposed freezes',()=>{
  const c=fixture();const f=freeze(c,time);expect(validateFreeze(f)).toEqual(f);
  f.config.instructions+=' edited';expect(()=>validateFreeze(f)).toThrow(/binding/);
  c.exposure.firstRemainingSourceAt=time;expect(()=>freeze(c,time)).toThrow(/exposure/);
  c.exposure.firstRemainingSourceAt=null;c.exposure.firstW1At=time;expect(()=>freeze(c,time)).toThrow(/W1/);
 });
 it('rejects duplicate or reordered cohort and unknown fields',()=>{
  const c=fixture();c.roster.reverse();expect(()=>ConfigSchema.parse(c)).toThrow(/chronological/);
  expect(()=>ConfigSchema.parse({...fixture(),fakeFrozen:true})).toThrow();
 });
 it('retains all slots and deterministically excludes extra candidates',()=>{
  const c=fixture(),f=freeze(c,time); const r=receipt(c,[candidate('z.py'),candidate('a.py')]);
  const a=replay(f,[r]);expect(a).toEqual(replay(f,[r]));
  expect(a.rows.map(r=>r.status)).toEqual(['provisional_rule','not_run']);
  expect(a.rows[0].candidates).toMatchObject([{candidate:{path:'a.py'},disposition:'retained_pending_independent_admission'},{disposition:'cap_excluded'}]);
  expect(a.empiricalAdmission).toBe(false);
 });
 it('marks exact duplicate candidates without counting another retained rule',()=>{
  const c=fixture();const a=candidate('a.py');
  expect(replay(freeze(c,time),[receipt(c,[a,a])]).rows[0].candidates).toMatchObject([
    {disposition:'retained_pending_independent_admission'},{disposition:'duplicate_excluded'}]);
  expect(readiness(c).status).toBe('authored-config-valid-time-check-pending');
 });
 it('malformed or interrupted attempt fails without replacing candidates',()=>{
  const c=fixture(),f=freeze(c,time);
  expect(replay(f,[receipt(c,[candidate('a.py'),candidate('../invalid')])]).rows[0].status).toBe('failed');
  expect(replay(f,[{...receipt(c),outcome:'interrupted'}]).rows[0].status).toBe('failed');
 });
 it('rejects retry, skipped earlier slot, bad source binding and oversized response',()=>{
  const c=fixture(),f=freeze(c,time),r=receipt(c);
  expect(()=>replay(f,[r,r])).toThrow(/duplicate/);
  expect(()=>replay(f,[{...r,pr:2}])).toThrow(/prefix/);
  expect(()=>replay(f,[{...r,packetDigest:'0'.repeat(64)}])).toThrow(/binding/);
  c.limits.responseBytes=10;expect(()=>replay(freeze(c,time),[r])).toThrow(/budget/);
 });
 it('verifies persisted replay and rejects report alteration',()=>{
  const parent=mkdtempSync(join(tmpdir(),'construction-'));const out=join(parent,'run');
  try {writeReplay(out,freeze(fixture(),time),[]);expect(verifyReplay(out).status).toBe('verified-authored-only');
    const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));report.empiricalAdmission=true;
    writeFileSync(join(out,'report.json'),JSON.stringify(report));expect(()=>verifyReplay(out)).toThrow(/report mismatch/);
  }finally{rmSync(parent,{recursive:true,force:true});}
 });
 it('persists failure and refuses overwrite of consumed run directory',()=>{
  const parent=mkdtempSync(join(tmpdir(),'construction-'));const out=join(parent,'run');
  try {expect(()=>writeReplay(out,{},[])).toThrow();expect(JSON.parse(readFileSync(join(out,'failure.json'),'utf8')).status).toBe('failed');
   expect(()=>writeReplay(out,freeze(fixture(),time),[])).toThrow(/EEXIST/);
  }finally{rmSync(parent,{recursive:true,force:true});}
 });
});
