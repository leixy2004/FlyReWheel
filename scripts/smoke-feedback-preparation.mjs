// Synthetic review and authored fixture feedback only; no actual human assessment or model call.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { digestOf } from '../dist/core/identity.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'feedback-preparation-')),db=join(directory,'db'),commands=[];
const cli=async(args,file)=>{
 const bytes=execFileSync(process.execPath,['dist/cli.js',...args,'--db',db],{cwd:root,timeout:30000,maxBuffer:6000000});
 await writeFile(join(directory,file),bytes);
 commands.push({args,exitCode:0,output:file,outputSha256:createHash('sha256').update(bytes).digest('hex')});
 return JSON.parse(bytes.toString());
};
const demo=await cli(['reviews','demo'],'synthetic-demo.json');
const review=await cli(['reviews','show','--id',demo.structuralReviewId],'structural-review.json');
const finding=review.findings[0];assert.ok(finding);
const feedbackBefore=await cli(['feedback','list'],'feedback-before.json');
const revisionsBefore=await cli(['revisions','list'],'revisions-before.json');
const governanceBefore=await cli(['rules','governance','show','--rule-id',finding.ruleId],'governance-before.json');
const authored=['--finding-id',finding.id,'--id','prepared-fixture-feedback','--kind','label','--label','FP',
 '--reason','Synthetic compatibility declaration only; not independent human feedback.','--actor','synthetic-smoke','--source','fixture','--created-at','2026-10-15T00:00:00Z'];
const prepared=await cli(['feedback','prepare',...authored],'prepared-feedback.json');
assert.equal(prepared.reviewId,review.id);assert.equal(prepared.ruleDigest,review.ruleDigest);assert.equal(prepared.ruleVersion,finding.ruleVersion);
assert.equal(prepared.source,'fixture');
assert.deepEqual(await cli(['feedback','list'],'feedback-after-prepare.json'),feedbackBefore);
assert.deepEqual(await cli(['revisions','list'],'revisions-after-prepare.json'),revisionsBefore);
assert.deepEqual(await cli(['rules','governance','show','--rule-id',finding.ruleId],'governance-after-prepare.json'),governanceBefore);
const input=join(directory,'prepared-feedback.json');
assert.deepEqual(await cli(['feedback','add','--file',input],'added.json'),prepared);
assert.deepEqual(await cli(['feedback','add','--file',input],'added-again.json'),prepared);
const inspected=await cli(['feedback','show','--id',prepared.id],'reopened-feedback.json');
assert.deepEqual(inspected.feedback,prepared);assert.equal(inspected.currentFindingVerdict,'Unknown');
assert.equal((await cli(['feedback','list','--finding-id',finding.id],'selected-feedback.json')).feedback.length,1);
const request={id:'feedback-prepare-revision',baseRuleDigest:finding.ruleDigest,requestedRuleVersion:'draft-after-prepared-feedback',feedbackIds:[prepared.id],
 requestedChange:'Inspect this explicitly authored fixture feedback; no model requested.',actor:'synthetic-smoke',source:'fixture',createdAt:'2026-10-15T00:00:00Z'};
const requestFile=join(directory,'revision-input.json');await writeFile(requestFile,JSON.stringify(request,null,2)+'\n');
const frozen=await cli(['revisions','request','--file',requestFile],'revision-frozen.json');
assert.deepEqual(frozen.request.feedbackBindings,[{id:prepared.id,digest:digestOf(prepared)}]);assert.equal(frozen.request.synthesis,'not_run');
assert.deepEqual(await cli(['revisions','show','--digest',frozen.digest],'revision-reopened.json'),frozen);
assert.deepEqual(await cli(['rules','governance','show','--rule-id',finding.ruleId],'governance-final.json'),governanceBefore);
const failures=[];
async function rejects(args,label){
 assert.throws(()=>execFileSync(process.execPath,['dist/cli.js',...args,'--db',db],{cwd:root,timeout:30000,stdio:'pipe'}),error=>error.status===1);
 failures.push({label,exitCode:1});
}
const replace=(flag,value)=>{const args=[...authored];args[args.indexOf(flag)+1]=value;return args;};
await rejects(['feedback','prepare',...replace('--finding-id',`review_finding_${'f'.repeat(64)}`)],'absent finding');
await rejects(['feedback','prepare',...replace('--kind','note')],'non-label event cannot carry a label');
await rejects(['feedback','prepare',...replace('--label','invalid')],'invalid label');
await rejects(['feedback','prepare',...replace('--source','human')],'invalid source');
await rejects(['feedback','prepare',...authored,'--rule-version','override'],'caller cannot override bound version');
const withoutSource=[...authored];withoutSource.splice(withoutSource.indexOf('--source'),2);
await rejects(['feedback','prepare',...withoutSource],'source must be explicit');
const withoutLabel=[...authored];withoutLabel.splice(withoutLabel.indexOf('--label'),2);
await rejects(['feedback','prepare',...withoutLabel],'label event requires label');
for(const [label,patch] of [['mismatched stored version',{id:'wrong-version',ruleVersion:'other'}],['conflicting duplicate event',{reason:'Different immutable content'}]]){
 const file=join(directory,label.replaceAll(' ','-')+'.json');await writeFile(file,JSON.stringify({...prepared,...patch}));
 await rejects(['feedback','add','--file',file],label);
}
assert.deepEqual((await cli(['feedback','show','--id',prepared.id],'feedback-after-rejections.json')).feedback,prepared);
const report={status:'passed',sourceEvidence:'synthetic reviews demo; selected structural finding; authored fixture feedback only',
 prepared,requestDigest:frozen.digest,feedbackBindings:frozen.request.feedbackBindings,successfulCliCalls:commands.length,expectedRejectedCliCalls:failures.length,
 checks:['exact finding/review/rule binding','prepare leaves feedback/revision/governance unchanged','add is immutable and idempotent','independent-process feedback show matches','fixture FP leaves verdict Unknown','existing revision request freezes exact feedback digest','independent-process revision show matches','no governance change'],
 actualHumanFeedback:false,modelCalls:0,commands,failures};
await writeFile(join(directory,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,directory},null,2));
