// Compatibility evidence only: official fixed vLLM source; all judgments are authored.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digestOf } from '../dist/core/identity.js';
import { makeSnapshotAnchor, makeReviewEvidence } from '../dist/adapters/semantic-review-fixture.js';
const [directory, gitRepository, flow] = process.argv.slice(2);
if (!directory || !gitRepository || !flow) throw new Error('Usage: node scripts/verify-vllm-direct-parent.mjs <official-source-directory> <original-git-store> <new-output-directory>');
const productRoot = fileURLToPath(new URL('..', import.meta.url));
await mkdir(flow, { recursive: false });
const db=join(flow,'db'), exec=promisify(execFile), provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
const repository='github.com/vllm-project/vllm', path='vllm/utils/network_utils.py', date='2026-10-13T00:00:00Z', commands=[];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=async(name,value)=>{const file=join(flow,name);await writeFile(file,JSON.stringify(value,null,2)+'\n');return file;};
const cli=async(args,name,{text=false}={})=>{
 const result=await exec(process.execPath,['dist/cli.js',...args,'--db',db],{cwd:productRoot,timeout:40000,maxBuffer:8000000});
 commands.push({args,exitCode:0,outputFile:name??null,outputSha256:sha256(result.stdout)});
 await writeFile(join(flow,'commands.json'),JSON.stringify(commands,null,2)+'\n');
 if(name)await writeFile(join(flow,name),result.stdout);
 return text?result.stdout:JSON.parse(result.stdout);
};
const changes=[];
for(const f of provenance.files){
 const entry={status:'M'};
 for(const side of ['before','after']){
  const spec=f.sides[side],bytes=await readFile(spec.localPath);assert.equal(sha256(bytes),spec.sha256);
  entry[side]={state:'captured',path:f.path,mode:f.mode,objectId:spec.blobSha,byteLength:bytes.length,sha256:spec.sha256,bytesBase64:bytes.toString('base64')};
 }
 changes.push(entry);
}
changes.sort((a,b)=>Buffer.compare(Buffer.from(a.after.path),Buffer.from(b.after.path)));
assert.equal(provenance.base, '33b06a6f24be632e99c19cadb5004a27cf9605a0');
assert.equal(provenance.head, '953d9c820b0d8f9a55ee455814287536a498498c');
const shallowBefore = await readFile(join(gitRepository, 'shallow'), 'utf8');
const snapshot=await cli(['snapshots','capture-direct-parent','--repo',gitRepository,'--repository-id',repository,'--parent',provenance.base,'--head',provenance.head],'snapshot-captured.json');
assert.equal(snapshot.receipt.kind,'local-direct-parent-check');
assert.equal(snapshot.snapshot.comparison,'direct-parent-to-head');
assert.equal(snapshot.snapshot.evidenceScope,'verified-direct-parent-only');
assert.deepEqual(snapshot.snapshot.changes,changes);
assert.equal(await readFile(join(gitRepository, 'shallow'), 'utf8'), shallowBefore);
await assert.rejects(cli(['snapshots','capture','--repo',gitRepository,'--repository-id',repository,'--base-tip',provenance.base,'--head',provenance.head]), /requires complete local commit history/);
const imported=await cli(['snapshots','import','--file',await save('snapshot-input.json',snapshot)],'snapshot-imported.json');
assert.equal(imported.receipt.kind,'package-integrity-only'); assert.equal(imported.digest,snapshot.digest);
assert.equal(imported.snapshot.evidenceScope,'verified-direct-parent-only');
const listed=await cli(['snapshots','list'],'snapshots-list.json');
assert.equal(listed.snapshots[0].evidenceScope,'verified-direct-parent-only');
await cli(['snapshots','show','--digest',snapshot.digest],'snapshot-reopened.json');
const content=changes.find(c=>c.after.path===path).after,source=Buffer.from(content.bytesBase64,'base64').toString('utf8');
const signature='def test_loopback_bind(address: str, family: int) -> bool:';assert.ok(source.includes(signature));
const problem={id:'vllm-fixed-signature-case',lineageId:'vllm-fixed-signature-case',split:'training',expected:'safe',
 title:'Real vLLM source; authored safe expectation solely for compatibility, not independently adjudicated',repository,commit:provenance.head,path,sourceDigest:content.sha256,
 provenance:{kind:'imported',reference:`${provenance.repository}/blob/${provenance.head}/${path}`,reviewedBy:null,derivedFromCaseId:null}};
