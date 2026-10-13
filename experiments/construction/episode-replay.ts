import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '../../src/core/identity.js';
import { registerEpisodeIndex,finalizeRegisteredEpisode,recoverRegisteredEpisode } from './episode-registry.js';
const argv=process.argv.slice(2);
if(argv[0]==='--recover'){
 if(argv.length!==3)throw Error('Usage: episode-replay.ts --recover REPOSITORY NEW_DIRECTORY');
 const recovered=recoverRegisteredEpisode(argv[1]);
 mkdirSync(argv[2],{mode:0o700});
 writeFileSync(join(argv[2],'recovery.json'),JSON.stringify(recovered,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({status:recovered.feedbackStatus,indexDigest:recovered.index.digest,empiricalAdmission:false}));
 process.exit(0);
}
const [directory,...extra]=argv;
if(!directory||extra.length)throw Error('Usage: episode-replay.ts NEW_DIRECTORY');
mkdirSync(directory,{mode:0o700});
const plan={kind:'authored-episode-selection-plan',origin:'authored-fixture',repository:'authored/episode-demo',
 frozenAt:'2026-10-13T00:00:01Z',families:[{id:'fixture-family',representativeOrder:1,ruleDigest:digestOf('authored invariant')}],
 prs:[1,2,3].map(pr=>({pr,mergedAt:`2024-01-0${pr}T00:00:00Z`,packetDigest:digestOf(`authored-packet-${pr}`)}))};
const finding={path:'fixture.py',side:'after',start:1,end:1,claim:'authored finding, not an empirical observation'};
const cells=plan.prs.map((p,i)=>({familyId:'fixture-family',ruleDigest:plan.families[0].ruleDigest,planDigest:digestOf(plan),pr:p.pr,packetDigest:p.packetDigest,
 recordedAt:'2026-10-13T00:00:02Z',status:'completed',findings:i===0?[]:[finding]}));
const lock=registerEpisodeIndex(plan,cells,'2026-10-13T00:00:03Z');
writeFileSync(join(directory,'index-lock.json'),JSON.stringify(lock,null,2)+'\n',{flag:'wx',mode:0o600});
const feedback=[{origin:'authored-fixture',indexLockDigest:lock.digest,familyId:'fixture-family',
 findingDigest:lock.indices[0].findingDigest,lockedAt:'2026-10-13T00:00:04Z',verdict:'unknown',
 otherGates:'blocked',reason:'Synthetic unresolved feedback exercises no-replacement path; not a human label'}];
writeFileSync(join(directory,'feedback.authored.json'),JSON.stringify(feedback,null,2)+'\n',{flag:'wx',mode:0o600});
const report=finalizeRegisteredEpisode(plan.repository,feedback);
writeFileSync(join(directory,'episode-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:'authored-only',indexPR:lock.indices[0].pr,episode:report.rows[0].status,
 indexDigest:lock.digest,reportDigest:digestOf(report),empiricalAdmission:false},null,2));
