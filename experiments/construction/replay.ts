import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { freeze, readiness } from './contracts.js';
import { registeredInputs } from './registry.js';
import { fixture } from './fixture.js';
import { writeReplay, verifyReplay } from './runner.js';
import { writeExposureBinding, verifyExposureBinding } from './exposure-binding.js';
import { lockScreening, finalizeScreening, recoverScreening } from './screening.js';
import { registerEpisodeIndex, finalizeRegisteredEpisode, recoverRegisteredEpisode } from './episode-registry.js';
import { screenedFamilies } from './family-provenance.js';
import { parseUniqueJson } from './raw-response.js';
function readScreeningInput(path:string){
  if(statSync(path).size>8_000_000)throw Error('screening input exceeds byte budget');
  return parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)),8_000_000);
}
const [command,...args]=process.argv.slice(2);
if(command==='authored' && args.length===1){
  const config=fixture();
  const report=writeReplay(args[0],freeze(config,'2026-10-13T00:00:01Z'),[
    {pr:1,packetDigest:config.roster[0].packetDigest,outcome:'completed',candidates:[]},
  ]);
  console.log(JSON.stringify(report,null,2));
} else if(command==='episode-index' && args.length===1){
  const request=readScreeningInput(args[0]) as {plan:unknown;rawCells:unknown[];lockedAt:string};
  if(!request || typeof request!=='object' || Object.keys(request).sort().join(',')!=='lockedAt,plan,rawCells' || !Array.isArray(request.rawCells))throw Error('episode index requires plan, rawCells and lockedAt');
  console.log(JSON.stringify(registerEpisodeIndex(request.plan,request.rawCells,request.lockedAt),null,2));
} else if(command==='episode-finalize' && args.length===2){
  const feedback=readScreeningInput(args[1]);if(!Array.isArray(feedback))throw Error('episode feedback must be an array');
  console.log(JSON.stringify(finalizeRegisteredEpisode(args[0],feedback),null,2));
} else if(command==='episode-recover' && args.length===1){
  console.log(JSON.stringify(recoverRegisteredEpisode(args[0]),null,2));
} else if(command==='screen-families' && args.length===1){
  console.log(JSON.stringify(screenedFamilies(args[0]),null,2));
} else if(command==='screen-lock' && args.length===1){
  const request=readScreeningInput(args[0]) as {plan:unknown;lockedAt:string};
  if(!request || typeof request!=='object' || Object.keys(request).sort().join(',')!=='lockedAt,plan')throw Error('screening lock requires plan and lockedAt');
  console.log(JSON.stringify(lockScreening(request.plan,request.lockedAt),null,2));
} else if(command==='screen-finalize' && args.length===2){
  const results=readScreeningInput(args[1]);if(!Array.isArray(results))throw Error('screening results must be an array');
  console.log(JSON.stringify(finalizeScreening(args[0],results),null,2));
} else if(command==='screen-recover' && args.length===1){
  console.log(JSON.stringify(recoverScreening(args[0]),null,2));
} else if(command==='bind-exposure' && args.length===2){
  if(statSync(args[0]).size>8_000_000)throw Error('binding envelope exceeds byte budget');
  const input=parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(args[0])),8_000_000);
  console.log(JSON.stringify(writeExposureBinding(args[1],input),null,2));
} else if(command==='verify-exposure' && args.length===1){
  console.log(JSON.stringify(verifyExposureBinding(args[0]),null,2));
} else if(command==='raw' && args.length===2){
  if(statSync(args[0]).size>8_000_000)throw Error('raw import envelope exceeds byte budget');
  const bytes=readFileSync(args[0]);
  const input=parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),8_000_000) as {frozen:unknown;inputs:unknown[]};
  if(!input || typeof input!=='object' || Object.keys(input).sort().join(',')!=='frozen,inputs' || !Array.isArray(input.inputs) ||
    input.inputs.some(r=>!r || typeof r!=='object' || !('rawResponse' in r)))throw Error('raw import requires frozen and raw-response inputs');
  console.log(JSON.stringify(writeReplay(args[1],input.frozen,input.inputs),null,2));
} else if(command==='recover' && args.length===2){
  const {frozen,inputs}=registeredInputs(args[0]);
  console.log(JSON.stringify(writeReplay(args[1],frozen,inputs),null,2));
} else if(command==='verify' && args.length===1){
  console.log(JSON.stringify(verifyReplay(args[0]),null,2));
} else if(command==='check' && args.length===1){
  const result=readiness(JSON.parse(readFileSync(args[0],'utf8')));
  console.log(JSON.stringify(result,null,2));if(result.status==='blocked')process.exitCode=2;
} else if(command==='draft' && args.length===1){
  const config=fixture();
  config.origin='development-public-source';config.repository='UNCONFIGURED';
  config.constructor={kind:'unconfigured',missing:['provider/model/version/seed/decoding not selected','real protocol, instructions and complete W0 roster not bound']};
  config.exposure.auditDigest=null;
  // Explicit draft retains authored placeholders; it is not a real W0 configuration.
  const output={...config};
  writeFileSync(args[0],JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});
} else throw Error('Usage: replay.ts episode-index REQUEST_JSON | episode-finalize REPOSITORY FEEDBACK_JSON | episode-recover REPOSITORY | screen-families REPOSITORY | screen-lock REQUEST_JSON | screen-finalize REPOSITORY RESULTS_JSON | screen-recover REPOSITORY | bind-exposure INPUT_JSON NEW_DIRECTORY | verify-exposure DIRECTORY | raw INPUT_JSON NEW_DIRECTORY | authored NEW_DIRECTORY | recover REPOSITORY NEW_DIRECTORY | verify DIRECTORY | draft NEW_FILE | check CONFIG_FILE');
