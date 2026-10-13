import { z } from 'zod';
import { digestOf } from '../../src/core/identity.js';
import { DigestSchema } from '../../src/core/model.js';
const Text=z.string().min(1).max(4096);
const Time=z.string().datetime({offset:true});
export const EpisodePlanSchema=z.object({kind:z.literal('authored-episode-selection-plan'),origin:z.literal('authored-fixture'),
  repository:Text.refine(s=>s.startsWith('authored/')),frozenAt:Time,
  families:z.array(z.object({id:Text,representativeOrder:z.number().int().positive(),ruleDigest:DigestSchema}).strict()).min(1),
  prs:z.array(z.object({pr:z.number().int().positive(),mergedAt:Time,packetDigest:DigestSchema}).strict()).min(1),
}).strict().superRefine((p,ctx)=>{
  if(new Set(p.families.map(f=>f.ruleDigest)).size!==p.families.length)ctx.addIssue({code:'custom',message:'duplicate exact rule family'});
  if(new Set(p.families.map(f=>f.id)).size!==p.families.length||new Set(p.prs.map(r=>r.pr)).size!==p.prs.length)
    ctx.addIssue({code:'custom',message:'duplicate roster identity'});
  const families=[...p.families].sort((a,b)=>a.representativeOrder-b.representativeOrder||a.ruleDigest.localeCompare(b.ruleDigest)||a.id.localeCompare(b.id));
  const prs=[...p.prs].sort((a,b)=>Date.parse(a.mergedAt)-Date.parse(b.mergedAt)||a.pr-b.pr);
  if(digestOf(families)!==digestOf(p.families)||digestOf(prs)!==digestOf(p.prs))ctx.addIssue({code:'custom',message:'noncanonical roster order'});
});
const Finding=z.object({path:Text.refine(s=>!s.startsWith('/')&&!s.includes('\\')&&s.split('/').every(x=>x&&x!=='.'&&x!=='..')),
  side:z.enum(['before','after']),start:z.number().int().positive(),end:z.number().int().positive(),claim:Text,
}).strict().refine(f=>f.end>=f.start,'invalid span');
const Cell=z.object({familyId:Text,ruleDigest:DigestSchema,planDigest:DigestSchema,pr:z.number().int().positive(),packetDigest:DigestSchema,
  recordedAt:Time,status:z.enum(['completed','failed','missing']),findings:z.array(z.unknown()),
}).strict().refine(c=>c.status==='completed'||c.findings.length===0,'failed/missing response cannot assert findings');
export function selectIndices(planInput:unknown,rawCells:unknown[],lockedAt:string){
 const plan=EpisodePlanSchema.parse(planInput);Time.parse(lockedAt);
 if(Date.parse(lockedAt)<=Date.parse(plan.frozenAt))throw Error('index lock must follow plan freeze');
 const keyed=new Map<string,unknown>();
 for(const raw of rawCells){
  if(!raw||typeof raw!=='object')throw Error('unbound cell cannot enter roster');
  const c=raw as {familyId?:unknown;pr?:unknown};
  if(!plan.families.some(f=>f.id===c.familyId)||!plan.prs.some(p=>p.pr===c.pr))throw Error('out-of-roster cell');
  const key=JSON.stringify([c.familyId,c.pr]);if(keyed.has(key))throw Error('duplicate cell; replacement forbidden');keyed.set(key,raw);
 }
 const cells=plan.families.flatMap(f=>plan.prs.map(p=>{
  const raw=keyed.get(JSON.stringify([f.id,p.pr]));const base={familyId:f.id,pr:p.pr,raw:raw??null};
  if(!raw)return {...base,status:'missing',findings:[]};
  const parsed=Cell.safeParse(raw);
  if(!parsed.success)return {...base,status:'failed',reason:'invalid cell',findings:[]};
  const c=parsed.data;
  if(c.ruleDigest!==f.ruleDigest||c.planDigest!==digestOf(plan)||c.packetDigest!==p.packetDigest||Date.parse(c.recordedAt)<=Date.parse(plan.frozenAt)||Date.parse(c.recordedAt)>Date.parse(lockedAt))
    return {...base,status:'failed',reason:'packet/time binding mismatch',findings:[]};
  const findings=c.findings.map(x=>Finding.safeParse(x));
  if(findings.some(x=>!x.success))return {...base,status:'failed',reason:'invalid finding invalidates whole cell',findings:[]};
  const ordered=findings.map(x=>x.data!).sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))||
    (a.side===b.side?0:a.side==='before'?-1:1)||a.start-b.start||a.end-b.end||digestOf(a).localeCompare(digestOf(b)));
  return {...base,status:c.status,findings:ordered.map(finding=>({finding,digest:digestOf(finding)}))};
 }));
 const indices=plan.families.map(f=>{
  for(const c of cells.filter(c=>c.familyId===f.id)){
   if(c.status!=='completed')return {familyId:f.id,status:'blocked_earlier_cell',pr:c.pr,findingDigest:null};
   if(c.findings.length)return {familyId:f.id,status:'index_locked',pr:c.pr,findingDigest:c.findings[0].digest};
  }
  return {familyId:f.id,status:'no_finding',pr:null,findingDigest:null};
 });
 const body={kind:'authored-index-lock',plan,rawCells,lockedAt,cells,indices,empiricalAdmission:false,modelCalls:0,independentLabels:0};
 return {...body,digest:digestOf(body)};
}
export const FeedbackSchema=z.object({origin:z.literal('authored-fixture'),indexLockDigest:DigestSchema,familyId:Text,
 findingDigest:DigestSchema,lockedAt:Time,verdict:z.enum(['tp','fp','unknown','disputed','missing']),
 otherGates:z.enum(['passed-authored','blocked']),reason:Text,
}).strict();
export function selectEpisodes(lock:ReturnType<typeof selectIndices>,rawFeedback:unknown[]){
 const rebuilt=selectIndices(lock.plan,lock.rawCells,lock.lockedAt);
 if(digestOf(lock)!==digestOf(rebuilt))throw Error('index lock mismatch');
 const feedback=rawFeedback.map(x=>FeedbackSchema.parse(x));
 if(new Set(feedback.map(f=>f.familyId)).size!==feedback.length)throw Error('duplicate feedback; no replacement');
 for(const f of feedback){
  const index=lock.indices.find(i=>i.familyId===f.familyId);
  if(f.indexLockDigest!==lock.digest||!index||index.status!=='index_locked'||f.findingDigest!==index.findingDigest)
    throw Error('feedback does not bind the frozen index');
  if(Date.parse(f.lockedAt)<=Date.parse(lock.lockedAt))throw Error('feedback must follow index lock');
 }
 return {kind:'authored-episode-selection',indexLockDigest:lock.digest,empiricalAdmission:false,modelCalls:0,independentLabels:0,
  rows:lock.indices.map(index=>{
   const f=feedback.find(f=>f.familyId===index.familyId);
   return {index,feedback:f??null,status:index.status!=='index_locked'?index.status:!f?'missing_feedback':
    (f.verdict==='tp'||f.verdict==='fp')&&f.otherGates==='passed-authored'?'ready_authored_only':'blocked_feedback_or_gates'};
  })};
}
