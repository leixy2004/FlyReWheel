import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { digestOf } from '../../src/core/identity.js';
import { DigestSchema } from '../../src/core/model.js';
import { validateFreeze } from './contracts.js';
const Text=z.string().min(1).max(8192);
const Candidate=z.object({path:Text.refine(p=>!p.startsWith('/') && !p.includes('\\') && p.split('/').every(s=>s && s!=='.' && s!=='..')),
  side:z.enum(['before','after']),start:z.number().int().positive(),end:z.number().int().positive(),
  scope:Text,applicability:Text,invariant:Text,exception:Text,requiredContext:z.array(Text),
}).strict().refine(c=>c.end>=c.start,'invalid span');
const Receipt=z.object({pr:z.number().int().positive(),packetDigest:DigestSchema,
  outcome:z.enum(['completed','interrupted']),candidates:z.array(z.unknown()),
}).strict();
export function replay(frozen:unknown, inputs:unknown[]) {
  const f=validateFreeze(frozen);
  // This runner consumes authored objects only, never untrusted raw JSON or model responses.
  const receipts=inputs.map(x=>Receipt.parse(x));
  if(new Set(receipts.map(r=>r.pr)).size!==receipts.length) throw Error('duplicate attempt; no retries');
  if(receipts.some(r=>!f.config.roster.some(p=>p.pr===r.pr&&!p.priorRejected))) throw Error('out-of-roster or previously rejected attempt');
  const eligible=f.config.roster.filter(p=>!p.priorRejected);
  if(receipts.some((r,i)=>r.pr!==eligible[i]?.pr)) throw Error('attempts must follow roster prefix without skipped slots');
  if(receipts.some(r=>Buffer.byteLength(JSON.stringify(r))>f.config.limits.responseBytes)) throw Error('response byte budget exceeded');
  const rows=f.config.roster.map(p=>{
    const r=receipts.find(r=>r.pr===p.pr);
    const base={pr:p.pr,packetDigest:p.packetDigest,rawReceiptDigest:r?digestOf(r):null};
    if(p.priorRejected) return {...base,status:'prior_rejected',candidates:[]};
    if(!r) return {...base,status:'not_run',candidates:[]};
    if(r.packetDigest!==p.packetDigest) throw Error('source packet binding mismatch');
    if(r.outcome==='interrupted') return {...base,status:'failed',reason:'interrupted; slot consumed',candidates:r.candidates};
    const parsed=r.candidates.map(c=>Candidate.safeParse(c));
    if(parsed.some(c=>!c.success)) return {...base,status:'failed',reason:'malformed candidate; slot consumed',candidates:r.candidates};
    const candidates=parsed.map(c=>c.data!).sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)) ||
      (a.side===b.side?0:a.side==='before'?-1:1)||a.start-b.start||a.end-b.end||digestOf(a).localeCompare(digestOf(b)));
    return {...base,status:candidates.length?'provisional_rule':'no_rule',candidates:candidates.map((c,i)=>({candidate:c,
      disposition:i===0?'retained_pending_independent_admission':'cap_excluded',
      familyKey:digestOf({repository:f.config.repository,scope:c.scope,applicability:c.applicability,invariant:c.invariant,exception:c.exception,requiredContext:c.requiredContext})}))};
  });
  return {kind:'authored-construction-replay',freezeDigest:f.digest,rows,modelCalls:0,independentLabels:0,empiricalAdmission:false};
}
export function writeReplay(directory:string,frozen:unknown,inputs:unknown[]) {
  // An exclusive directory is the consumed attempt token. Never overwrite/retry a partial run.
  mkdirSync(directory,{mode:0o700});
  writeFileSync(join(directory,'reservation.json'),JSON.stringify({kind:'authored-replay-reservation',inputDigest:digestOf(inputs)}),{flag:'wx',mode:0o600});
  try {
    writeFileSync(join(directory,'inputs.json'),JSON.stringify({frozen,inputs},null,2),{flag:'wx',mode:0o600});
    const report=replay(frozen,inputs);
    writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    return report;
  } catch(e) {
    writeFileSync(join(directory,'failure.json'),JSON.stringify({status:'failed',reason:e instanceof Error?e.message:'unknown failure',modelCalls:0}),{flag:'wx',mode:0o600});
    throw e;
  }
}
