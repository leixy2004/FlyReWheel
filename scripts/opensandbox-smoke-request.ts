/** Normalize Node's Request before passing it to a different undici version. */
export async function localRequest(input: RequestInfo | URL, init: RequestInit | undefined, origin: string) {
 const request=input instanceof Request?input:undefined;
 const url=new URL(request?request.url:String(input));
 if(url.origin!==origin||url.username||url.password)throw new Error('local origin required');
 const method=(init?.method??request?.method??'GET').toUpperCase();
 const headers=new Headers(request?.headers);
 new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
 const body=init?.body??(request&&method!=='GET'&&method!=='HEAD'?await request.arrayBuffer():undefined);
 if(body instanceof ArrayBuffer&&body.byteLength>65536)throw new Error('request body bound');
 return {url:url.href,init:{...init,method,headers:Object.fromEntries(headers),body,signal:init?.signal??request?.signal,redirect:'error' as const}};
}

// Trial-only safeguards. No keys or network operations are performed here.
import {constants,openSync,closeSync,readFileSync,lstatSync,fstatSync,writeFileSync,fsyncSync} from 'node:fs';
import {join,resolve} from 'node:path';
export const TRIAL_WORKER_IMAGE='sha256:005cb1a42d3fb6f9c13af3636141b076ddff317c772a4fd511c8a7655199a8ed';
export const TRIAL_EXECD_IMAGE='opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a';
export class TrialGuard {
 readonly deadline:number;
 readonly approvalReference:string;
 private claimed=false;
 private dispatched=false;
 constructor(readonly directory:string,owner:string,network:string,now=Date.now()) {
  if(resolve(directory)!==directory)throw new Error('absolute trial directory required');
  const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700)throw new Error('private trial directory required');
  const fd=openSync(join(directory,'admission.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
  let data:any;try{const file=fstatSync(fd);if(!file.isFile()||file.size>4096||(file.mode&0o777)!==0o600)throw new Error('private bounded admission required');data=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
  if(data.workerImage!==TRIAL_WORKER_IMAGE||data.execdImage!==TRIAL_EXECD_IMAGE||data.schema!==1||data.owner!==owner||data.network!==network||typeof data.approvalReference!=='string'||!data.approvalReference
   ||!Number.isSafeInteger(data.startedUnixMs)||!Number.isSafeInteger(data.deadlineUnixMs)
   ||data.startedUnixMs>now||data.deadlineUnixMs<=data.startedUnixMs||data.deadlineUnixMs-data.startedUnixMs>900000)
   throw new Error('invalid immutable admission');
  this.deadline=data.deadlineUnixMs;this.approvalReference=data.approvalReference;this.remaining(now);
 }
 remaining(now=Date.now()){const remaining=this.deadline-now;if(remaining<=0)throw new Error('trial deadline');return remaining;}
 claim(sync:(fd:number)=>void=fsyncSync){
  this.remaining();
  const fd=openSync(join(this.directory,'allocation.claim'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,'allocation-attempt-consumed\n');sync(fd);}finally{closeSync(fd);}
  const directory=openSync(this.directory,constants.O_RDONLY);try{sync(directory);}finally{closeSync(directory);}
  this.claimed=true;
 }
 dispatch(){this.remaining();if(!this.claimed||this.dispatched)throw new Error('allocation dispatch refused');this.dispatched=true;}
}
export function requestCategory(path:string){
 if(path==='/health')return 'health';
 if(path==='/v1/sandboxes')return 'sandboxes';
 if(/^\/v1\/sandboxes\/[^/]+\/proxy\/44772\/ping$/.test(path))return 'readiness';
 if(/^\/v1\/sandboxes\/[^/]+$/.test(path))return 'sandbox';
 return 'other';
}
export function errorCategory(error:unknown){
 const e=error as {name?:string;code?:string;cause?:{code?:string}};
 const code=e?.cause?.code??e?.code;
 if(code&&['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code))return 'tls';
 if(code&&['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT'].includes(code))return 'connect';
 if(e?.name==='AbortError'||e?.name==='TimeoutError')return 'abort';
 return 'other';
}
export function startupCategories(text:string){
 // Persist fixed tokens only. Input may contain arbitrary secret-bearing lines.
 const categories:string[]=[];
 if(/permission denied/i.test(text))categories.push('permission-denied');
 if(/address already in use/i.test(text))categories.push('address-in-use');
 if(/exec format error/i.test(text))categories.push('exec-format');
 if(/no such file or directory/i.test(text))categories.push('missing-file');
 if(/execd[^\n]{0,80}(?:start|listen)|(?:start|listen)[^\n]{0,80}execd/i.test(text))categories.push('execd-start-marker');
 return categories.length?categories:['unrecognized-or-no-log-evidence'];
}
export async function observeRequest<T extends {status:number}>(
 path:string,method:string,send:()=>Promise<T>,capture:()=>void,events:unknown[],
){
 const category=requestCategory(path);const start=Date.now();
 const record=(result:object)=>{if(events.length<64)events.push({category,method:['GET','POST','DELETE'].includes(method)?method:'other',elapsedMs:Date.now()-start,...result});};
 // SDK readiness cleanup happens before Sandbox.create returns.
 if(category==='sandbox'&&method==='DELETE')try{capture();}catch{}
 try{const response=await send();record({status:response.status});if(category==='readiness'&&(response.status<200||response.status>=300))try{capture();}catch{}return response;}
 catch(error){record({error:errorCategory(error)});if(category==='readiness')try{capture();}catch{}throw error;}
}
