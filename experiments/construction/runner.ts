import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { digestOf } from '../../src/core/identity.js';
import { DigestSchema } from '../../src/core/model.js';
import { register } from './registry.js';
import { validateFreeze } from './contracts.js';
import { Candidate } from './candidate.js';
import { validateRawResponse } from './raw-response.js';
const ReceiptBase=z.object({pr:z.number().int().positive(),packetDigest:DigestSchema,
  outcome:z.enum(['completed','interrupted']),
}).strict();
const Receipt=z.union([ReceiptBase.extend({candidates:z.array(z.unknown())}).strict(),
  ReceiptBase.extend({rawResponse:z.string(),sourcePacket:z.unknown()}).strict()]);
export function replay(frozen:unknown, inputs:unknown[]) {
  const f=validateFreeze(frozen);
  // Both input formats remain authored-only; raw responses are checked before candidate retention.
  const receipts=inputs.map(x=>Receipt.parse(x));
  if(new Set(receipts.map(r=>r.pr)).size!==receipts.length) throw Error('duplicate attempt; no retries');
  if(receipts.some(r=>!f.config.roster.some(p=>p.pr===r.pr&&!p.priorRejected))) throw Error('out-of-roster or previously rejected attempt');
  const eligible=f.config.roster.filter(p=>!p.priorRejected);
  if(receipts.some((r,i)=>r.pr!==eligible[i]?.pr)) throw Error('attempts must follow roster prefix without skipped slots');
  if(receipts.some(r=>!('rawResponse' in r) && Buffer.byteLength(JSON.stringify(r))>f.config.limits.responseBytes)) throw Error('response byte budget exceeded');
  const rows=f.config.roster.map(p=>{
    const r=receipts.find(r=>r.pr===p.pr);
    const base={pr:p.pr,packetDigest:p.packetDigest,rawReceiptDigest:r?digestOf(r):null};
    if(p.priorRejected) return {...base,status:'prior_rejected',candidates:[]};
    if(!r) return {...base,status:'not_run',candidates:[]};
    if(r.packetDigest!==p.packetDigest) throw Error('source packet binding mismatch');
    const rawValidation='rawResponse' in r?validateRawResponse(r.rawResponse,r.sourcePacket,{repository:f.config.repository,pr:p.pr,
      packetDigest:p.packetDigest!,maxResponseBytes:f.config.limits.responseBytes}):undefined;
    const values='candidates' in r?r.candidates:rawValidation?.status==='validated'?rawValidation.candidates:[];
    const evidence=rawValidation?{rawValidation}:{};
    if(r.outcome==='interrupted') return {...base,...evidence,status:'failed',reason:'interrupted; slot consumed',candidates:values};
    if(rawValidation?.status==='failed') return {...base,...evidence,status:'failed',reason:`${rawValidation.reason}; slot consumed`,candidates:[]};
    const parsed=values.map(c=>Candidate.safeParse(c));
    if(parsed.some(c=>!c.success)) return {...base,...evidence,status:'failed',reason:'malformed candidate; slot consumed',candidates:values};
    const candidates=parsed.map(c=>c.data!).sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)) ||
      (a.side===b.side?0:a.side==='before'?-1:1)||a.start-b.start||a.end-b.end||digestOf(a).localeCompare(digestOf(b)));
    return {...base,...evidence,status:candidates.length?'provisional_rule':'no_rule',candidates:candidates.map((c,i)=>({candidate:c,
      disposition:i===0?'retained_pending_independent_admission':candidates.slice(0,i).some(prior=>digestOf(prior)===digestOf(c))?'duplicate_excluded':'cap_excluded',
      familyKey:digestOf({repository:f.config.repository,scope:c.scope,applicability:c.applicability,invariant:c.invariant,exception:c.exception,requiredContext:c.requiredContext})}))};
  });
  return {kind:'authored-construction-replay',freezeDigest:f.digest,rows,modelCalls:0,independentLabels:0,empiricalAdmission:false};
}
export function writeReplay(directory:string,frozen:unknown,inputs:unknown[]) {
  // Output directories are disposable projections; authoritative attempt slots live in the fixed registry.
  mkdirSync(directory,{mode:0o700});
  writeFileSync(join(directory,'reservation.json'),JSON.stringify({kind:'authored-replay-reservation',inputDigest:digestOf(inputs)}),{flag:'wx',mode:0o600});
  try {
    writeFileSync(join(directory,'inputs.json'),JSON.stringify({frozen,inputs},null,2),{flag:'wx',mode:0o600});
    const registration=register(frozen,inputs);
    writeFileSync(join(directory,'registration.json'),JSON.stringify(registration,null,2),{flag:'wx',mode:0o600});
    const report=replay(frozen,inputs);
    writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    return report;
  } catch(e) {
    writeFileSync(join(directory,'failure.json'),JSON.stringify({status:'failed',reason:e instanceof Error?e.message:'unknown failure',modelCalls:0}),{flag:'wx',mode:0o600});
    throw e;
  }
}

export function verifyReplay(directory:string) {
  const reservation=JSON.parse(readFileSync(join(directory,'reservation.json'),'utf8'));
  const {frozen,inputs}=JSON.parse(readFileSync(join(directory,'inputs.json'),'utf8'));
  const actual=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));
  if(reservation.inputDigest!==digestOf(inputs)) throw Error('reserved input digest mismatch');
  register(frozen,inputs,false);
  const expected=replay(frozen,inputs);
  if(digestOf(actual)!==digestOf(expected)) throw Error('replay report mismatch');
  return {status:'verified-authored-only',reportDigest:digestOf(expected),modelCalls:0};
}
