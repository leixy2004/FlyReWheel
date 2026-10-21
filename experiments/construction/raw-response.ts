import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digestOf } from '../../src/core/identity.js';
import { Candidate } from './candidate.js';

export const bytesDigest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
/** Strict JSON syntax plus decoded-key uniqueness, including escaped aliases.
 * Bounded nesting keeps hostile responses from exhausting the JS stack. */
export function parseUniqueJson(text:string, maxBytes=1_048_576):unknown {
  if(Buffer.byteLength(text)>maxBytes || Buffer.from(text).toString('utf8')!==text) throw Error('invalid raw JSON');
  let i=0;
  const bad=():never=>{throw Error('invalid raw JSON');};
  const space=()=>{while(/[\x20\t\r\n]/.test(text[i]??'x'))i++;};
  const string=():string=>{
    if(text[i]!=='"')return bad();
    const start=i++;
    while(i<text.length){
      const c=text[i++];
      if(c==='\\'){i++;continue;}
      if(c==='"'){try{const parsed=JSON.parse(text.slice(start,i));if(Buffer.from(parsed).toString('utf8')!==parsed)return bad();return parsed;}catch{return bad();}}
    }
    return bad();
  };
  const value=(depth:number):void=>{
    if(depth>64)bad();space();
    if(text[i]==='{'){
      i++;space();const keys=new Set<string>();
      if(text[i]==='}'){i++;return;}
      while(true){space();const key=string();if(keys.has(key))bad();keys.add(key);
        space();if(text[i++]!==':')bad();value(depth+1);space();
        const next=text[i++];if(next==='}')return;if(next!==',')bad();}
    }
    if(text[i]==='['){
      i++;space();if(text[i]===']'){i++;return;}
      while(true){value(depth+1);space();const next=text[i++];if(next===']')return;if(next!==',')bad();}
    }
    if(text[i]==='"'){string();return;}
    const token=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if(!token)bad();i+=token![0].length;
  };
  value(0);space();if(i!==text.length)bad();
  try{return JSON.parse(text);}catch{return bad();}
}
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
const SourceFile=z.object({path:Candidate.shape.path,side:Candidate.shape.side,
  content:z.string().max(2_000_000),sha256:Hash}).strict();
export const SourcePacketSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('authored-construction-source-packet'),
  repository:z.string().startsWith('authored/').max(8192),pr:z.number().int().safe().positive(),
  beforeCommit:z.string().regex(/^[a-f0-9]{40}$/),afterCommit:z.string().regex(/^[a-f0-9]{40}$/),
  files:z.array(SourceFile).min(1).max(256),
}).strict();
const Response=z.object({candidates:z.array(Candidate.safeExtend({quote:z.string().min(1).max(1_048_576)}))}).strict();
type CandidateValue=z.infer<typeof Candidate>;
type RawValidation={status:'validated';rawResponseDigest:string;sourcePacketDigest:string;candidates:CandidateValue[];
  anchorValidation:'exact-pinned-line-bytes';semanticSupport:'not_assessed'}|
  {status:'failed';rawResponseDigest:string;reason:string};
/** No Git/filesystem/network reads. Commit IDs are bound declarations, not provenance proof. */
export function validateRawResponse(raw:string,packet:unknown,binding:{repository:string;pr:number;packetDigest:string;maxResponseBytes:number}):RawValidation {
  const rawResponseDigest=bytesDigest(raw);
  const fail=(reason:string):RawValidation=>({status:'failed',rawResponseDigest,reason});
  if(Buffer.byteLength(raw)>binding.maxResponseBytes)return fail('response byte budget exceeded');
  let decoded:unknown;
  try{decoded=parseUniqueJson(raw,binding.maxResponseBytes);}catch{return fail('invalid or duplicate-key JSON');}
  const response=Response.safeParse(decoded);
  if(!response.success)return fail('malformed candidate or unorderable span');
  const parsed=SourcePacketSchema.safeParse(packet);
  if(!parsed.success)return fail('invalid source packet');
  const source=parsed.data;
  if(source.repository!==binding.repository || source.pr!==binding.pr || digestOf(source)!==binding.packetDigest)
    return fail('source packet binding mismatch');
  const files=new Map<string,string[]>();let total=0;
  for(const file of source.files){
    total+=Buffer.byteLength(file.content);
    const key=JSON.stringify([file.path,file.side]);
    if(total>2_000_000 || files.has(key) || Buffer.from(file.content).toString('utf8')!==file.content || bytesDigest(file.content)!==file.sha256)
      return fail('invalid or ambiguous source bytes');
    // Preserve LF/CRLF and final-newline identity. Empty files contain zero lines.
    files.set(key,file.content.match(/[^\n]*\n|[^\n]+$/g)??[]);
  }
  const candidates:CandidateValue[]=[];
  for(const candidate of response.data.candidates){
    const lines=files.get(JSON.stringify([candidate.path,candidate.side]));
    if(!lines || candidate.end>lines.length || lines.slice(candidate.start-1,candidate.end).join('')!==candidate.quote)
      return fail('anchor does not match pinned line bytes');
    const {quote:_quote,...value}=candidate;candidates.push(value);
  }
  return {status:'validated',rawResponseDigest,sourcePacketDigest:binding.packetDigest,candidates,
    anchorValidation:'exact-pinned-line-bytes',semanticSupport:'not_assessed'};
}
