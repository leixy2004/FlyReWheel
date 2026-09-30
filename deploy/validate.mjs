/** Static checks only. This is not a Kustomize renderer or Kubernetes schema validator. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const root = dirname(fileURLToPath(import.meta.url));
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
    if (doc.kind === 'Secret') assert.deepEqual(doc.data, {}, 'Examples must contain no credentials');
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
console.log(`PASS: ${documents.length} YAML documents parsed; local references, offline defaults, secret-free templates, workload hardening and single-runner invariants verified.`);
console.log('NOT VERIFIED HERE: Kustomize rendering, Kubernetes API schemas/admission, image builds, cluster startup, network enforcement, live credentials/inference, backups or crash recovery.');
