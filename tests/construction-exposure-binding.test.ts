import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { digestOf } from '../src/core/identity.js';
import { fixture } from '../experiments/construction/fixture.js';
import { freeze } from '../experiments/construction/contracts.js';
import { bindExposure, writeExposureBinding, verifyExposureBinding } from '../experiments/construction/exposure-binding.js';
const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
// Every PR, timestamp, commit and digest below is invented. No repository data is loaded.
function setup(){
  const config=fixture();config.repository='authored/exposure-binding-38';
  config.roster=Array.from({length:38},(_,i)=>({pr:i+1,mergedAt:new Date(Date.UTC(2024,0,i+1)).toISOString(),
    packetDigest:i===0?null:digestOf(`authored-packet-${i}`),priorRejected:i===0,missingEvidence:i===0?['authored rejection retained']:[]}));
  const roster={schemaVersion:1 as const,kind:'construction-roster-manifest' as const,origin:config.origin,repository:config.repository,
    entries:config.roster.map(row=>({...row,beforeCommit:'a'.repeat(40),afterCommit:'b'.repeat(40)}))};
  const ledger={schemaVersion:1 as const,kind:'construction-exposure-ledger' as const,origin:config.origin,repository:config.repository,
    rosterDigest:digestOf(roster),declaredAt:config.exposure.declaredAt,firstRemainingSourceAt:null as string|null,firstW1At:null as string|null,
    entries:config.roster.map((row,i)=>({pr:row.pr,classification:i===0?'development-exposed':'remaining',
      firstSourceAt:i===0?'2026-10-12T00:00:00Z':null as string|null,evidenceDigest:digestOf(`authored-exposure-${i}`) as string|null,
      priorRejected:row.priorRejected,rejectionReason:i===0?'authored prior rejection':null,missingEvidence:row.missingEvidence}))};
  const bind=()=>{ledger.rosterDigest=digestOf(roster);config.exposure={declaredAt:ledger.declaredAt,
    firstRemainingSourceAt:ledger.firstRemainingSourceAt,firstW1At:ledger.firstW1At,auditDigest:digestOf(ledger)};return {config,roster,ledger};};
  return {config,roster,ledger,bind};
}
it('binds all 38 synthetic slots, keeping prior rejection and development exposure without claiming readiness',()=>{
  const f=setup(),report=bindExposure(f.bind());
  expect(report).toMatchObject({status:'bound-declarations-only',executionReady:false,empiricalAdmission:false,modelCalls:0,independentLabels:0});
  expect(report.rows).toHaveLength(38);
  expect(report.rows[0]).toMatchObject({disposition:'prior_rejected',classification:'development-exposed',packetDigest:null,
    missingEvidence:['authored rejection retained'],sourceBytesVerified:false,exposureAuthenticated:false});
});
it.each(['omit','duplicate','reorder','extra'] as const)('rejects %s ledger slots even when all digests are recomputed',mode=>{
  const f=setup();
  if(mode==='omit')f.ledger.entries.pop();
  if(mode==='duplicate')f.ledger.entries[1]={...f.ledger.entries[0]};
  if(mode==='reorder')f.ledger.entries.reverse();
  if(mode==='extra')f.ledger.entries.push({...f.ledger.entries[0],pr:999});
  expect(()=>bindExposure(f.bind())).toThrow('every roster slot');
});
it('rejects roster changes, lost prior rejections and missing-evidence substitution',()=>{
  const f=setup();f.roster.entries.pop();expect(()=>bindExposure(f.bind())).toThrow('ordered roster');
  const g=setup();g.ledger.entries[0].priorRejected=false;expect(()=>bindExposure(g.bind())).toThrow('rejection or missing');
  const h=setup();h.ledger.entries[0].missingEvidence=[];expect(()=>bindExposure(h.bind())).toThrow('rejection or missing');
});
it('rejects stale digests, different repository/origin and false summary chronology',()=>{
  const f=setup(),input=f.bind();f.roster.entries[0].afterCommit='c'.repeat(40);
  expect(()=>bindExposure(input)).toThrow('digest mismatch');
  const g=setup();g.ledger.repository='authored/other';expect(()=>bindExposure(g.bind())).toThrow('repository or origin');
  const h=setup();h.ledger.origin='development-public-source';expect(()=>bindExposure(h.bind())).toThrow('repository or origin');
  const j=setup();j.ledger.firstRemainingSourceAt='2026-10-12T00:00:00Z';expect(()=>bindExposure(j.bind())).toThrow('chronology summary');
});
it('retains unknown/missing cases as incomplete rather than dropping rows or inventing evidence',()=>{
  const f=setup();f.ledger.entries[1].classification='unknown';f.ledger.entries[1].evidenceDigest=null;
  f.config.roster[2].packetDigest=null;f.roster.entries[2].packetDigest=null;
  const report=bindExposure(f.bind());
  expect(report.status).toBe('incomplete');expect(report.rows).toHaveLength(38);
  expect(report.blockers).toEqual(['PR 2: exposure unknown','PR 2: exposure evidence missing','PR 3: source packet incomplete']);
});
it('checks declared exposure times and retains W1 exposure as a blocker using synthetic timestamps only',()=>{
  const f=setup();f.ledger.entries[0].firstSourceAt=null;expect(()=>bindExposure(f.bind())).toThrow('chronology declaration');
  const g=setup();g.ledger.entries[1].firstSourceAt='2026-10-14T00:00:00Z';g.ledger.firstRemainingSourceAt=g.ledger.entries[1].firstSourceAt;
  expect(()=>bindExposure(g.bind())).toThrow('chronology declaration');
  const h=setup();h.ledger.firstW1At='2026-10-12T00:00:00Z';
  expect(bindExposure(h.bind())).toMatchObject({status:'incomplete',blockers:['declared W1 exposure; no study authorization']});
});
it('binds a public-source declaration without enabling its freeze or pretending evidence authentication',()=>{
  const f=setup();f.config.origin=f.roster.origin=f.ledger.origin='development-public-source';
  f.config.repository=f.roster.repository=f.ledger.repository='example/public-repository';
  f.config.constructor={kind:'unconfigured',missing:['model and actual provenance unavailable']};
  expect(bindExposure(f.bind())).toMatchObject({status:'bound-declarations-only',executionReady:false});
  expect(()=>freeze(f.config,'2026-10-13T00:00:01Z')).toThrow('no empirical freeze');
});
it('CLI binds/verifies synthetic inputs and preserves failure records without overwriting output',()=>{
  const f=setup(),root=mkdtempSync(join(tmpdir(),'exposure-binding-'));roots.push(root);
  const input=join(root,'input.json');writeFileSync(input,JSON.stringify(f.bind()));
  const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx',resolve('experiments/construction/replay.ts'),...args],
    {env:{PATH:process.env.PATH},encoding:'utf8',timeout:15000}));
  const out=join(root,'success');expect(cli('bind-exposure',input,out).report.rows).toHaveLength(38);
  expect(cli('verify-exposure',out).status).toBe('verified-declarations-only');
  expect(()=>writeExposureBinding(out,f.bind())).toThrow('EEXIST');
  const report=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));report.report.executionReady=true;
  writeFileSync(join(out,'report.json'),JSON.stringify(report));expect(()=>verifyExposureBinding(out)).toThrow('mismatch');
  f.ledger.entries.pop();const failed=join(root,'failed');
  expect(()=>writeExposureBinding(failed,f.bind())).toThrow('original inputs retained');
  expect(JSON.parse(readFileSync(join(failed,'inputs.json'),'utf8')).ledger.entries).toHaveLength(37);
  expect(JSON.parse(readFileSync(join(failed,'failure.json'),'utf8')).status).toBe('failed');
},30000);

it('binds the earliest declared remaining-source time while existing freeze chronology still rejects late freezes',()=>{
  const f=setup();f.ledger.entries[1].firstSourceAt='2026-10-12T02:00:00Z';
  f.ledger.entries[2].firstSourceAt='2026-10-12T01:00:00Z';f.ledger.firstRemainingSourceAt=f.ledger.entries[2].firstSourceAt;
  expect(bindExposure(f.bind()).status).toBe('bound-declarations-only');
  expect(()=>freeze(f.config,'2026-10-13T00:00:01Z')).toThrow('source exposure before configuration freeze');
});
