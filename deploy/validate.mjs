/** Static checks only. This is not a Kustomize renderer or Kubernetes schema validator. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';

const defaultRoot = dirname(fileURLToPath(import.meta.url));
export function validateDeployment(root = defaultRoot) {
function walk(path) {
  return readdirSync(path).flatMap(name => {
    const file = resolve(path, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}
const documents = [];
for (const path of walk(root).filter(path => /\.ya?ml$/.test(path))) {
  for (const parsed of parseAllDocuments(readFileSync(path, 'utf8'), { uniqueKeys: true })) {
    assert.equal(parsed.errors.length, 0, `${relative(root, path)}: ${parsed.errors.map(x => x.message).join('; ')}`);
    const doc = parsed.toJS();
    assert.ok(doc && doc.apiVersion && doc.kind, `Missing type in ${path}`);
    documents.push({ path, doc });
    if (['Kustomization', 'Component'].includes(doc.kind)) {
      for (const local of [...(doc.resources ?? []), ...(doc.components ?? []), ...(doc.patches ?? []).map(x => x.path)]) {
        assert.ok(local && existsSync(resolve(dirname(path), local)), `Missing local reference: ${path} -> ${local}`);
        assert.ok(!/^https?:/.test(local), 'Remote Kustomize resources are not pinned or permitted here');
      }
    }
    if (doc.kind === 'Service') assert.equal(doc.spec.type, 'ClusterIP');
    if (doc.kind === 'Secret') {
      assert.ok(doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) && Object.keys(doc.data).length === 0, 'Examples must contain no credentials');
      assert.ok(doc.stringData === undefined || (doc.stringData && typeof doc.stringData === 'object' && !Array.isArray(doc.stringData) && Object.keys(doc.stringData).length === 0), 'Examples must contain no stringData credentials');
    }
    if (doc.kind === 'Deployment' && doc.spec?.template?.spec?.containers?.[0]?.image) {
      assert.equal(doc.spec.replicas, 1);
      assert.equal(doc.spec.strategy.type, 'Recreate');
      const pod = doc.spec.template.spec;
      assert.equal(pod.automountServiceAccountToken, false);
      assert.equal(pod.securityContext.runAsNonRoot, true);
      assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
      for (const c of pod.containers) {
        assert.equal(c.securityContext.allowPrivilegeEscalation, false);
        assert.equal(c.securityContext.readOnlyRootFilesystem, true);
        assert.deepEqual(c.securityContext.capabilities.drop, ['ALL']);
        assert.ok(!c.securityContext.privileged);
        for (const type of ['requests', 'limits']) {
          for (const unit of ['cpu', 'memory', 'ephemeral-storage']) assert.ok(c.resources[type][unit]);
        }
        assert.ok(c.startupProbe && c.readinessProbe && c.livenessProbe);
      }
      assert.ok(pod.volumes.every(v => !v.hostPath), 'Host paths must not be mounted');
    }
  }
}
function docAt(path, kind) {
  return documents.find(x => x.path === resolve(root, path) && x.doc.kind === kind)?.doc;
}
const config = docAt('base/configmap.yaml', 'ConfigMap');
assert.equal(config.data.QE_ENABLE_MODEL, 'false');
assert.equal(config.data.QE_S3_ENABLED, 'false');
assert.equal(config.data.QE_CODEX_AUTH_MODE, 'account');
assert.equal(config.data.QE_CODEX_HOME, '/codex-home');
assert.equal(config.data.QE_CODEX_MODEL, '');
const worker = docAt('base/worker.yaml', 'Deployment');
assert.equal(worker.spec.template.spec.securityContext.runAsUser, 10001);
assert.ok(worker.spec.template.spec.terminationGracePeriodSeconds >= 180);
const mount = worker.spec.template.spec.containers[0].volumeMounts.find(v => v.mountPath === '/codex-home');
assert.ok(mount && !mount.readOnly, 'Account refresh state must remain writable');
assert.deepEqual(docAt('base/codex-home-pvc.yaml', 'PersistentVolumeClaim').spec.accessModes, ['ReadWriteOnce']);
const dev = docAt('overlays/single-node-dev/kustomization.yaml', 'Kustomization');
assert.ok(!dev.components.some(path => path.includes('model-egress')), 'Dev must not enable model network automatically');
assert.equal(docAt('overlays/single-node-dev/configmap.yaml', 'ConfigMap').data.QE_S3_ALLOW_INSECURE, 'true');
const deny = documents.find(x => x.doc.kind === 'NetworkPolicy' && x.doc.metadata.name === 'default-deny').doc;
assert.deepEqual(deny.spec.podSelector, {});
assert.deepEqual(deny.spec.policyTypes, ['Ingress', 'Egress']);
assert.equal(deny.spec.egress, undefined);
validateRenderedDocuments(documents.filter(x => x.path.includes('/base/') && !['Kustomization', 'Component'].includes(x.doc.kind)).map(x => x.doc), 'base', false);
console.log(`PASS: ${documents.length} YAML documents parsed; local references, offline defaults, secret-free templates, workload hardening and single-runner invariants verified.`);
console.log('NOT VERIFIED HERE: Kustomize rendering, Kubernetes API schemas/admission, image builds, cluster startup, network enforcement, live credentials/inference, backups or crash recovery.');

}

// Project-specific structural contract; deliberately not the full Kubernetes API schema.
const resources = z.object({requests:z.object({cpu:z.string().min(1),memory:z.string().min(1),'ephemeral-storage':z.string().min(1)}),
 limits:z.object({cpu:z.string().min(1),memory:z.string().min(1),'ephemeral-storage':z.string().min(1)})});
const workerSchema = z.object({apiVersion:z.literal('apps/v1'),kind:z.literal('Deployment'),
 metadata:z.object({name:z.literal('flyrewheel-worker')}),spec:z.object({replicas:z.literal(1),
 strategy:z.object({type:z.literal('Recreate')}),template:z.object({spec:z.object({
 containers:z.array(z.object({name:z.string(),image:z.string().min(1),command:z.array(z.string()),
 resources,startupProbe:z.object({httpGet:z.object({path:z.literal('/healthz'),port:z.literal('health')})}),
 readinessProbe:z.object({httpGet:z.object({path:z.literal('/readyz'),port:z.literal('health')})}),
 livenessProbe:z.object({httpGet:z.object({path:z.literal('/healthz'),port:z.literal('health')})}),
 envFrom:z.array(z.object({configMapRef:z.object({name:z.string()})})),
 env:z.array(z.object({name:z.string(),valueFrom:z.object({secretKeyRef:z.object({name:z.string(),key:z.string()})})})),
 ports:z.array(z.object({name:z.string(),containerPort:z.number().int().positive()}))})).length(1)})})})});
export function validateRenderedDocuments(documents, profile, rendered = true) {
 assert.ok(['base','single-node-dev'].includes(profile), 'Unknown deployment profile');
 const keys=new Set();
 for(const doc of documents){
  assert.ok(doc && typeof doc.apiVersion==='string' && typeof doc.kind==='string' && typeof doc.metadata?.name==='string', 'Invalid manifest identity');
  assert.ok(!['Kustomization','Component'].includes(doc.kind), 'Input must contain resource documents');
  const key=`${doc.apiVersion}/${doc.kind}/${doc.metadata?.namespace??''}/${doc.metadata.name}`;
  assert.ok(!keys.has(key), 'Duplicate resource identity');keys.add(key);
  if(rendered && doc.kind!=='Namespace')assert.equal(doc.metadata.namespace,'flyrewheel','Namespace transformer missing');
 }
 const find=(kind,name)=>{const matches=documents.filter(x=>x.kind===kind&&x.metadata.name===name);assert.equal(matches.length,1,`Expected one ${kind}/${name}`);return matches[0];};
 const worker=find('Deployment','flyrewheel-worker');
 assert.ok(workerSchema.safeParse(worker).success,'Worker project schema mismatch');
 for(const [key,value] of Object.entries(worker.spec.selector?.matchLabels??{}))
  assert.equal(worker.spec.template.metadata?.labels?.[key],value,'Deployment selector does not match Pod labels');
 assert.ok(Object.keys(worker.spec.selector?.matchLabels??{}).length>0,'Worker selector required');
 const container=worker.spec.template.spec.containers[0];
 assert.deepEqual(container.command,['node','dist/worker.js'],'Queue image entrypoint contract mismatch');
 assert.equal(container.name,'worker');
 assert.deepEqual(container.ports,[{name:'health',containerPort:8080}]);
 assert.ok(container.envFrom.some(x=>x.configMapRef.name==='flyrewheel-config'));
 const config=find('ConfigMap','flyrewheel-config').data;
 assert.equal(config.PORT,'8080');assert.equal(config.QE_ENABLE_MODEL,'false');
 assert.equal(config.QE_CODEX_MODEL,'');assert.equal(config.QE_S3_ENABLED,profile==='base'?'false':'true');
 const db=container.env.find(x=>x.name==='DATABASE_URL');
 assert.deepEqual(db?.valueFrom.secretKeyRef,{name:'flyrewheel-runtime',key:'DATABASE_URL'});
 const service=find('Service','flyrewheel-worker');
 assert.equal(service.spec.type,'ClusterIP');assert.deepEqual(service.spec.selector,worker.spec.selector.matchLabels);
 assert.equal(service.spec.ports[0].targetPort,'health');
 assert.ok(!documents.some(x=>x.kind==='Secret'),'Secret examples must not be included in rendered profiles');
 if(profile==='single-node-dev'){
  for(const [env,key] of [['QE_S3_ACCESS_KEY_ID','AWS_ACCESS_KEY_ID'],['QE_S3_SECRET_ACCESS_KEY','AWS_SECRET_ACCESS_KEY']])
   assert.deepEqual(container.env.find(x=>x.name===env)?.valueFrom.secretKeyRef,{name:'flyrewheel-s3',key});
  assert.equal(config.QE_S3_ENDPOINT,'http://flyrewheel-s3:8333');
  assert.equal(find('Deployment','flyrewheel-postgres').spec.template.spec.containers[0].image,'postgres:17.11-bookworm');
  assert.equal(find('Deployment','flyrewheel-s3').spec.template.spec.containers[0].image,'chrislusf/seaweedfs:4.48');
 }
 return {profile,documents:documents.length,contract:'project-only',applicationRuntime:'blocked'};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [mode,profile,path]=process.argv.slice(2);
 if(mode==='--rendered'){
  assert.ok(path,'Usage: --rendered base|single-node-dev FILE');
  const docs=parseAllDocuments(readFileSync(path,'utf8'),{uniqueKeys:true}).map(doc=>{assert.equal(doc.errors.length,0,'Invalid rendered YAML');return doc.toJS();});
  console.log(JSON.stringify(validateRenderedDocuments(docs,profile)));
  console.log('Project contract only: Kubernetes API schema/admission and live behavior remain unverified.');
 }else{assert.equal(mode,undefined,'Unknown argument');validateDeployment();}
}
