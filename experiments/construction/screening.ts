import { z } from 'zod';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf } from '../../src/core/identity.js';
import { DigestSchema } from '../../src/core/model.js';
import { registeredInputs } from './registry.js';
import { replay } from './runner.js';
import { Candidate } from './candidate.js';
import { parseUniqueJson } from './raw-response.js';
const Time=z.string().datetime({offset:true}), Text=z.string().min(1).max(8192);
export const ScreeningPlanSchema=z.object({kind:z.literal('authored-construction-screening-plan'),origin:z.literal('authored-fixture'),
  repository:Text.refine(v=>v.startsWith('authored/')),construction:z.object({freezeDigest:DigestSchema,reportDigest:DigestSchema}).strict(),
  assessors:z.array(z.string().min(1).max(128)).length(2).refine(v=>new Set(v).size===2,'distinct assessor IDs required'),
}).strict();
const Result=z.object({origin:z.literal('authored-fixture'),lockDigest:DigestSchema,pr:z.number().int().positive(),
  candidateDigest:DigestSchema,assessorId:z.string().min(1).max(128),verdict:z.enum(['accept','reject','unknown']),
  atomicity:z.enum(['single','compound','unknown']),scope:z.enum(['supported','unsupported','unknown']),
  sourceSupport:z.enum(['supported','unsupported','unknown']),rationale:Text,evidenceDigest:DigestSchema.nullable(),
}).strict().refine(r=>r.verdict!=='accept' || r.atomicity==='single' && r.scope==='supported' && r.sourceSupport==='supported' && r.evidenceDigest!==null,
  'accept requires all declared screening criteria and an evidence digest');
