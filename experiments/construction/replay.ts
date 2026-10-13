import { readFileSync, writeFileSync } from 'node:fs';
import { freeze, readiness } from './contracts.js';
import { fixture } from './fixture.js';
import { writeReplay, verifyReplay } from './runner.js';
const [command,...args]=process.argv.slice(2);
if(command==='authored' && args.length===1){
  const config=fixture();
  const report=writeReplay(args[0],freeze(config,'2026-10-13T00:00:01Z'),[
    {pr:1,packetDigest:config.roster[0].packetDigest,outcome:'completed',candidates:[]},
  ]);
  console.log(JSON.stringify(report,null,2));
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
} else throw Error('Usage: replay.ts authored NEW_DIRECTORY | verify DIRECTORY | draft NEW_FILE | check CONFIG_FILE');
