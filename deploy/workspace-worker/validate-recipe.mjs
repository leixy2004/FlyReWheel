import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { lockedCodexTarget, validateBaseReference } from './prepare-image.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const lock = JSON.parse(await read('../../package-lock.json'));

test('base requires a syntactically immutable digest, with no default tag', () => {
  // Authored fixture digest only; it does not name or certify a real image.
  assert.doesNotThrow(() => validateBaseReference(`registry.example.invalid/worker-base@sha256:${'a'.repeat(64)}`));
  for (const value of [undefined, '', 'node:22', 'node@sha256:abc', `node@sha256:${'A'.repeat(64)}`,
    `node@sha256:${'a'.repeat(64)}\n`, `node@sha256:${'a'.repeat(63)}`]) {
    assert.throws(() => validateBaseReference(value));
  }
});

test('committed lock has exact SDK, CLI, and both Linux platform pins', () => {
  assert.deepEqual(lockedCodexTarget(lock, 'linux', 'x64'), {
    platformPackage: '@openai/codex-linux-x64', target: 'x86_64-unknown-linux-musl',
  });
  assert.deepEqual(lockedCodexTarget(lock, 'linux', 'arm64'), {
    platformPackage: '@openai/codex-linux-arm64', target: 'aarch64-unknown-linux-musl',
  });
  assert.throws(() => lockedCodexTarget(lock, 'darwin', 'x64'));
  assert.throws(() => lockedCodexTarget(lock, 'linux', 'riscv64'));
});

test('version drift, missing integrity, and detached SDK/CLI dependencies fail', () => {
  for (const alter of [
    l => { l.packages[''].dependencies['@openai/codex-sdk'] = '^0.159.2'; },
    l => { l.packages['node_modules/@openai/codex'].version = '0.159.3'; },
    l => { delete l.packages['node_modules/@openai/codex-linux-x64'].integrity; },
    l => { l.packages['node_modules/@openai/codex-sdk'].dependencies['@openai/codex'] = 'latest'; },
    l => { delete l.packages['node_modules/@openai/codex'].optionalDependencies['@openai/codex-linux-x64']; },
  ]) {
    const changed = structuredClone(lock); alter(changed);
    assert.throws(() => lockedCodexTarget(changed, 'linux', 'x64'));
  }
});

test('shipped config is blocked and contains no other deployment fields', async () => {
  assert.deepEqual(JSON.parse(await read('workspace-worker.json')), { schemaVersion: 1, gateway: { kind: 'blocked' } });
});

test('wrapper uses clean environment, fixed paths, and unchanged arguments', async () => {
  const wrapper = await read('workspace-worker');
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, /umask 077/);
  assert.match(wrapper, /exec \/usr\/bin\/env -i/);
  assert.match(wrapper, /\/usr\/local\/bin\/node \/opt\/flyrewheel\/dist\/workspace-worker-entrypoint\.js "\$@"/);
  assert.doesNotMatch(wrapper, /\bnpm\b|\bcurl\b|\bwget\b|\beval\b/);
});

test('recipe keeps locked installs in build stage and root-owned non-writable runtime files', async () => {
  const dockerfile = await read('Dockerfile');
  const [build, runtime] = dockerfile.split('FROM ${WORKSPACE_WORKER_BASE_IMAGE} AS runtime');
  assert.ok(runtime);
  assert.match(build, /ARG WORKSPACE_WORKER_BASE_IMAGE\nFROM/);
  assert.match(build, /prepare-image\.mjs check-base/);
  assert.match(build, /npm ci --include=dev --include=optional --ignore-scripts/);
  assert.match(build, /prepare-image\.mjs stage-codex/);
  assert.doesNotMatch(runtime, /\bnpm (?:ci|install|prune)\b|apt-get|curl|wget/);
  assert.match(runtime, /COPY --from=build --chown=0:0 \/build\/codex \.\/codex/);
  assert.match(runtime, /chmod -R a-w \/opt\/flyrewheel/);
  assert.match(runtime, /chown 0:10001 \/run\/flyrewheel/);
  assert.match(runtime, /chmod 0750 \/run\/flyrewheel/);
  assert.match(runtime, /USER 10001:10001/);
  assert.match(runtime, /ENTRYPOINT \[\]/);
  assert.match(runtime, /CMD \["\/bin\/sleep", "infinity"\]/);
});

test('dedicated context admits the recipe inputs and rejects ambient credential paths', async () => {
  const rules = (await read('Dockerfile.dockerignore')).split('\n');
  for (const path of ['prepare-image.mjs', 'workspace-worker', 'workspace-worker.json']) {
    assert.ok(rules.includes(`!deploy/workspace-worker/${path}`));
  }
  for (const rule of ['**/.env*', '**/.npmrc', '**/auth.json', '**/.codex', '**/.aws', '**/node_modules', '**/.git']) {
    assert.ok(rules.includes(rule));
  }
  assert.ok(!rules.includes('!deploy/**'));
  assert.ok(!rules.includes('!dist/**'));
});

const exec = promisify(execFile);
async function withInstalledFixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-image-recipe-'));
  try {
    const { platformPackage, target } = lockedCodexTarget(lock);
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
    for (const name of ['@openai/codex-sdk', '@openai/codex', platformPackage]) {
      const path = join(root, 'node_modules', name, 'package.json');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: lock.packages[`node_modules/${name}`].version }));
    }
    const vendor = join(root, 'node_modules', platformPackage, 'vendor', target);
    await mkdir(join(vendor, 'bin'), { recursive: true });
    await mkdir(join(vendor, 'codex-resources'));
    await writeFile(join(vendor, 'bin', 'codex'), 'authored fixture, never executed');
    await chmod(join(vendor, 'bin', 'codex'), 0o755);
    await writeFile(join(vendor, 'bin', 'codex-code-mode-host'), 'authored helper');
    await writeFile(join(vendor, 'codex-resources', 'asset'), 'authored resource');
    const stage = () => exec(process.execPath, [fileURLToPath(new URL('prepare-image.mjs', import.meta.url)), 'stage-codex'], { cwd: root });
    await action({ root, vendor, stage });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('CLI staging preserves the native binary and its sibling helper/resources', async () => {
  await withInstalledFixture(async ({ root, stage }) => {
    await stage();
    assert.equal(await readFile(join(root, 'codex', 'bin', 'codex'), 'utf8'), 'authored fixture, never executed');
    assert.equal(await readFile(join(root, 'codex', 'bin', 'codex-code-mode-host'), 'utf8'), 'authored helper');
    assert.equal(await readFile(join(root, 'codex', 'codex-resources', 'asset'), 'utf8'), 'authored resource');
  });
});

test('CLI staging refuses linked assets and installed version drift', async () => {
  await withInstalledFixture(async ({ root, vendor, stage }) => {
    await symlink(join(vendor, 'bin', 'codex'), join(vendor, 'codex-resources', 'linked'));
    await assert.rejects(stage, /Unexpected linked or special CLI asset/);
    await rm(join(vendor, 'codex-resources', 'linked'));
    await writeFile(join(root, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ version: '0.159.3' }));
    await assert.rejects(stage, /Installed @openai\/codex must match the lockfile/);
  });
});