export const screeningRegistryRoot=fileURLToPath(new URL('../../.construction-screenings/',import.meta.url));
function read(path:string):unknown{
  const info=lstatSync(path);
  if(info.isSymbolicLink() || !info.isFile() || info.size>8_000_000)throw Error('invalid screening registry record');
  return parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)),8_000_000);
}
function bind(path:string,value:unknown){
  const expectedDigest=digestOf(value);
  const serialized=JSON.stringify(value,null,2)+'\n';
  if(Buffer.byteLength(serialized)>8_000_000)throw Error('screening record exceeds byte budget');
  try{writeFileSync(path,serialized,{flag:'wx',mode:0o600});}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
    if(digestOf(read(path))!==expectedDigest)throw Error('screening conflict; no replacement');}
}
function locked<T>(repository:string,create:boolean,fn:(dir:string)=>T):T{
  if(!repository.startsWith('authored/'))throw Error('only authored screening is supported');
  const dir=join(screeningRegistryRoot,digestOf({repository}));
  if(create){mkdirSync(screeningRegistryRoot,{recursive:true,mode:0o700});
    if(lstatSync(screeningRegistryRoot).isSymbolicLink())throw Error('registry symlink');
    mkdirSync(dir,{recursive:true,mode:0o700});}
  if(lstatSync(screeningRegistryRoot).isSymbolicLink() || lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory())throw Error('invalid registry directory');
  const lock=join(dir,'.lock');
  try{mkdirSync(lock,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('screening registry busy or interrupted; no takeover');throw e;}
  try{return fn(dir);}finally{rmdirSync(lock);}
}
const Request=z.object({plan:ScreeningPlanSchema,lockedAt:Time}).strict();
function selectionFromRequest(dir:string){
  const request=Request.parse(read(join(dir,'selection-request.json'))),{plan,lockedAt}=request;
  if(join(screeningRegistryRoot,digestOf({repository:plan.repository}))!==dir)throw Error('repository binding mismatch');
  const {frozen,inputs}=registeredInputs(plan.repository),report=replay(frozen,inputs);
  if(plan.construction.freezeDigest!==frozen.digest || plan.construction.reportDigest!==digestOf(report))throw Error('construction binding mismatch');
  if(report.rows.some(r=>r.status==='not_run'))throw Error('complete construction required before screening');
  if(Date.parse(lockedAt)<=Date.parse(frozen.frozenAt))throw Error('screening must follow construction freeze');
  const choices=report.rows.map(row=>{
    const base={pr:row.pr,constructionStatus:row.status,packetDigest:row.packetDigest,rawReceiptDigest:row.rawReceiptDigest};
    if(row.status!=='provisional_rule')return {...base,candidateDigest:null,excludedCandidateDigests:[]};
    const selected=z.object({candidate:Candidate,disposition:z.literal('retained_pending_independent_admission'),familyKey:DigestSchema}).strict().parse(row.candidates[0]);
    const excluded=row.candidates.slice(1).map(c=>z.object({candidate:Candidate}).passthrough().parse(c).candidate);
    return {...base,candidateDigest:digestOf(selected.candidate),excludedCandidateDigests:excluded.map(digestOf)};
  });
  const body={kind:'authored-screening-lock',plan,lockedAt,choices,assessorIdentityVerified:false,independentLabels:0,empiricalAdmission:false};
  const selection={...body,digest:digestOf(body)};
  bind(join(dir,'selection.json'),selection);return selection;
}
function finish(dir:string,selection:ReturnType<typeof selectionFromRequest>){
  const request=z.object({lockDigest:DigestSchema,results:z.array(z.unknown())}).strict().parse(read(join(dir,'results-request.json')));
  if(request.lockDigest!==selection.digest)throw Error('screening lock mismatch');
  try{
    const results=request.results.map(r=>Result.parse(r)),seen=new Set<string>();
    for(const result of results){
      const choice=selection.choices.find(c=>c.pr===result.pr),key=JSON.stringify([result.pr,result.assessorId]);
      if(result.lockDigest!==selection.digest || !choice?.candidateDigest || result.candidateDigest!==choice.candidateDigest ||
        !selection.plan.assessors.includes(result.assessorId))throw Error('result does not match locked first candidate and assessor');
      if(seen.has(key))throw Error('duplicate assessor result');seen.add(key);
    }
    const rows=selection.choices.map(choice=>{
      const assessments=results.filter(r=>r.pr===choice.pr);
      if(!choice.candidateDigest)return {...choice,status:choice.constructionStatus,assessments};
      const missingAssessors=selection.plan.assessors.filter(id=>!assessments.some(r=>r.assessorId===id));
      const judgments=assessments.map(({verdict,atomicity,scope,sourceSupport})=>digestOf({verdict,atomicity,scope,sourceSupport}));
      const status=missingAssessors.length?'missing':new Set(judgments).size>1?'disputed':
        assessments[0].verdict==='accept'?'accepted-authored-only':assessments[0].verdict==='reject'?'rejected':'unknown';
      return {...choice,status,assessments,missingAssessors};
    });
    const body={kind:'authored-construction-screening-report',lockDigest:selection.digest,rows,
      replacementAllowed:false,assessorIdentityVerified:false,independentLabels:0,empiricalAdmission:false,modelCalls:0};
    const report={...body,digest:digestOf(body)};
    bind(join(dir,'report.json'),report);return report;
  }catch{
    bind(join(dir,'results-failure.json'),{status:'failed',requestDigest:digestOf(request),reason:'invalid screening result binding'});
    throw Error('invalid screening result binding; original request retained');
  }
}
/** Locks the already-retained candidate before accepting any assessments. */
export function lockScreening(planInput:unknown,lockedAt:string){
  const plan=ScreeningPlanSchema.parse(planInput);
  return locked(plan.repository,true,dir=>{
    const request={plan,lockedAt};bind(join(dir,'selection-request.json'),request);
    try{return selectionFromRequest(dir);}catch{
      bind(join(dir,'selection-failure.json'),{status:'failed',requestDigest:digestOf(request),reason:'invalid construction screening selection'});
      throw Error('invalid construction screening selection; original request retained');
    }
  });
}
/** Final missing/unknown/disputed assessments remain final; no later replacement. */
export function finalizeScreening(repository:string,results:unknown[]){
  return locked(repository,false,dir=>{
    const selection=selectionFromRequest(dir);
    bind(join(dir,'results-request.json'),{lockDigest:selection.digest,results});
    return finish(dir,selection);
  });
}
export function recoverScreening(repository:string){
  return locked(repository,false,dir=>{
    const selection=selectionFromRequest(dir),finalized=existsSync(join(dir,'results-request.json'));
    return {selection,report:finalized?finish(dir,selection):null,status:finalized?'finalized':'awaiting-assessments',empiricalAdmission:false};
  });
}
