import {describe,it,expect} from 'vitest';
import {readFileSync,readdirSync,mkdtempSync,cpSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseAllDocuments,stringify} from 'yaml';
const root=fileURLToPath(new URL('..',import.meta.url));
const validator=await import(pathToFileURL(resolve(root,'deploy/validate.mjs')).href);
const parse=(text:string)=>parseAllDocuments(text).map(doc=>doc.toJS());
function base(){return readdirSync(resolve(root,'deploy/base')).filter(x=>x.endsWith('.yaml')&&x!=='kustomization.yaml').flatMap(x=>parse(readFileSync(resolve(root,'deploy/base',x),'utf8')));}
function worker(docs:any[]){return docs.find(x=>x.kind==='Deployment');}
it('checks the source base project schema without pretending it is rendered',()=>{
 expect(validator.validateRenderedDocuments(base(),'base',false)).toMatchObject({contract:'project-only',applicationRuntime:'blocked'});
});
it.each(['command','port','database','model','resources','readiness','selector','pod-label'])('rejects broken %s deployment contract',kind=>{
 const docs=base(),w=worker(docs),c=w.spec.template.spec.containers[0];
 if(kind==='command')c.command=['node','dist/workspace-worker-entrypoint.js'];
 if(kind==='port')c.ports[0].containerPort=9000;
 if(kind==='database')c.env[0].name='PG_URL';
 if(kind==='model')docs.find(x=>x.kind==='ConfigMap').data.QE_ENABLE_MODEL='true';
 if(kind==='resources')delete c.resources.limits.memory;
 if(kind==='readiness')c.readinessProbe.httpGet.path='/ready';
 if(kind==='pod-label')w.spec.template.metadata.labels={app:'wrong'};
 if(kind==='selector')docs.find(x=>x.kind==='Service').spec.selector={'app':'wrong'};
 expect(()=>validator.validateRenderedDocuments(docs,'base',false)).toThrow();
});
it('requires actual renderer namespace transforms and unique resource identities',()=>{
 const docs=base();expect(()=>validator.validateRenderedDocuments(docs,'base')).toThrow();
 for(const d of docs)if(d.kind!=='Namespace')d.metadata.namespace='flyrewheel';
 expect(validator.validateRenderedDocuments(docs,'base').documents).toBe(docs.length);
 expect(()=>validator.validateRenderedDocuments([...docs,docs[0]],'base')).toThrow();
});
it('rejects plaintext stringData in example templates without including values in errors',()=>{
 const temp=mkdtempSync(join(tmpdir(),'deploy-contract-'));
 try{
  cpSync(resolve(root,'deploy'),join(temp,'deploy'),{recursive:true});
  const path=join(temp,'deploy/examples/secrets.example.yaml');
  writeFileSync(path,stringify({apiVersion:'v1',kind:'Secret',metadata:{name:'fixture'},data:{},stringData:{key:'fixture-sensitive-value'}}));
  let failure:unknown;try{validator.validateDeployment(join(temp,'deploy'));}catch(e){failure=e;}
  expect(failure).toBeDefined();expect(String(failure)).toContain('stringData');expect(String(failure)).not.toContain('fixture-sensitive-value');
 }finally{rmSync(temp,{recursive:true,force:true});}
});
it('rejects non-object Secret data rather than treating an empty array as valid',()=>{
 const temp=mkdtempSync(join(tmpdir(),'deploy-contract-'));
 try{cpSync(resolve(root,'deploy'),join(temp,'deploy'),{recursive:true});
 writeFileSync(join(temp,'deploy/examples/secrets.example.yaml'),stringify({apiVersion:'v1',kind:'Secret',metadata:{name:'fixture'},data:[]}));
 expect(()=>validator.validateDeployment(join(temp,'deploy'))).toThrow();
 }finally{rmSync(temp,{recursive:true,force:true});}
});
// Use the real installed renderer if available, never a home-grown YAML merger.
// No kubeconfig, context, API request, apply, login, or cluster connection is used.
const renderer=spawnSync('kubectl',['version','--client=true'],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH!,KUBECONFIG:'/nonexistent/flyrewheel-offline'}}).status===0?'kubectl'
 :spawnSync('kustomize',['version'],{encoding:'utf8',timeout:10000}).status===0?'kustomize':undefined;
describe.skipIf(!renderer)('installed Kustomize render contract (offline)',()=>{
 for(const profile of ['base','single-node-dev'])it(`renders ${profile} with the real tool`,()=>{
  const path=resolve(root,profile==='base'?'deploy/base':'deploy/overlays/single-node-dev');
  const result=spawnSync(renderer!,[renderer==='kubectl'?'kustomize':'build',path],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,
   env:{PATH:process.env.PATH!,KUBECONFIG:'/nonexistent/flyrewheel-offline'}});
  expect(result.status,result.stderr).toBe(0);
  expect(validator.validateRenderedDocuments(parse(result.stdout),profile).contract).toBe('project-only');
 });
});
