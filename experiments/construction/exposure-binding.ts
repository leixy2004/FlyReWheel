import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '../../src/core/identity.js';
import { ConfigSchema } from './contracts.js';
import { parseUniqueJson } from './raw-response.js';
const Hash=z.string().regex(/^[a-f0-9]{64}$/), Commit=z.string().regex(/^[a-f0-9]{40}$/);
const Time=z.string().datetime({offset:true}), Text=z.string().min(1).max(8192);
const Origin=z.enum(['authored-fixture','development-public-source']);
export const RosterManifestSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('construction-roster-manifest'),
  origin:Origin,repository:Text,
  entries:z.array(ConfigSchema.shape.roster.element.extend({beforeCommit:Commit,afterCommit:Commit})).min(1).max(10000),
}).strict();
export const ExposureLedgerSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('construction-exposure-ledger'),
  origin:Origin,repository:Text,rosterDigest:Hash,declaredAt:Time,
  firstRemainingSourceAt:Time.nullable(),firstW1At:Time.nullable(),
  entries:z.array(z.object({pr:z.number().int().positive(),
    classification:z.enum(['development-exposed','remaining','unknown']),firstSourceAt:Time.nullable(),
    evidenceDigest:Hash.nullable(),priorRejected:z.boolean(),rejectionReason:Text.nullable(),missingEvidence:z.array(Text),
  }).strict()).min(1).max(10000),
}).strict();
const Input=z.object({config:ConfigSchema,roster:RosterManifestSchema,ledger:ExposureLedgerSchema}).strict();

/** Validate declarations only. Never opens source paths, acquires a frame, freezes
 * a configuration, writes a construction slot, or authenticates an exposure claim. */
export function bindExposure(input:unknown){
  const {config,roster,ledger}=Input.parse(input);
  const rosterDigest=digestOf(roster),ledgerDigest=digestOf(ledger);
  if(config.repository!==roster.repository || config.repository!==ledger.repository ||
    config.origin!==roster.origin || config.origin!==ledger.origin)throw Error('repository or origin binding mismatch');
  if(config.origin==='authored-fixture' && !config.repository.startsWith('authored/'))throw Error('authored namespace required');
  if(ledger.rosterDigest!==rosterDigest || config.exposure.auditDigest!==ledgerDigest)throw Error('roster or exposure digest mismatch');
  const projected=roster.entries.map(({beforeCommit:_before,afterCommit:_after,...row})=>row);
  if(digestOf(projected)!==digestOf(config.roster))throw Error('complete ordered roster does not match configuration');
  if(ledger.entries.length!==roster.entries.length || ledger.entries.some((e,i)=>e.pr!==roster.entries[i].pr))
    throw Error('exposure ledger requires every roster slot exactly once in order');
  if(config.exposure.declaredAt!==ledger.declaredAt || config.exposure.firstRemainingSourceAt!==ledger.firstRemainingSourceAt ||
    config.exposure.firstW1At!==ledger.firstW1At)throw Error('exposure summary mismatch');
  const remainingTimes=ledger.entries.filter(e=>e.classification==='remaining' && e.firstSourceAt!==null)
    .map(e=>e.firstSourceAt!).sort((a,b)=>Date.parse(a)-Date.parse(b));
  if((remainingTimes[0]??null)!==ledger.firstRemainingSourceAt)throw Error('remaining-source chronology summary mismatch');
  const blockers:string[]=[];
  if(ledger.firstW1At!==null && Date.parse(ledger.firstW1At)>Date.parse(ledger.declaredAt))throw Error('invalid W1 chronology declaration');
  if(ledger.firstW1At!==null)blockers.push('declared W1 exposure; no study authorization');
  const rows=roster.entries.map((row,i)=>{
    const exposure=ledger.entries[i];
    if(exposure.priorRejected!==row.priorRejected || digestOf(exposure.missingEvidence)!==digestOf(row.missingEvidence))
      throw Error('rejection or missing-evidence binding mismatch');
    if(row.priorRejected !== (exposure.rejectionReason!==null))throw Error('rejection reason required only for rejected slots');
    if(exposure.classification==='development-exposed' && exposure.firstSourceAt===null ||
      exposure.classification==='unknown' && exposure.firstSourceAt!==null ||
      exposure.firstSourceAt!==null && Date.parse(exposure.firstSourceAt)>Date.parse(ledger.declaredAt))
      throw Error('invalid exposure chronology declaration');
    if(exposure.classification==='unknown')blockers.push(`PR ${row.pr}: exposure unknown`);
    if(exposure.evidenceDigest===null)blockers.push(`PR ${row.pr}: exposure evidence missing`);
    if(!row.priorRejected && (row.packetDigest===null || row.missingEvidence.length))blockers.push(`PR ${row.pr}: source packet incomplete`);
    return {...row,...exposure,disposition:row.priorRejected?'prior_rejected':exposure.classification,
      sourceBytesVerified:false,exposureAuthenticated:false};
  });
  return {kind:'construction-exposure-binding',origin:config.origin,repository:config.repository,status:blockers.length?'incomplete':'bound-declarations-only',
    configDigest:digestOf(config),rosterDigest,ledgerDigest,rows,blockers,
    executionReady:false,empiricalAdmission:false,modelCalls:0,independentLabels:0,
    limitations:['Source packet digests and commit IDs are declarations; source bytes and Git provenance are not verified.',
      'Evidence digests do not authenticate exposure history, rejection judgment or source completeness.',
      'This report does not freeze configuration or enable real-source/model execution.']};
}
export function writeExposureBinding(directory:string,input:unknown){
  const inputDigest=digestOf(input); // Require a JSON value before preserving it.
  const serialized=JSON.stringify(input,null,2)+'\n';
  if(Buffer.byteLength(serialized)>8_000_000)throw Error('binding envelope exceeds byte budget');
  mkdirSync(directory,{mode:0o700});
  writeFileSync(join(directory,'inputs.json'),serialized,{flag:'wx',mode:0o600});
  try{
    const report=bindExposure(input);
    const result={inputDigest,reportDigest:digestOf(report),report};
    writeFileSync(join(directory,'report.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    return result;
  }catch{
    writeFileSync(join(directory,'failure.json'),JSON.stringify({status:'failed',reason:'invalid roster/exposure binding',modelCalls:0})+'\n',{flag:'wx',mode:0o600});
    throw Error('invalid roster/exposure binding; original inputs retained');
  }
}
export function verifyExposureBinding(directory:string){
  const read=(name:string)=>{const path=join(directory,name);
    if(statSync(path).size>8_000_000)throw Error('binding artifact exceeds byte budget');
    return parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)),8_000_000);};
  const input=read('inputs.json'),actual=read('report.json'),report=bindExposure(input);
  const expected={inputDigest:digestOf(input),reportDigest:digestOf(report),report};
  if(digestOf(actual)!==digestOf(expected))throw Error('exposure binding report mismatch');
  return {status:'verified-declarations-only',reportDigest:expected.reportDigest,executionReady:false,empiricalAdmission:false};
}
