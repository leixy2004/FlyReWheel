import { screenedFamilies, constructedFamilies } from '../experiments/construction/family-provenance.js';
import { selectIndices } from '../experiments/construction/episode-selection.js';
import { episodeRegistryRoot } from '../experiments/construction/episode-registry.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digestOf } from '../src/core/identity.js';
import { fixture } from '../experiments/construction/fixture.js';
import { freeze } from '../experiments/construction/contracts.js';
import { replay } from '../experiments/construction/runner.js';
import { register, registryRoot } from '../experiments/construction/registry.js';
import { lockScreening, finalizeScreening, recoverScreening, screeningRegistryRoot } from '../experiments/construction/screening.js';
const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
// No real study files, roster, W1 metadata or source content are loaded.
function setup(incomplete=false){
  const config=fixture();config.repository=`authored/screening-${randomUUID()}`;
  config.roster=[1,2,3,4].map(pr=>({pr,mergedAt:`2024-01-0${pr}T00:00:00Z`,packetDigest:digestOf(`authored-packet-${pr}`),priorRejected:pr===4,missingEvidence:[]}));
  const first={path:'a.ts',side:'after',start:1,end:1,scope:'authored',applicability:'authored operation',invariant:'authored invariant',exception:'none',requiredContext:[]};
  const second={...first,path:'z.ts',invariant:'different authored invariant'};
  const inputs=config.roster.slice(0,incomplete?1:3).map((r,i)=>({pr:r.pr,packetDigest:r.packetDigest,outcome:i===2?'interrupted':'completed',candidates:i===0?[second,first]:[]}));
  const frozen=freeze(config,'2026-10-13T00:00:01Z');register(frozen,inputs);
  const report=replay(frozen,inputs),repository=config.repository,dir=join(screeningRegistryRoot,digestOf({repository}));
  roots.push(dir,join(registryRoot,digestOf({repository})));
  const plan={kind:'authored-construction-screening-plan',origin:'authored-fixture',repository,
    construction:{freezeDigest:frozen.digest,reportDigest:digestOf(report)},assessors:['authored-A','authored-B']};
  const lockedAt='2026-10-13T00:00:02Z';
  const lock=()=>lockScreening(plan,lockedAt);
  const assessments=(selection:ReturnType<typeof lock>,verdict:'accept'|'reject'|'unknown'='accept')=>plan.assessors.map(assessorId=>({
    origin:'authored-fixture',lockDigest:selection.digest,pr:1,candidateDigest:digestOf(first),assessorId,verdict,
    atomicity:verdict==='reject'?'compound':verdict==='unknown'?'unknown':'single',scope:verdict==='unknown'?'unknown':'supported',
    sourceSupport:verdict==='unknown'?'unknown':'supported',rationale:'Synthetic screening result, not a human assessment',evidenceDigest:digestOf('authored screening evidence'),
  }));
  return {repository,dir,first,second,plan,lockedAt,lock,assessments};
}
it('locks the canonical retained candidate and all failure/no-rule/rejection rows before assessments',()=>{
  const f=setup(),selection=f.lock();
  expect(selection.choices.map(c=>c.constructionStatus)).toEqual(['provisional_rule','no_rule','failed','prior_rejected']);
  expect(selection.choices[0]).toMatchObject({candidateDigest:digestOf(f.first),excludedCandidateDigests:[digestOf(f.second)]});
  expect(recoverScreening(f.repository)).toMatchObject({status:'awaiting-assessments',report:null});
  expect(f.lock()).toEqual(selection);
  expect(()=>lockScreening({...f.plan,assessors:['other-A','other-B']},f.lockedAt)).toThrow('no replacement');
  const report=finalizeScreening(f.repository,f.assessments(selection));
  expect(report.rows[0].status).toBe('accepted-authored-only');
  expect(report).toMatchObject({empiricalAdmission:false,independentLabels:0,assessorIdentityVerified:false,modelCalls:0});
});
it('compound-rule rejection never substitutes the cap-excluded candidate or rewrites final results',()=>{
  const f=setup(),selection=f.lock(),results=f.assessments(selection,'reject');
  const report=finalizeScreening(f.repository,results);
  expect(report.rows[0]).toMatchObject({status:'rejected',candidateDigest:digestOf(f.first),excludedCandidateDigests:[digestOf(f.second)]});
  expect(report.replacementAllowed).toBe(false);
  expect(()=>finalizeScreening(f.repository,f.assessments(selection).map(r=>({...r,candidateDigest:digestOf(f.second)})))).toThrow('no replacement');
  expect(()=>finalizeScreening(f.repository,f.assessments(selection))).toThrow('no replacement');
  expect(recoverScreening(f.repository).report).toEqual(report);
});
it.each(['missing','unknown','disputed'] as const)('retains final %s without replacing it with favorable results',status=>{
  const f=setup(),selection=f.lock();
  const results=status==='missing'?[]:status==='unknown'?f.assessments(selection,'unknown'):[f.assessments(selection)[0],f.assessments(selection,'reject')[1]];
  expect(finalizeScreening(f.repository,results).rows[0].status).toBe(status);
  expect(()=>finalizeScreening(f.repository,f.assessments(selection))).toThrow('no replacement');
});
it.each(['later-candidate','duplicate-assessor','foreign-assessor','wrong-lock','no-candidate-slot','inconsistent-accept','missing-evidence'] as const)
('preserves invalid %s requests and refuses silent correction',mode=>{
  const f=setup(),selection=f.lock(),results=f.assessments(selection);
  if(mode==='later-candidate')results[0].candidateDigest=digestOf(f.second);
  if(mode==='duplicate-assessor')results[1].assessorId=results[0].assessorId;
  if(mode==='foreign-assessor')results[0].assessorId='outsider';
  if(mode==='wrong-lock')results[0].lockDigest='0'.repeat(64);
  if(mode==='no-candidate-slot')results[0].pr=2;
  if(mode==='inconsistent-accept')results[0].atomicity='compound';
  const raw=mode==='missing-evidence'?results.map(r=>({...r,evidenceDigest:null})):results;
  expect(()=>finalizeScreening(f.repository,raw)).toThrow('original request retained');
  expect(JSON.parse(readFileSync(join(f.dir,'results-request.json'),'utf8')).results).toEqual(raw);
  expect(JSON.parse(readFileSync(join(f.dir,'results-failure.json'),'utf8')).status).toBe('failed');
  expect(()=>finalizeScreening(f.repository,f.assessments(selection))).toThrow('no replacement');
  expect(()=>recoverScreening(f.repository)).toThrow('original request retained');
});
it('reconstructs missing derived outputs from fixed requests, but rejects tampered or partial records and stale locks',()=>{
  const f=setup(),selection=f.lock(),report=finalizeScreening(f.repository,f.assessments(selection));
  rmSync(join(f.dir,'selection.json'));rmSync(join(f.dir,'report.json'));
  expect(recoverScreening(f.repository)).toMatchObject({selection,report,status:'finalized'});
  writeFileSync(join(f.dir,'report.json'),JSON.stringify({...report,empiricalAdmission:true}));
  expect(()=>recoverScreening(f.repository)).toThrow();
  writeFileSync(join(f.dir,'results-request.json'),'{');expect(()=>recoverScreening(f.repository)).toThrow();
  mkdirSync(join(f.dir,'.lock'));expect(()=>recoverScreening(f.repository)).toThrow('no takeover');
});
it('blocks incomplete construction, mismatched provenance, invalid chronology and real origins',()=>{
  const f=setup(true);expect(()=>f.lock()).toThrow('original request retained');
  const g=setup();expect(()=>lockScreening({...g.plan,construction:{...g.plan.construction,reportDigest:'0'.repeat(64)}},g.lockedAt)).toThrow('original request retained');
  expect(()=>g.lock()).toThrow('no replacement');
  const h=setup();expect(()=>lockScreening(h.plan,'2026-10-13T00:00:01Z')).toThrow('original request retained');
  const j=setup();expect(()=>lockScreening({...j.plan,origin:'development-public-source'},j.lockedAt)).toThrow();
  expect(existsSync(j.dir)).toBe(false);expect(()=>recoverScreening('example/public')).toThrow('authored');
});
it('runs lock/finalize/recover in separate CLI processes with synthetic inputs only',()=>{
  const f=setup(),root=mkdtempSync(join(tmpdir(),'screening-cli-'));roots.push(root);
  const request=join(root,'request.json'),results=join(root,'results.json');
  writeFileSync(request,JSON.stringify({plan:f.plan,lockedAt:f.lockedAt}));
  const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx',resolve('experiments/construction/replay.ts'),...args],
    {env:{PATH:process.env.PATH},encoding:'utf8',timeout:15000}));
  const selection=cli('screen-lock',request);writeFileSync(results,JSON.stringify(f.assessments(selection,'reject')));
  const report=cli('screen-finalize',f.repository,results);expect(report.rows[0].status).toBe('rejected');
  expect(cli('screen-recover',f.repository).report).toEqual(report);
},30000);

