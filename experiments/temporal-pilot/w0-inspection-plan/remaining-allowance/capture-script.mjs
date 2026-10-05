import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir='experiments/temporal-pilot/w0-inspection-plan/remaining-allowance';
const plan=JSON.parse(readFileSync('experiments/temporal-pilot/w0-inspection-plan/manifest.json'));
const prior=JSON.parse(readFileSync('experiments/temporal-pilot/w0-first-three/proxy-attempt-1/artifact-manifest.json'));
if(prior.totalUpstreamRequests!==48 || prior.budget!==50) throw Error('Budget mismatch');
const row=plan.rows[3]; if(row.number!==3034) throw Error('Order mismatch');
const ledger={kind:'remaining-rest-allowance-check',frozenPlanCommit:'3182b4c02045c414d22275e92c9d319f00a9fe64',number:3034,order:4,previousRequests:48,budget:50,proposalBudgetActivated:false,attempts:[],status:'reserved',modelCalls:0,humanLabels:0,sourcePackageComplete:false};
const ledgerPath=dir+'/ledger.json';
writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n',{flag:'wx'});
const save=()=>writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
const endpoints=[`https://api.github.com/repos/encode/httpx/git/commits/${row.mergeCommit}`,`https://api.github.com/repos/encode/httpx/git/trees/${row.tree}`];
for(let i=0;i<endpoints.length;i++){
 const entry={requestNumber:49+i,url:endpoints[i],startedAt:new Date().toISOString(),method:'GET',purpose:i===0?'verify frozen merge commit/parents/tree':'verify pinned root tree and discover license path',status:'attempt_reserved',bytes:0};
 ledger.attempts.push(entry);save();
 try{
  const res=await fetch(entry.url,{redirect:'manual',signal:AbortSignal.timeout(60000),headers:{Accept:'application/vnd.github+json','Accept-Encoding':'identity','User-Agent':'FlyReWheel-bounded-public-research'}});
  entry.httpStatus=res.status; const chunks=[];
  for await(const chunk of res.body){entry.bytes+=chunk.length;if(entry.bytes>2*1024*1024)throw Error('response_byte_cap');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);entry.sha256=createHash('sha256').update(bytes).digest('hex');
  entry.rawResponse=`response-${49+i}.json`;writeFileSync(dir+'/'+entry.rawResponse,bytes,{flag:'wx'});
  if(res.status!==200)throw Error(`http_${res.status}`);
  const data=JSON.parse(bytes);
  if(i===0){if(data.sha!==row.mergeCommit || data.tree?.sha!==row.tree || JSON.stringify(data.parents.map(p=>p.sha))!==JSON.stringify(row.parents))throw Error('identity_mismatch');entry.identityMatches=true;}
  else {if(data.sha!==row.tree || data.truncated)throw Error('tree_identity_or_completeness');entry.identityMatches=true;entry.licenseEntries=data.tree.filter(p=>/^(LICENSE|LICENCE|COPYING)(\..*)?$/i.test(p.path)).map(({path,sha,type,size})=>({path,sha,type,size}));}
  entry.status='complete';
 }catch(e){entry.status='stopped';entry.error=e.code??e.message;ledger.status='stopped_on_error';}
 entry.completedAt=new Date().toISOString();ledger.totalRequests=48+ledger.attempts.length;ledger.remainingRequests=50-ledger.totalRequests;save();
 if(entry.status!=='complete')break;
}
if(ledger.status!=='stopped_on_error'){ledger.status='budget_exhausted_source_incomplete';save();}
console.log(JSON.stringify(ledger,null,2));