const base={schemaVersion:2,ruleId:'vllm-annotation-compatibility',version:'authored-base',
 semantics:{title:'Annotation review compatibility probe',mechanism:'Authored inspection of a Python signature',invariant:'Inspect explicit parameter and return annotations',
 applicability:['Selected network helper signature only'],exceptions:[],requiredContext:[],expectedBehavior:'Authored baseline response deliberately flags the typed signature to exercise feedback; not a real defect claim'},
 scope:{repositories:[repository],paths:{include:[path],exclude:[]}},regressionCases:[{caseId:problem.id,role:'negative'}],
 provenance:{sourceCases:[{caseId:problem.id,repository,commit:provenance.head,path,sourceDigest:content.sha256}],parentDigest:null,author:'authored-compatibility-probe',createdAt:date,
 rationale:'Explicit manual rule over authentic source, not mined by a model; no quality inference'}};
const baseStored=await cli(['rules','import','--rule',await save('base-rule.json',base),'--cases',await save('cases.json',[problem])],'base-imported.json');
const structural=await cli(['reviews','run','--rule-digest',baseStored.digest,'--snapshot-digest',snapshot.digest],'structural.json');
assert.equal(structural.coverage.targets.filter(t=>t.disposition==='captured').length,1);assert.equal(structural.coverage.targets.filter(t=>t.disposition==='out_of_scope').length,8);
const target=structural.coverage.targets.find(t=>t.path===path),start=source.indexOf(signature);
const anchor=makeSnapshotAnchor(snapshot,'after',path,start,start+signature.length),evidence=makeReviewEvidence(snapshot,anchor,'source-signature');
const response=(ruleDigest,targetId,decision)=>({schemaVersion:1,kind:'semantic-review-offline-fixtures',ruleDigest,snapshotDigest:snapshot.digest,evidence:[evidence],
 judgments:[{targetId,decision,reasoning:`Authored ${decision} response solely for real-input software compatibility; no model/human quality evidence`,evidenceRefs:[evidence.id],findingAnchors:[anchor]}]});
const baselineFile=await save('baseline-authored-response.json',response(baseStored.digest,target.id,'violation'));
const common={namespace:'local-semantic-review',scopeDigest:digestOf(base.scope),actor:'authored-compatibility-probe',source:'fixture',reason:'Explicit local-only compatibility operation; no endorsement',createdAt:date};
const apply=async(c,name)=>cli(['rules','governance','apply','--file',await save(`${name}-input.json`,{...common,...c})],`${name}.json`);
const registered=await apply({id:'vllm-base-register',ruleDigest:baseStored.digest,action:'register',expectedHeadDigest:null},'base-register');
const boot=await apply({id:'vllm-base-bootstrap',ruleDigest:baseStored.digest,action:'bootstrap-shadow',expectedHeadDigest:registered.digest},'base-shadow');
const planInput={id:'vllm-baseline-plan',repository,paths:[path],snapshotDigest:snapshot.digest,workspaceId:'offline-no-vllm-execution'};
const plan=await cli(['reviews','governed','plan','--file',await save('base-plan-input.json',planInput),'--offline-fixtures',baselineFile],'base-plan.json');
const baseRun=await cli(['reviews','governed','run','--digest',plan.digest,'--offline-fixtures',baselineFile],'base-execution.json');
const baseReview=await cli(['reviews','show','--id',baseRun.jobs[0].result.outcome.id],'base-review.json');const finding=baseReview.findings[0];
const note={id:'vllm-authored-fp',findingId:finding.id,reviewId:baseReview.id,ruleDigest:baseStored.digest,ruleVersion:base.version,source:'fixture',actor:'authored-compatibility-probe',kind:'label',label:'FP',
 reason:'Authored correction at an already annotated real signature to exercise the workflow, not real developer feedback',createdAt:date};
