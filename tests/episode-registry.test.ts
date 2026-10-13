import { it,expect } from 'vitest';
import { rmSync,readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestOf } from '../src/core/identity.js';
import { episodeRegistryRoot,registerEpisodeIndex,finalizeRegisteredEpisode,recoverRegisteredEpisode } from '../experiments/construction/episode-registry.js';
function fixture(){
 const repository=`authored/index-${randomUUID()}`;
 const plan={kind:'authored-episode-selection-plan',origin:'authored-fixture',repository,frozenAt:'2026-10-13T00:00:01Z',
 families:[{id:'f',representativeOrder:1,ruleDigest:digestOf('f')}],prs:[1,2].map(pr=>({pr,mergedAt:`2024-01-0${pr}T00:00:00Z`,packetDigest:digestOf(pr)}))};
 const cells=plan.prs.map(p=>({familyId:'f',ruleDigest:plan.families[0].ruleDigest,planDigest:digestOf(plan),pr:p.pr,packetDigest:p.packetDigest,recordedAt:'2026-10-13T00:00:02Z',status:'completed',findings:[{path:'a.py',side:'after',start:1,end:1,claim:'authored'}]}));
 const dir=join(episodeRegistryRoot,digestOf({repository}));
 const index=()=>registerEpisodeIndex(plan,cells,'2026-10-13T00:00:03Z');
 const feedback=(lock:ReturnType<typeof index>,verdict='unknown')=>[{origin:'authored-fixture',indexLockDigest:lock.digest,familyId:'f',findingDigest:lock.indices[0].findingDigest,lockedAt:'2026-10-13T00:00:04Z',verdict,otherGates:'passed-authored',reason:'synthetic'}];
 return {repository,plan,cells,dir,index,feedback,clean:()=>rmSync(dir,{recursive:true,force:true})};
}
it('persists first index across calls and refuses changed plans or cells',()=>{
 const s=fixture();try{const first=s.index();expect(s.index()).toEqual(first);
  expect(()=>registerEpisodeIndex({...s.plan,frozenAt:'2026-10-13T00:00:00Z'},s.cells,'2026-10-13T00:00:03Z')).toThrow(/conflict/);
  expect(()=>registerEpisodeIndex(s.plan,[{...s.cells[0],findings:[]},s.cells[1]],'2026-10-13T00:00:03Z')).toThrow(/conflict/);
  expect(recoverRegisteredEpisode(s.repository).index.indices[0].pr).toBe(1);
 }finally{s.clean();}
});
it('Unknown and final missing feedback cannot be replaced by favorable feedback',()=>{
 for(const missing of [false,true]){const s=fixture();try{const index=s.index();const original=missing?[]:s.feedback(index);
  const report=finalizeRegisteredEpisode(s.repository,original);expect(report.rows[0].status).toMatch(/missing|blocked/);
  expect(finalizeRegisteredEpisode(s.repository,original)).toEqual(report);
  expect(()=>finalizeRegisteredEpisode(s.repository,s.feedback(index,'fp'))).toThrow(/conflict/);
 }finally{s.clean();}}
});
it('failed index and invalid feedback reservations consume their choices',()=>{
 const s=fixture();try{
  expect(()=>registerEpisodeIndex(s.plan,s.cells,'2026-10-13T00:00:00Z')).toThrow(/follow/);
  expect(()=>s.index()).toThrow(/conflict/);expect(readFileSync(join(s.dir,'index-failure.json'),'utf8')).toContain('failed');
 }finally{s.clean();}
 const t=fixture();try{const lock=t.index();const bad=[{...t.feedback(lock)[0],findingDigest:digestOf('replacement')}];
  expect(()=>finalizeRegisteredEpisode(t.repository,bad)).toThrow(/frozen index/);
  expect(()=>finalizeRegisteredEpisode(t.repository,t.feedback(lock))).toThrow(/conflict/);
  expect(()=>recoverRegisteredEpisode(t.repository)).toThrow(/frozen index/);
 }finally{t.clean();}
});
it('recovers missing derived artifacts only from immutable reservations',()=>{
 const s=fixture();try{const index=s.index();const report=finalizeRegisteredEpisode(s.repository,s.feedback(index));
  rmSync(join(s.dir,'index.json'));rmSync(join(s.dir,'episode-report.json')); // Simulate interruption before derived outputs.
  const recovered=recoverRegisteredEpisode(s.repository);expect(recovered.index).toEqual(index);expect(recovered.report).toEqual(report);
  const request=JSON.parse(readFileSync(join(s.dir,'index-request.json'),'utf8'));expect(request.rawCells).toEqual(s.cells);
 }finally{s.clean();}
});
it('partial records and interrupted locks block recovery instead of unlocking choices',()=>{
 const s=fixture();try{s.index();writeFileSync(join(s.dir,'index-request.json'),'{');expect(()=>recoverRegisteredEpisode(s.repository)).toThrow();
  mkdirSync(join(s.dir,'.lock'));expect(()=>recoverRegisteredEpisode(s.repository)).toThrow(/no takeover/);
 }finally{s.clean();}
});
it('real origins are rejected before index registration',()=>{
 const s=fixture();try{expect(()=>registerEpisodeIndex({...s.plan,origin:'development-public-source'},s.cells,'2026-10-13T00:00:03Z')).toThrow();
  expect(()=>recoverRegisteredEpisode('encode/httpx')).toThrow(/authored/);
 }finally{s.clean();}
});
