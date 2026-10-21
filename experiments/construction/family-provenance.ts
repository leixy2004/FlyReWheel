import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { recoverScreening, screeningRegistryRoot } from './screening.js';
import { z } from 'zod';
import { digestOf } from '../../src/core/identity.js';
import { DigestSchema } from '../../src/core/model.js';
import { registeredInputs } from './registry.js';
import { replay } from './runner.js';
export const FamilyBindingSchema=z.object({id:z.string().min(1),representativeOrder:z.number().int().positive(),ruleDigest:DigestSchema,
 constructionMembers:z.array(z.object({pr:z.number().int().positive(),candidateDigest:DigestSchema}).strict()).min(1),
}).strict();
export const ConstructionBindingSchema=z.object({freezeDigest:DigestSchema,reportDigest:DigestSchema}).strict();
export function constructedFamilies(repository:string){
 const {frozen,inputs}=registeredInputs(repository);
 const report=replay(frozen,inputs);
 if(report.rows.some(r=>r.status==='not_run'))throw Error('construction roster incomplete; missing attempt');
 const families=new Map<string,z.infer<typeof FamilyBindingSchema>>();
 report.rows.forEach((row,i)=>{
  if(row.status!=='provisional_rule')return;
  const selected=z.object({candidate:z.unknown(),disposition:z.literal('retained_pending_independent_admission'),familyKey:DigestSchema}).strict().parse(row.candidates[0]);
  const member={pr:row.pr,candidateDigest:digestOf(selected.candidate)};
  const existing=families.get(selected.familyKey);
  if(existing)existing.constructionMembers.push(member);
  else families.set(selected.familyKey,{id:`family-${selected.familyKey}`,representativeOrder:i+1,ruleDigest:selected.familyKey,constructionMembers:[member]});
 });
 if(!families.size)throw Error('construction has no retained authored family');
 return {construction:{freezeDigest:frozen.digest,reportDigest:digestOf(report)},
  families:[...families.values()].sort((a,b)=>a.representativeOrder-b.representativeOrder||a.ruleDigest.localeCompare(b.ruleDigest)),
  constructionFrozenAt:frozen.frozenAt};
}
export const ScreeningBindingSchema=z.object({lockDigest:DigestSchema,reportDigest:DigestSchema}).strict();
export function screenedFamilies(repository:string){
 const base=constructedFamilies(repository),{selection,report}=recoverScreening(repository);
 if(!report)throw Error('screening assessments not finalized');
 const accepted=new Set(report.rows.filter(r=>r.status==='accepted-authored-only').map(r=>JSON.stringify([r.pr,r.candidateDigest])));
 const families=base.families.flatMap(f=>{
  const constructionMembers=f.constructionMembers.filter(m=>accepted.has(JSON.stringify([m.pr,m.candidateDigest])));
  if(!constructionMembers.length)return [];
  const representativeOrder=selection.choices.findIndex(c=>c.pr===constructionMembers[0].pr)+1;
  return [{...f,representativeOrder,constructionMembers}];
 }).sort((a,b)=>a.representativeOrder-b.representativeOrder||a.ruleDigest.localeCompare(b.ruleDigest));
 return {...base,families,screening:{lockDigest:selection.digest,reportDigest:report.digest},
  screeningLockedAt:selection.lockedAt,screeningRows:report.rows,empiricalAdmission:false,independentLabels:0};
}
export function validateFamilyProvenance(plan:{repository:string;frozenAt:string;construction:z.infer<typeof ConstructionBindingSchema>;screening?:z.infer<typeof ScreeningBindingSchema>;families:z.infer<typeof FamilyBindingSchema>[]}){
 const hasScreening=existsSync(join(screeningRegistryRoot,digestOf({repository:plan.repository})));
 if(hasScreening&&!plan.screening)throw Error('screening binding required for screened repository');
 const expected=plan.screening?screenedFamilies(plan.repository):constructedFamilies(plan.repository);
 if(plan.screening){
  const screened=expected as ReturnType<typeof screenedFamilies>;
  if(digestOf(plan.screening)!==digestOf(screened.screening))throw Error('screening report binding mismatch');
  if(Date.parse(plan.frozenAt)<=Date.parse(screened.screeningLockedAt))throw Error('episode plan must follow screening lock');
 }
 if(digestOf(plan.construction)!==digestOf(expected.construction)||digestOf(plan.families)!==digestOf(expected.families))
  throw Error('episode families do not match complete authoritative construction provenance');
 if(Date.parse(plan.frozenAt)<=Date.parse(expected.constructionFrozenAt))throw Error('episode plan must follow construction freeze');
}
