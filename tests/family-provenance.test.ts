import { it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '../src/core/identity.js';
import { seedConstruction } from './helpers/construction-family.js';
import { registryRoot,register } from '../experiments/construction/registry.js';
import { constructedFamilies } from '../experiments/construction/family-provenance.js';
import { selectIndices } from '../experiments/construction/episode-selection.js';
import { fixture } from '../experiments/construction/fixture.js';
import { freeze } from '../experiments/construction/contracts.js';
function setup(){
 const repository=`authored/provenance-${randomUUID()}`;const seed=seedConstruction(repository);
 const plan={kind:'authored-episode-selection-plan',origin:'authored-fixture',repository,frozenAt:'2026-10-13T00:00:01Z',construction:seed.construction,families:seed.families,
 prs:[{pr:10,mergedAt:'2024-02-01T00:00:00Z',packetDigest:digestOf('target')}]};
 return {repository,seed,plan,clean:()=>rmSync(join(registryRoot,digestOf({repository})),{recursive:true,force:true})};
}
it('legitimate authoritative family binding replays identically',()=>{
 const s=setup();try{
  const a=selectIndices(s.plan,[],'2026-10-13T00:00:03Z');expect(selectIndices(s.plan,[],'2026-10-13T00:00:03Z')).toEqual(a);
  expect(a.plan.families[0].constructionMembers).toEqual([{pr:1,candidateDigest:digestOf(s.seed.inputs[0].candidates[0])}]);
 }finally{s.clean();}
});
it('rejects invented family, forged member, duplicate member and digest mismatches',()=>{
 const s=setup();try{
  const f=s.plan.families[0];
  const altered=[{...s.plan,families:[{...f,ruleDigest:digestOf('forged')}]},
   {...s.plan,families:[{...f,constructionMembers:[{pr:99,candidateDigest:digestOf('forged')}]}]},
   {...s.plan,families:[{...f,constructionMembers:[...f.constructionMembers,...f.constructionMembers]}]},
   {...s.plan,construction:{...s.plan.construction,reportDigest:digestOf('forged')}},
   {...s.plan,construction:{...s.plan.construction,freezeDigest:digestOf('forged')}}];
  for(const p of altered)expect(()=>selectIndices(p,[],'2026-10-13T00:00:03Z')).toThrow(/provenance/);
 }finally{s.clean();}
});
it('missing authoritative record cannot be replaced by self-declared bindings',()=>{
 const s=setup();s.clean();expect(()=>selectIndices(s.plan,[],'2026-10-13T00:00:03Z')).toThrow();
});
it('incomplete construction is blocked; full exact duplicates merge with every member retained',()=>{
 const c=fixture();c.repository=`authored/incomplete-${randomUUID()}`;const f=freeze(c,'2026-10-13T00:00:00Z');
 const candidate={path:'a.py',side:'after',start:1,end:1,scope:'all',applicability:'op',invariant:'guard',exception:'none',requiredContext:[]};
 const inputs=c.roster.map(p=>({pr:p.pr,packetDigest:p.packetDigest,outcome:'completed',candidates:[candidate]}));
 try{register(f,[inputs[0]]);expect(()=>constructedFamilies(c.repository)).toThrow(/incomplete/);
  register(f,inputs);const result=constructedFamilies(c.repository);expect(result.families).toHaveLength(1);expect(result.families[0].constructionMembers.map(m=>m.pr)).toEqual([1,2]);
 }finally{rmSync(join(registryRoot,digestOf({repository:c.repository})),{recursive:true,force:true});}
});
it('only the retained candidate can source a family and the entire family roster is mandatory',()=>{
 const c=fixture();c.repository=`authored/cap-${randomUUID()}`;const f=freeze(c,'2026-10-13T00:00:00Z');
 const candidate=(path:string,invariant:string)=>({path,side:'after',start:1,end:1,scope:'all',applicability:'op',invariant,exception:'none',requiredContext:[]});
 const kept=candidate('a.py','kept'),excluded=candidate('z.py','excluded');
 try{register(f,c.roster.map((p,i)=>({pr:p.pr,packetDigest:p.packetDigest,outcome:'completed',candidates:i===0?[excluded,kept]:[candidate('b.py','second')]})));
  const {construction,families}=constructedFamilies(c.repository);expect(families).toHaveLength(2);
  expect(families[0].constructionMembers[0].candidateDigest).toBe(digestOf(kept));
  const plan={kind:'authored-episode-selection-plan',origin:'authored-fixture',repository:c.repository,frozenAt:'2026-10-13T00:00:01Z',construction,families:[families[0]],prs:[{pr:10,mergedAt:'2024-02-01T00:00:00Z',packetDigest:digestOf('target')}]};
  expect(()=>selectIndices(plan,[],'2026-10-13T00:00:03Z')).toThrow(/provenance/);
 }finally{rmSync(join(registryRoot,digestOf({repository:c.repository})),{recursive:true,force:true});}
});
