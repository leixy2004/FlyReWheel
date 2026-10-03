/** Build-time checks/staging only. Never invoked by the runtime image. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, cp, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODEX_VERSION = '0.159.2';

export function validateBaseReference(value) {
  assert.match(value ?? '', /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/,
    'WORKSPACE_WORKER_BASE_IMAGE must include an operator-verified sha256 digest');
}

export function lockedCodexTarget(lock, platform = process.platform, arch = process.arch) {
  assert.equal(platform, 'linux', 'The worker image requires Linux');
  const target = { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' }[arch];
  assert.ok(target, 'Only Linux amd64 and arm64 worker images are supported');
  assert.equal(lock.lockfileVersion, 3, 'Use the committed npm lockfile');
  assert.equal(lock.packages?.['']?.dependencies?.['@openai/codex-sdk'], CODEX_VERSION);
  const platformPackage = `@openai/codex-linux-${arch}`;
  for (const [name, version] of [
    ['@openai/codex-sdk', CODEX_VERSION],
    ['@openai/codex', CODEX_VERSION],
    [platformPackage, `${CODEX_VERSION}-linux-${arch}`],
  ]) {
    const locked = lock.packages?.[`node_modules/${name}`];
    assert.equal(locked?.version, version, `Expected exact ${name} version ${version}`);
    assert.match(locked?.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${name} needs lockfile integrity`);
  }
  assert.equal(lock.packages['node_modules/@openai/codex-sdk'].dependencies?.['@openai/codex'], CODEX_VERSION);
  assert.equal(lock.packages['node_modules/@openai/codex'].optionalDependencies?.[platformPackage],
    `npm:@openai/codex@${CODEX_VERSION}-linux-${arch}`);
  return { platformPackage, target };
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

async function checkBase() {
  validateBaseReference(process.env.WORKSPACE_WORKER_BASE_IMAGE);
  assert.equal(process.platform, 'linux');
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Use the audited Node 22 base');
  assert.equal(await realpath(process.execPath), '/usr/local/bin/node', 'The wrapper requires canonical /usr/local/bin/node');
  for (const path of ['/usr/local/bin/node', '/usr/bin/git', '/usr/bin/env', '/bin/sh', '/bin/sleep']) {
    await access(path, constants.X_OK);
    const stat = await lstat(await realpath(path));
    assert.ok(stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0,
      `${path} must be a root-owned executable, not group/world writable`);
  }
  await access('/etc/ssl/certs/ca-certificates.crt', constants.R_OK);
  lockedCodexTarget(await readJson('package-lock.json'));
}

async function rejectLinksAndSpecialFiles(path) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() || stat.isDirectory(), `Unexpected linked or special CLI asset: ${path}`);
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await rejectLinksAndSpecialFiles(join(path, name));
  }
}

async function stageCodex() {
  const { platformPackage, target } = lockedCodexTarget(await readJson('package-lock.json'));
  for (const [name, version] of [
    ['@openai/codex-sdk', CODEX_VERSION], ['@openai/codex', CODEX_VERSION],
    [platformPackage, `${CODEX_VERSION}-linux-${process.arch}`],
  ]) {
    assert.equal((await readJson(join('node_modules', name, 'package.json'))).version, version,
      `Installed ${name} must match the lockfile`);
  }
  const source = resolve('node_modules', platformPackage, 'vendor', target);
  assert.equal(await realpath(source), source, 'CLI package must not be a symlink');
  await rejectLinksAndSpecialFiles(source);
  await access(join(source, 'bin', 'codex'), constants.X_OK);
  // Preserve sibling helpers and bundled resources expected by the native CLI.
  await cp(source, resolve('codex'), { recursive: true, errorOnExist: true, force: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'check-base') await checkBase();
  else if (action === 'stage-codex') await stageCodex();
  else throw new Error('Expected check-base or stage-codex');
}
