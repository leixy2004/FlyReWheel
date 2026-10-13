// Evidence reproduction helper: real public transport, not a product CLI transport fix.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { captureGithubPrEvidence } from '../../dist/github-pr.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (!process.argv[2]) throw new Error('Provide a new output directory');
const root=resolve(process.argv[2]),observations=[];
await mkdir(root);
const transport=fileURLToPath(new URL('./vllm-pr-public-fetch.py', import.meta.url));
const env={PATH:'/usr/bin:/bin',HOME:root+'/home',LANG:'C.UTF-8'};
for(const k of Object.keys(process.env)) if(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].includes(k.toUpperCase()))env[k]=process.env[k];
const fetch=async(input,init)=>{
 const url=String(input),headers=Object.fromEntries(new Headers(init.headers));
 if(init.method!=='GET'||headers.authorization||init.redirect!=='error'||!url.startsWith('https://api.github.com/repos/vllm-project/vllm/'))throw new Error('Unexpected public request');
 const result=await new Promise((resolve,reject)=>{
  const child=spawn('python3',[transport],{env,signal:init.signal,timeout:15000,stdio:['pipe','pipe','pipe']});
  let bytes=0;const chunks=[];child.stdout.on('data',b=>{bytes+=b.length;if(bytes>17000000){child.kill();reject(new Error('transport size exceeded'));}else chunks.push(b);});
  child.on('error',reject);child.on('close',code=>{if(code!==0)reject(new Error('Public urllib transport failed'));else{try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(e){reject(e);}}});
  child.stdin.end(JSON.stringify({url,headers}));child.stderr.resume();
 });
 const body=Buffer.from(result.body,'base64'),record={url,status:result.status,observedAt:new Date().toISOString(),bodySha256:createHash('sha256').update(body).digest('hex'),byteLength:body.length};
 observations.push(record);await writeFile(root+'/public-requests.json',JSON.stringify(observations,null,2)+'\n');
 await writeFile(root+`/response-${observations.length}.json`,body);
 return new Response(body,{status:result.status,headers:result.headers});
};
try{
 const result=await captureGithubPrEvidence({repository:'vllm-project/vllm',number:29666,maxRequests:50,expectedMerge:{mergedAt:'2025-11-28T12:40:47Z',mergeCommit:'953d9c820b0d8f9a55ee455814287536a498498c'}},{fetch});
 await writeFile(root+'/evidence.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({status:'captured',digest:result.digest,coverage:result.evidence.snapshot.coverage,requests:result.receipt.requests,discussions:Object.fromEntries(Object.entries(result.evidence.discussions).map(([k,v])=>[k,v.length]))}));
}catch(e){await writeFile(root+'/collector-error.txt',String(e));throw e;}
