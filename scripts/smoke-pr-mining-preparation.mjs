// Synthetic PR evidence only. No network, model invocation, or real feedback.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { QualEvoStore } from '../dist/storage/store.js';
import { HISTORY_NOTES } from '../dist/github-pr-history.js';
import { digestOf } from '../dist/core/identity.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'pr-mining-preparation-')),db=join(directory,'db'),commands=[];
const run=(args)=>{
 const stdout=execFileSync(process.execPath,['dist/cli.js',...args,'--db',db],{cwd:root,timeout:30000,maxBuffer:6000000}).toString();
 commands.push({args,exitCode:0,outputSha256:createHash('sha256').update(stdout).digest('hex')});
 return JSON.parse(stdout);
};
const evidence=JSON.parse(await readFile(join(root,'examples/pr-mining-evidence.json'),'utf8'));
run(['github-pr','import','--file','examples/pr-mining-evidence.json']);
const choices=run(['mining','choices','--evidence-digest',evidence.digest]);
assert.equal(choices.sources.length,2);assert.equal(choices.statements.length,4);
const authored=['--id','prepared-cli','--rule-id','fixture-mined-rule','--rule-version','draft-1','--objective','Inspect selected synthetic sources; retain uncertainty.','--actor','synthetic-smoke','--source','fixture','--created-at','2026-10-13T00:00:00Z'];
const prepared=run(['mining','prepare','--evidence-digest',evidence.digest,...authored,'--all-captured','--statement','pull','review:20']);
assert.equal(prepared.evidenceDigest,evidence.digest);assert.equal(prepared.sources.length,2);
assert.deepEqual(run(['mining','list']),[]); // Preparation must not freeze anything.
const file=join(directory,'request.json');await writeFile(file,JSON.stringify(prepared));
const frozen=run(['mining','request','--file',file]);
assert.deepEqual(run(['mining','show','--digest',frozen.digest]),frozen);
assert.equal(frozen.request.synthesis,'not_run');
assert.equal(frozen.request.sourceBindings[0].commit,evidence.evidence.snapshot.mergeBase);
assert.equal(frozen.request.sourceBindings[1].commit,evidence.evidence.snapshot.head);
// Explicit synthetic storage setup for the history-selector path; not a live capture.
const plan={schemaVersion:1,kind:'github-pr-history-plan',filter:{repository:'fixture/project',createdFrom:'2026-10-01T00:00:00Z',createdBefore:'2026-10-02T00:00:00Z',status:'all',maxPulls:25,maxPages:10},ordering:'created-ascending-then-number',
 pulls:[{number:7,url:evidence.evidence.pull.url,title:'Synthetic PR',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',state:'closed',mergedAt:'2026-10-01T00:00:00Z'}],
 discovery:{observedAt:'2026-10-01T00:00:00Z',pagesRead:1,rowsRead:1,reportedTotal:1,incompleteResults:false,searchCapReached:false,hasMore:false,stopReason:'exhausted',coverage:'all-reported-search-results-observed',notes:[...HISTORY_NOTES]}};
const batchDigest=digestOf(plan),store=await QualEvoStore.openPGlite(db);
try {
 const batch=await store.importGithubPrHistoryPlan({digest:batchDigest,plan,receipt:{kind:'package-integrity-only'}});
 const active={...batch.items[0],status:'capturing',attempts:1,lastAttemptAt:'2026-10-13T00:00:00Z'};
 const started=await store.updateGithubPrHistoryItem(batchDigest,batch.revision,active);
 await store.updateGithubPrHistoryItem(batchDigest,started.revision,{...active,status:'captured',evidenceDigest:evidence.digest,snapshotDigest:evidence.evidence.snapshotDigest});
} finally {await store.close();}
assert.deepEqual(run(['mining','choices','--batch',batchDigest,'--number','7']),choices);
const fromBatch=run(['mining','prepare','--batch',batchDigest,'--number','7',...authored,'--before','src/sample.ts','--after','src/sample.ts','--statement','pull','review:20']);
assert.deepEqual(fromBatch,prepared);
const linked=run(['github-pr','history','mining-request','--batch',batchDigest,'--number','7','--file',file]);assert.deepEqual(linked,frozen);
assert.deepEqual(run(['mining','show','--digest',linked.digest]),frozen);
assert.ok(run(['github-pr','history','show','--batch',batchDigest]).items[0].miningRequestDigests.includes(frozen.digest));
assert.deepEqual(run(['mining','candidates']),[]);
let expectedFailures=0;
for(const args of [
 ['--evidence-digest',evidence.digest,'--statement','pull'],
 ['--evidence-digest',evidence.digest,'--all-captured','--before','src/sample.ts','--statement','pull'],
 ['--evidence-digest',evidence.digest,'--all-captured','--statement','review:999'],
 ['--evidence-digest',evidence.digest,'--batch',batchDigest,'--number','7','--all-captured','--statement','pull'],
 ['--batch',batchDigest,'--number','99','--all-captured','--statement','pull'],
]) {
 assert.throws(()=>execFileSync(process.execPath,['dist/cli.js','mining','prepare',...authored,...args,'--db',db],{cwd:root,timeout:30000,stdio:'pipe'}),error=>error.status===1);
 expectedFailures++;
}
assert.equal(run(['mining','list']).length,1);

const report={status:'passed',sourceEvidence:'repository synthetic examples/pr-mining-evidence.json; no real vLLM PR package',historySetup:'explicit synthetic store transitions, not network capture',requestDigest:frozen.digest,evidenceDigest:evidence.digest,successfulCliCalls:commands.length,expectedRejectedCliCalls:expectedFailures,
 checks:['all evidence choices listed','explicit selections bound','prepare did not persist request','existing request freeze and separate-process show agree','history batch selects same PR evidence','existing history request links exact frozen request','no candidates created'],modelCalls:0,commands};
await writeFile(join(directory,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,directory},null,2));
