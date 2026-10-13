import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf } from '../../src/core/identity.js';
import { validateFreeze } from './contracts.js';

// Independent of cwd and output directory. No CLI/API override.
export const registryRoot=fileURLToPath(new URL('../../.construction-attempts/',import.meta.url));
function directory(path:string) {
  mkdirSync(path,{recursive:true,mode:0o700});
  if(lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw Error('registry must be a real directory');
}
function read(path:string):unknown {
  if(lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw Error('registry record must be a regular file');
  return JSON.parse(readFileSync(path,'utf8'));
}
function bind(path:string,value:unknown,create:boolean) {
  if(create) {
    try {writeFileSync(path,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});return 'reserved';}
    catch(e) {if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }
  // Partial writes after process death are deliberately blocked, never overwritten.
  if(digestOf(read(path))!==digestOf(value)) throw Error('registered attempt conflict; no replacement or refreeze');
  return 'replayed';
}
export function register(frozen:unknown,inputs:unknown[],create=true) {
  const f=validateFreeze(frozen);
  const cohortKey=digestOf({repository:f.config.repository});
  const cohort=join(registryRoot,cohortKey);
  if(create){directory(registryRoot);directory(cohort);}
  else if(!existsSync(cohort))throw Error('authoritative registry missing');
  if(lstatSync(registryRoot).isSymbolicLink()||lstatSync(cohort).isSymbolicLink())throw Error('registry symlink');
  const lock=join(cohort,'.lock');
  try {mkdirSync(lock,{mode:0o700});}catch(e){
    if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('registry busy or interrupted lock; no automatic lock takeover');
    throw e;
  }
  try {
  bind(join(cohort,'freeze.json'),f,create);
  const eligible=f.config.roster.filter(p=>!p.priorRejected);
  // Validate the attempted prefix before reserving individual immutable slots.
  inputs.forEach((r,i)=>{
    if(!r || typeof r!=='object' || (r as {pr?:unknown}).pr!==eligible[i]?.pr)
      throw Error('registry requires unique ordered roster prefix');
  });
  const represented=new Set(inputs.map(r=>(r as {pr:number}).pr));
  for(const name of readdirSync(cohort)){
    const match=/^pr-(\d+)\.json$/.exec(name);
    if(match && !represented.has(Number(match[1]))) throw Error('cannot omit a previously registered attempt');
    if(!match && name!=='freeze.json' && name!=='.lock') throw Error('unexpected registry record');
  }
  const slots=inputs.map((receipt,i)=>{
    const pr=eligible[i].pr;
    const record={kind:'authored-construction-attempt',freezeDigest:f.digest,pr,
      receiptDigest:digestOf(receipt),receipt};
    const state=bind(join(cohort,`pr-${pr}.json`),record,create);
    return {pr,receiptDigest:record.receiptDigest,state};
  });
  return {cohortKey,freezeDigest:f.digest,slots};
  } finally {rmdirSync(lock);}
}

export function registeredInputs(repository:string) {
  const cohort=join(registryRoot,digestOf({repository}));
  if(lstatSync(registryRoot).isSymbolicLink()||lstatSync(cohort).isSymbolicLink())throw Error('registry symlink');
  const frozen=validateFreeze(read(join(cohort,'freeze.json')));
  if(frozen.config.repository!==repository)throw Error('registry repository mismatch');
  const inputs=frozen.config.roster.filter(p=>!p.priorRejected && existsSync(join(cohort,`pr-${p.pr}.json`)))
    .map(p=>(read(join(cohort,`pr-${p.pr}.json`)) as {receipt:unknown}).receipt);
  register(frozen,inputs,false);
  return {frozen,inputs};
}