await cli(['feedback','add','--file',await save('feedback-input.json',note)],'feedback.json');
const discovered=await cli(['feedback','list','--rule-digest',baseStored.digest,'--source','fixture'],'feedback-list.json');assert.equal(discovered.feedback[0].id,note.id);
const request=await cli(['revisions','request','--file',await save('request-input.json',{id:'vllm-authored-request',baseRuleDigest:baseStored.digest,requestedRuleVersion:'authored-candidate',feedbackIds:[note.id],
 requestedChange:'Explicit authored clarification to avoid flagging the selected typed signature',actor:'authored-compatibility-probe',source:'fixture',createdAt:date})],'request.json');
const candidate={...base,version:'authored-candidate',semantics:{...base.semantics,exceptions:['An explicitly annotated parameter and return signature is not missing annotations'],expectedBehavior:'Authored candidate response marks the selected typed signature safe; no model quality claim'},
 provenance:{...base.provenance,parentDigest:baseStored.digest,rationale:'Manually authored compatibility candidate, not generated from feedback by a model'}};
const candidateStored=await cli(['rules','import','--rule',await save('candidate-rule.json',candidate)],'candidate-imported.json');
const candidateStructural=await cli(['reviews','run','--rule-digest',candidateStored.digest,'--snapshot-digest',snapshot.digest],'candidate-structural.json');
const candidateFile=await save('candidate-authored-response.json',response(candidateStored.digest,candidateStructural.coverage.targets.find(t=>t.path===path).id,'safe'));
const candidateReview=await cli(['reviews','run','--rule-digest',candidateStored.digest,'--snapshot-digest',snapshot.digest,'--offline-fixtures',candidateFile],'candidate-evaluation-review.json');
const comparison=await cli(['revisions','compare','--file',await save('comparison-input.json',{id:'vllm-authored-comparison',requestDigest:request.digest,candidateRuleDigest:candidateStored.digest,
 reviewPairs:[{baseReviewId:baseReview.id,candidateReviewId:candidateReview.id}],caseBindings:[{caseId:problem.id,baseReviewId:baseReview.id}]})],'comparison.json');
assert.equal(comparison.comparison.summary.status,'compatible');assert.equal(comparison.comparison.trust.semanticEvidence,'offline-fixture-declarations');
const decision=await cli(['revisions','decide','--file',await save('decision-input.json',{id:'vllm-authored-accept',comparisonDigest:comparison.digest,choice:'accept',actor:'authored-compatibility-probe',source:'fixture',
 reason:'Accept only for explicit local compatibility walkthrough; authored results are not semantic evidence of improvement',createdAt:date})],'decision.json');
