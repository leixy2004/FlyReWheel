import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { registryRoot } from '../experiments/construction/registry.js';
import { seedConstruction } from './helpers/construction-family.js';
import { it,expect,afterEach } from 'vitest';
import { digestOf } from '../src/core/identity.js';
import { selectIndices,selectEpisodes } from '../experiments/construction/episode-selection.js';
const time=(n:number)=>`2026-10-13T00:00:0${n}Z`;
const repositories:string[]=[];
afterEach(()=>{for(const repository of repositories.splice(0))rmSync(join(registryRoot,digestOf({repository})),{recursive:true,force:true});});
function fixture(){
 const repository=`authored/selector-${randomUUID()}`;repositories.push(repository);
 const {construction,families}=seedConstruction(repository);
 const plan={kind:'authored-episode-selection-plan',origin:'authored-fixture',repository,frozenAt:time(1),construction,families,
 prs:[1,2,3].map(pr=>({pr,mergedAt:`2024-01-0${pr}T00:00:00Z`,packetDigest:digestOf(pr)}))};
 const finding=(path:string)=>({path,side:'after',start:1,end:2,claim:'authored claim only'});
 const cell=(pr:number,findings:unknown[]=[])=>({familyId:plan.families[0].id,ruleDigest:plan.families[0].ruleDigest,planDigest:digestOf(plan),pr,packetDigest:digestOf(pr),recordedAt:time(2),status:'completed',findings});
 const feedback=(lock:ReturnType<typeof selectIndices>,verdict='unknown')=>({origin:'authored-fixture',indexLockDigest:lock.digest,familyId:plan.families[0].id,findingDigest:lock.indices[0].findingDigest,lockedAt:time(4),verdict,otherGates:'passed-authored',reason:'synthetic judgment, not human'});
 return {plan,finding,cell,feedback};
}
it('locks first finding by canonical anchor order independent of cell input order',()=>{
 const {plan,finding,cell}=fixture();const cells=[cell(2,[finding('z.py'),finding('a.py')]),cell(1),cell(3,[finding('better.py')])];
 const a=selectIndices(plan,cells,time(3)),b=selectIndices(plan,[cells[2],cells[1],cells[0]],time(3));
 expect(a.indices).toEqual(b.indices);expect(a.indices[0]).toMatchObject({pr:2,findingDigest:digestOf(finding('a.py'))});expect(a.cells).toHaveLength(3);
});
it('earlier missing, failed or malformed cell blocks instead of skipping',()=>{
 const {plan,finding,cell}=fixture();
 for(const first of [undefined,{...cell(1),status:'failed'},cell(1,[finding('../invalid')])]){
  const lock=selectIndices(plan,[...(first?[first]:[]),cell(2,[finding('a.py')])],time(3));
  expect(lock.indices[0].status).toBe('blocked_earlier_cell');expect(lock.cells).toHaveLength(3);
 }
});
it('unknown/missing feedback cannot replace the chosen index with later favorable finding',()=>{
 const {plan,finding,cell,feedback}=fixture();const lock=selectIndices(plan,[cell(1,[finding('a.py')]),cell(2,[finding('b.py')])],time(3));
 expect(selectEpisodes(lock,[]).rows[0].status).toBe('missing_feedback');
 expect(selectEpisodes(lock,[feedback(lock)]).rows[0].status).toBe('blocked_feedback_or_gates');
 expect(()=>selectEpisodes(lock,[{...feedback(lock,'fp'),findingDigest:digestOf(finding('b.py'))}])).toThrow(/frozen index/);
});
it('retains TP index, gate failures, no-finding and missing denominators',()=>{
 const {plan,finding,cell,feedback}=fixture();const lock=selectIndices(plan,[cell(1,[finding('a.py')])],time(3));
 expect(selectEpisodes(lock,[feedback(lock,'tp')]).rows[0].status).toBe('ready_authored_only');
 expect(selectEpisodes(lock,[{...feedback(lock,'fp'),otherGates:'blocked'}]).rows[0].status).toBe('blocked_feedback_or_gates');
 expect(selectIndices(plan,[cell(1),cell(2),cell(3)],time(3)).indices[0].status).toBe('no_finding');
 expect(selectEpisodes(lock,[]).empiricalAdmission).toBe(false);
});
it('rejects replacement cells, feedback before lock and tampered lock',()=>{
 const {plan,finding,cell,feedback}=fixture();const c=cell(1,[finding('a.py')]);
 expect(()=>selectIndices(plan,[c,c],time(3))).toThrow(/duplicate cell/);
 const lock=selectIndices(plan,[c],time(3));expect(()=>selectEpisodes(lock,[{...feedback(lock),lockedAt:time(2)}])).toThrow(/follow/);
 lock.indices[0].pr=2;expect(()=>selectEpisodes(lock,[])).toThrow(/mismatch/);
});
it('rejects real origins, nonchronological plans and outcome hints in review cells',()=>{
 const {plan,finding,cell}=fixture();expect(()=>selectIndices({...plan,origin:'real'},[],time(3))).toThrow();
 expect(()=>selectIndices({...plan,prs:[...plan.prs].reverse()},[],time(3))).toThrow(/order/);
 expect(selectIndices(plan,[{...cell(1,[finding('a.py')]),correctness:'fp'}],time(3)).indices[0].status).toBe('blocked_earlier_cell');
});

it('binds review cells to exact plan/rule and rejects duplicate exact-family denominators',()=>{
 const {plan,cell,finding}=fixture();
 for(const changed of [{ruleDigest:digestOf('other')},{planDigest:digestOf('other')},{packetDigest:digestOf('other')},{recordedAt:time(4)}]){
  const lock=selectIndices(plan,[{...cell(1,[finding('a.py')]),...changed}],time(3));
  expect(lock.indices[0].status).toBe('blocked_earlier_cell');
 }
 expect(()=>selectIndices({...plan,families:[...plan.families,{...plan.families[0],id:'duplicate'}]},[],time(3))).toThrow(/duplicate exact rule family/);
});
