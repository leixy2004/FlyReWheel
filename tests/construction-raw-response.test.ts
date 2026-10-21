import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { digestOf } from '../src/core/identity.js';
import { fixture } from '../experiments/construction/fixture.js';
import { freeze } from '../experiments/construction/contracts.js';
import { bytesDigest, parseUniqueJson, validateRawResponse } from '../experiments/construction/raw-response.js';
import { replay, writeReplay, verifyReplay } from '../experiments/construction/runner.js';
import { registeredInputs, registryRoot } from '../experiments/construction/registry.js';
const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
function setup(content='guard();\noperation();\n'){
  const config=fixture();config.repository=`authored/raw-test-${randomUUID()}`;
  roots.push(join(registryRoot,digestOf({repository:config.repository})));
  const packet={schemaVersion:1,kind:'authored-construction-source-packet',repository:config.repository,pr:1,
    beforeCommit:'a'.repeat(40),afterCommit:'b'.repeat(40),files:[{path:'source.ts',side:'after',content,sha256:bytesDigest(content)}]};
  config.roster[0].packetDigest=digestOf(packet);
  const frozen=freeze(config,'2026-10-13T00:00:01Z');
  const candidate={path:'source.ts',side:'after',start:1,end:2,scope:'authored',applicability:'operation',invariant:'guard protects operation',exception:'none',requiredContext:[],quote:content};
  const raw=JSON.stringify({candidates:[candidate]});
  const receipt={pr:1,packetDigest:digestOf(packet),outcome:'completed',rawResponse:raw,sourcePacket:packet};
  const binding={repository:config.repository,pr:1,packetDigest:digestOf(packet),maxResponseBytes:16384};
  return {config,packet,frozen,candidate,raw,receipt,binding};
}
it.each(['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"nested":[{"a":1,"a":2}]}',
  '{"a":1,}','[1,]','01','true false','{"a":NaN}','"\\ud800"','[', '['.repeat(66)+'0'+']'.repeat(66)])