const candidateRegistered=await apply({id:'vllm-candidate-register',ruleDigest:candidateStored.digest,action:'register',expectedHeadDigest:boot.digest},'candidate-register');
await apply({id:'vllm-supersede',ruleDigest:baseStored.digest,action:'supersede',expectedHeadDigest:candidateRegistered.digest,successor:{ruleDigest:candidateStored.digest,scopeDigest:digestOf(candidate.scope)},decisionDigest:decision.digest},'candidate-shadow');
const nextPlan=await cli(['reviews','governed','plan','--file',await save('next-plan-input.json',{...planInput,id:'vllm-followup-plan'}),'--offline-fixtures',candidateFile],'next-plan.json');
const nextRunArgs=['reviews','governed','run','--digest',nextPlan.digest,'--offline-fixtures',candidateFile];
const next=await cli(nextRunArgs,'next-execution.json');const review=await cli(['reviews','show','--id',next.jobs[0].result.outcome.id],'next-review.json');
assert.equal(review.ruleDigest,candidateStored.digest);assert.equal(review.snapshotDigest,snapshot.digest);assert.equal(next.jobs[0].admission.planDigest,nextPlan.digest);
assert.equal(review.config.fixtureDigest,digestOf(JSON.parse(await readFile(candidateFile,'utf8'))));assert.equal(review.executionReceipt,undefined);
assert.deepEqual(await cli(nextRunArgs,'next-reopened-execution.json'),next);
const explanation=await cli(['revisions','explain','--digest',comparison.digest,'--feedback-id',note.id,'--repository',repository,'--path',path],'explanation.json');assert.equal(explanation.localReview.eligible,true);
// Existing batch catalog/export can reference exact already-executed governed jobs; no new replay.
const batch=await cli(['reviews','batch','create','--file',await save('export-batch-input.json',{id:'vllm-governed-export',jobs:nextPlan.jobs})],'export-batch.json');
const exported=await cli(['reviews','batch','export','--digest',batch.digest],'batch-export.json');
const csv=await cli(['reviews','batch','export','--digest',batch.digest,'--format','csv'],'batch-export.csv',{text:true});
assert.equal(exported.rows[0].reviewId,review.id);assert.equal(exported.rows[0].ruleDigest,candidateStored.digest);assert.ok(csv.includes(review.id));
const history=await cli(['application-jobs','history','--file',await save('executed-job.json',nextPlan.jobs[0])],'job-history.json');assert.equal(history.recordedAttempts,1);
const report={status:'passed',testedProduct:'local direct-parent feature changes based on 74777813bcdb3087cb36b6504e85dd2849e3f198',directory:flow,source:provenance,commands,
 scope:{snapshotChangedFiles:9,capturedSides:18,capturedBytes:provenance.totalBytes,reviewedPaths:[path],outOfScopePaths:provenance.files.map(f=>f.path).filter(p=>p!==path),anchorSignature:signature,
 excludedSnapshotSides:0,otherRepositoryFiles:'all tree objects verified; unchanged blobs not required',fullRepositoryExecution:'not_performed',localGitCapture:'verified-original-direct-parent-only',snapshotReceipt:'local-direct-parent-check',historyCompleteness:'not_claimed',legacyCapture:'still_rejects_shallow_history',shallowMarker:'unchanged'},
 artifacts:{snapshotDigest:snapshot.digest,baseRuleDigest:baseStored.digest,candidateRuleDigest:candidateStored.digest,requestDigest:request.digest,comparisonDigest:comparison.digest,decisionDigest:decision.digest,
 basePlanDigest:plan.digest,followupPlanDigest:nextPlan.digest,reviewId:review.id,jobDigest:next.jobs[0].jobDigest,exportBatchDigest:batch.digest},
 checks:['all official changed paths natively captured with original parent/head SHAs and modes','source bytes checked against Git blob SHA and SHA256','one real Python file selected; eight paths explicitly out of scope',
 'governed baseline executed with authored response','feedback discovered and frozen','manual candidate evaluated and explicitly selected','followup governed review bound to exact version, snapshot and fixture',
 'restarted execution reused one attempt','JSON and CSV exported same governed review'],
 evidence:{sourceBytes:'real official vLLM GitHub commit',ruleAndCandidate:'manually authored compatibility inputs',responses:'authored offline fixtures',feedbackAndDecision:'fixture declarations, not real developer judgments',
 modelExecution:'not_run',modelSubstituteRuntime:'not_used',semanticQuality:'not_evaluated',vllmCodeExecution:'not_performed',installation:'not_performed',W1:'not_read',credentials:'no user credentials read or supplied',publication:'not_performed'}};
await save('verification.json',report);console.log(JSON.stringify({status:report.status,commands:commands.length,artifacts:report.artifacts,scope:report.scope},null,2));