function episodePlan(f:ReturnType<typeof setup>){
 const bound=screenedFamilies(f.repository);
 return {kind:'authored-episode-selection-plan',origin:'authored-fixture',repository:f.repository,
  frozenAt:'2026-10-13T00:00:03Z',construction:bound.construction,screening:bound.screening,families:bound.families,
  prs:[{pr:20,mergedAt:'2024-02-01T00:00:00Z',packetDigest:digestOf('synthetic-target')}]};
}
it.each(['reject','unknown','missing','disputed'] as const)('excludes %s screening from families while retaining its status',verdict=>{
 const f=setup(),lock=f.lock();
 const results=verdict==='missing'?[]:verdict==='disputed'?[f.assessments(lock)[0],f.assessments(lock,'reject')[1]]:f.assessments(lock,verdict);
 const report=finalizeScreening(f.repository,results),bound=screenedFamilies(f.repository);
 expect(bound.families).toEqual([]);expect(bound.screeningRows).toEqual(report.rows);
 expect(()=>selectIndices(episodePlan(f),[],'2026-10-13T00:00:04Z')).toThrow();
 const forged={...episodePlan(f),families:constructedFamilies(f.repository).families};
 expect(()=>selectIndices(forged,[],'2026-10-13T00:00:04Z')).toThrow('provenance');
});
it('refuses unfinished screening, removed bindings, substituted members and stale digests',()=>{
 const f=setup(),lock=f.lock();expect(()=>screenedFamilies(f.repository)).toThrow('not finalized');
 finalizeScreening(f.repository,f.assessments(lock));const plan=episodePlan(f);
 const {screening,...removed}=plan;
 expect(()=>selectIndices(removed,[],'2026-10-13T00:00:04Z')).toThrow('binding required');
 for(const field of ['reportDigest','lockDigest'])expect(()=>selectIndices({...plan,screening:{...screening,[field]:'0'.repeat(64)}},[],'2026-10-13T00:00:04Z')).toThrow('binding mismatch');
 const forged=structuredClone(plan);forged.families[0].constructionMembers[0].candidateDigest=digestOf(f.second);
 expect(()=>selectIndices(forged,[],'2026-10-13T00:00:04Z')).toThrow('provenance');
 expect(()=>selectIndices({...plan,frozenAt:f.lockedAt},[],'2026-10-13T00:00:04Z')).toThrow('follow screening');
});
it('runs screened family to persisted episode and recovery through separate CLI processes',()=>{
 const f=setup(),lock=f.lock();finalizeScreening(f.repository,f.assessments(lock));
 const root=mkdtempSync(join(tmpdir(),'screened-episode-cli-'));roots.push(root,join(episodeRegistryRoot,digestOf({repository:f.repository})));
 const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx',resolve('experiments/construction/replay.ts'),...args],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:15000}));
 const bound=cli('screen-families',f.repository),plan=episodePlan(f);expect(bound.screening).toEqual(plan.screening);
 const rawCells=[{familyId:plan.families[0].id,ruleDigest:plan.families[0].ruleDigest,planDigest:digestOf(plan),pr:20,
  packetDigest:plan.prs[0].packetDigest,recordedAt:'2026-10-13T00:00:04Z',status:'completed',findings:[{path:'a.ts',side:'after',start:1,end:1,claim:'Synthetic finding'}]}];
 const request=join(root,'index.json');writeFileSync(request,JSON.stringify({plan,rawCells,lockedAt:'2026-10-13T00:00:05Z'}));
 const index=cli('episode-index',request);expect(cli('episode-index',request)).toEqual(index);
 const feedback=[{origin:'authored-fixture',indexLockDigest:index.digest,familyId:plan.families[0].id,findingDigest:index.indices[0].findingDigest,
  lockedAt:'2026-10-13T00:00:06Z',verdict:'unknown',otherGates:'blocked',reason:'Synthetic unknown'}];
 const path=join(root,'feedback.json');writeFileSync(path,JSON.stringify(feedback));
 const report=cli('episode-finalize',f.repository,path);expect(report.rows[0].status).toBe('blocked_feedback_or_gates');
 expect(cli('episode-recover',f.repository)).toMatchObject({index,report,empiricalAdmission:false});
},30000);
