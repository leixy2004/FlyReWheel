import { mkdirSync,readFileSync,writeFileSync,lstatSync,rmdirSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf } from '../../src/core/identity.js';
import { EpisodePlanSchema,selectIndices,selectEpisodes } from './episode-selection.js';
export const episodeRegistryRoot=fileURLToPath(new URL('../../.episode-attempts/',import.meta.url));
function read(path:string):any {
 if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw Error('episode record must be a regular file');
 return JSON.parse(readFileSync(path,'utf8'));
}
function bind(path:string,value:unknown){
 try{writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
  if(digestOf(read(path))!==digestOf(value))throw Error('episode registration conflict; no reselection or replacement');}
}
function locked<T>(repository:string,create:boolean,fn:(dir:string)=>T):T{
 if(!repository.startsWith('authored/'))throw Error('only authored repository allowed');
 const dir=join(episodeRegistryRoot,digestOf({repository}));
 if(create){mkdirSync(episodeRegistryRoot,{recursive:true,mode:0o700});
  if(lstatSync(episodeRegistryRoot).isSymbolicLink())throw Error('registry symlink');
  mkdirSync(dir,{recursive:true,mode:0o700});}
 if(lstatSync(episodeRegistryRoot).isSymbolicLink()||lstatSync(dir).isSymbolicLink())throw Error('registry symlink');
 const lock=join(dir,'.lock');
 try{mkdirSync(lock,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('episode registry busy or interrupted; no takeover');throw e;}
 try{return fn(dir);}finally{rmdirSync(lock);}
}
function indexFromReservation(dir:string){
 const request=read(join(dir,'index-request.json'));
 const plan=EpisodePlanSchema.parse(request.plan);
 // Repository is checked against the registry directory as well as the embedded plan.
 if(join(episodeRegistryRoot,digestOf({repository:plan.repository}))!==dir)throw Error('repository binding mismatch');
 const index=selectIndices(plan,request.rawCells,request.lockedAt);
 bind(join(dir,'index.json'),index);return index;
}
function finishFeedback(dir:string,index:ReturnType<typeof selectIndices>){
 const request=read(join(dir,'feedback-request.json'));
 if(request.indexDigest!==index.digest)throw Error('feedback reservation index mismatch');
 try{
  const report=selectEpisodes(index,request.feedback);
  bind(join(dir,'episode-report.json'),report);return report;
 }catch(e){
  bind(join(dir,'feedback-failure.json'),{status:'failed',requestDigest:digestOf(request),reason:e instanceof Error?e.message:'unknown error'});
  throw e;
 }
}
export function registerEpisodeIndex(planInput:unknown,rawCells:unknown[],lockedAt:string){
 const plan=EpisodePlanSchema.parse(planInput);
 return locked(plan.repository,true,dir=>{
  // Reserve before selection. Invalid time/cell requests cannot be silently corrected later.
  bind(join(dir,'index-request.json'),{plan,rawCells,lockedAt});
  try{return indexFromReservation(dir);}catch(e){
   bind(join(dir,'index-failure.json'),{status:'failed',requestDigest:digestOf({plan,rawCells,lockedAt}),reason:e instanceof Error?e.message:'unknown error'});throw e;
  }
 });
}
export function finalizeRegisteredEpisode(repository:string,feedback:unknown[]){
 return locked(repository,false,dir=>{
  const index=indexFromReservation(dir);
  // Empty feedback is an explicit final missing decision, not permission to fill it later.
  bind(join(dir,'feedback-request.json'),{indexDigest:index.digest,feedback});
  return finishFeedback(dir,index);
 });
}
export function recoverRegisteredEpisode(repository:string){
 return locked(repository,false,dir=>{
  const index=indexFromReservation(dir);
  const report=existsSync(join(dir,'feedback-request.json'))?finishFeedback(dir,index):null;
  return {kind:'recovered-authored-episode',index,report,feedbackStatus:report?'finalized':'not_finalized',empiricalAdmission:false};
 });
}