('rejects ambiguous or invalid JSON before parsing candidates: %s',raw=>{expect(()=>parseUniqueJson(raw)).toThrow('invalid raw JSON');});
it('accepts legal JSON without treating strings as object keys and enforces UTF-8 byte budget',()=>{
  const raw='{"a":"escaped \\\"a\\\":1","nested":[{"a":2}],"__proto__":0}';
  expect(parseUniqueJson(raw)).toEqual(JSON.parse(raw));
  expect(()=>parseUniqueJson('"é"',3)).toThrow();
  expect(parseUniqueJson('"é"',4)).toBe('é');
});
it('binds exact line bytes before retaining a provisional candidate',()=>{
  const f=setup();const report=replay(f.frozen,[f.receipt]);
  expect(report.rows[0]).toMatchObject({status:'provisional_rule',rawValidation:{status:'validated',
    rawResponseDigest:bytesDigest(f.raw),anchorValidation:'exact-pinned-line-bytes',semanticSupport:'not_assessed'}});
  expect(report.rows[0].candidates).toMatchObject([{disposition:'retained_pending_independent_admission'}]);
  expect(report).toMatchObject({modelCalls:0,independentLabels:0,empiricalAdmission:false});
});
it.each([
  {start:2,end:1},{start:0},{start:1.5},{end:Number.MAX_SAFE_INTEGER+1},{end:3},
  {path:'missing.ts'},{path:'../source.ts'},{side:'before'},{quote:'wrong bytes'},
  {quote:'guard();\noperation();'}, {invariants:['compound','rule']},
])('fails the complete slot for malformed or unsupported candidate %j',change=>{
  const f=setup();const raw=JSON.stringify({candidates:[f.candidate,{...f.candidate,...change}]});
  expect(replay(f.frozen,[{...f.receipt,rawResponse:raw}]).rows[0].status).toBe('failed');
});
it('preserves CRLF and final-line boundaries without inventing a trailing empty line',()=>{
  const f=setup('one\r\ntwo');
  expect(validateRawResponse(f.raw,f.packet,f.binding).status).toBe('validated');
  expect(validateRawResponse(JSON.stringify({candidates:[{...f.candidate,start:2,end:2,quote:'two'}]}),f.packet,f.binding).status).toBe('validated');
  const empty=setup('');
  expect(validateRawResponse(empty.raw,empty.packet,empty.binding).status).toBe('failed');
});
it('rejects packet substitution, forged content hashes and duplicate file-side identities',()=>{
  const f=setup();
  expect(validateRawResponse(f.raw,{...f.packet,afterCommit:'c'.repeat(40)},f.binding)).toMatchObject({status:'failed',reason:'source packet binding mismatch'});
  for(const files of [[{...f.packet.files[0],sha256:'0'.repeat(64)}],[f.packet.files[0],f.packet.files[0]]]){
    const packet={...f.packet,files};
    expect(validateRawResponse(f.raw,packet,{...f.binding,packetDigest:digestOf(packet)})).toMatchObject({status:'failed',reason:'invalid or ambiguous source bytes'});
  }
});
it('retains empty, interrupted and oversized responses as distinct dispositions',()=>{
  const f=setup();
  expect(replay(f.frozen,[{...f.receipt,rawResponse:'{"candidates":[]}'}]).rows.map(r=>r.status)).toEqual(['no_rule','not_run']);
  expect(replay(f.frozen,[{...f.receipt,outcome:'interrupted'}]).rows[0]).toMatchObject({status:'failed',reason:'interrupted; slot consumed'});
  expect(replay(f.frozen,[{...f.receipt,rawResponse:' '.repeat(16385)}]).rows[0]).toMatchObject({status:'failed',reason:'response byte budget exceeded; slot consumed'});
});
it('persists malformed raw bytes, refuses replacement, and recovers only the original failed attempt through the CLI',()=>{
  const f=setup(),root=mkdtempSync(join(tmpdir(),'construction-raw-'));roots.push(root);
  const receipt={...f.receipt,rawResponse:'{"candidates":[],"candidates":[]}'};
  const input=join(root,'input.json');writeFileSync(input,JSON.stringify({frozen:f.frozen,inputs:[receipt]}));
  const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx',resolve('experiments/construction/replay.ts'),...args],
    {env:{PATH:process.env.PATH},encoding:'utf8',timeout:15000}));
  const out=join(root,'first');expect(cli('raw',input,out).rows[0].status).toBe('failed');
  expect(JSON.parse(readFileSync(join(out,'inputs.json'),'utf8')).inputs[0].rawResponse).toBe(receipt.rawResponse);
  expect(cli('verify',out).status).toBe('verified-authored-only');
  expect(()=>writeReplay(join(root,'replacement'),f.frozen,[f.receipt])).toThrow('conflict');
  expect(JSON.parse(readFileSync(join(root,'replacement','failure.json'),'utf8')).status).toBe('failed');
  expect(registeredInputs(f.config.repository).inputs).toEqual([receipt]);
  const recovered=join(root,'recovered');expect(cli('recover',f.config.repository,recovered).rows[0].status).toBe('failed');
  expect(verifyReplay(recovered).status).toBe('verified-authored-only');
  const report=JSON.parse(readFileSync(join(recovered,'report.json'),'utf8'));report.rows[0].status='provisional_rule';
  writeFileSync(join(recovered,'report.json'),JSON.stringify(report));expect(()=>verifyReplay(recovered)).toThrow('mismatch');
},30000);

it('round-trips successful raw receipts through persistence with deterministic cap and raw-text tamper detection',()=>{
  const f=setup(),root=mkdtempSync(join(tmpdir(),'construction-raw-valid-'));roots.push(root);
  const response=JSON.stringify({candidates:[{...f.candidate,invariant:'second invariant'},f.candidate,f.candidate]});
  const receipt={...f.receipt,rawResponse:response},out=join(root,'run');
  const report=writeReplay(out,f.frozen,[receipt]);
  expect(report.rows[0].candidates).toHaveLength(3);
  expect(report.rows[0].candidates.filter(c=>c && typeof c==='object' && 'disposition' in c && c.disposition==='retained_pending_independent_admission')).toHaveLength(1);
  expect(verifyReplay(out).status).toBe('verified-authored-only');
  const saved=JSON.parse(readFileSync(join(out,'inputs.json'),'utf8'));saved.inputs[0].rawResponse+=' ';
  writeFileSync(join(out,'inputs.json'),JSON.stringify(saved));expect(()=>verifyReplay(out)).toThrow('reserved input digest mismatch');
});
