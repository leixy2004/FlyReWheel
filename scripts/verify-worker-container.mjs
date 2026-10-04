/** Bounded local runc smoke. Never establishes OpenSandbox production isolation. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const GiB = 1024 ** 3;
export const reserveBytes = 5 * GiB;
export function budgetBytes(baseBytes, cacheBytes) {
  for (const n of [baseBytes, cacheBytes]) assert.ok(Number.isSafeInteger(n) && n >= 0, 'Invalid byte estimate');
  // Deliberately conservative VFS estimate, not an observed peak or quota.
  return 8 * baseBytes + 2 * cacheBytes + 4 * GiB;
}
export async function measurePublicCache(path) {
  assert.deepEqual(await readdir(path), ['_cacache'], 'Cache context must contain only public _cacache');
  let bytes = 0;
  async function visit(p) {
    const stat = await lstat(p);
    assert.ok(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'Cache links/special files refused');
    if (stat.isDirectory()) for (const name of await readdir(p)) await visit(join(p, name));
    else bytes += stat.size;
  }
  await visit(path);
  return bytes;
}
export function ownedContainerIds(rows, exactName) {
  return rows.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.Names === exactName && /^[a-f0-9]{12,64}$/.test(row.ID)).map(row => row.ID);
}
export function requireSpace(free, required = 0) {
  assert.ok(Number.isFinite(free) && free >= reserveBytes + required, 'Disk budget refused: retain at least 5 GiB');
}
export function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    assert.ok(['--base', '--cache', '--cache-bytes', '--image', '--image-source'].includes(key) && args[i + 1] && !out[key], 'Expected --base DIGEST --cache DIRECTORY --cache-bytes BYTES');
    out[key] = args[i + 1];
  }
  if (out['--image']) {
    assert.deepEqual(Object.keys(out).sort(), ['--image', '--image-source']);
    assert.match(out['--image'], /^sha256:[a-f0-9]{64}$/);
    assert.match(out['--image-source'] ?? '', /^[a-f0-9]{40}$/);
    return { image: out['--image'], imageSource: out['--image-source'] };
  }
  assert.ok(!out['--image-source'], 'Image source requires immutable image ID');
  assert.match(out['--base'] ?? '', /^node@sha256:[a-f0-9]{64}$/, 'Explicit official Node digest required');
  assert.ok(out['--cache'] && Number.isSafeInteger(Number(out['--cache-bytes'])) && Number(out['--cache-bytes']) > 0, 'Explicit public cache size required');
  return { base: out['--base'], cache: resolve(out['--cache']), cacheBytes: Number(out['--cache-bytes']) };
}

export async function main(args) {
  const options = parseArgs(args);
  if (!options.image) {
    const measuredCacheBytes = await measurePublicCache(options.cache);
    assert.ok(options.cacheBytes >= measuredCacheBytes, 'Declared cache budget below measured content size');
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const task = `flyrewheel-bounded-${randomUUID()}`;
  const scratch = await mkdtemp(join(tmpdir(), `${task}-`));
  const image = options.image ?? `${task}:verify`;
  const container = `${task}-smoke`;
  const label = `org.flyrewheel.verification=${task}`;
  const env = { PATH: process.env.PATH, HOME: scratch, DOCKER_CONFIG: join(scratch, 'docker'), BUILDX_CONFIG: join(scratch, 'buildx') };
  await mkdir(env.DOCKER_CONFIG); await mkdir(env.BUILDX_CONFIG);
  let minimumFree = Infinity, minimumRootFree = Infinity, minimumScratchFree = Infinity;
  let interrupted, activeStop;
  const onSignal = () => { interrupted = new Error('Verification interrupted'); activeStop?.(interrupted); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const evidence = { task, image, classification: 'local-runc-no-model-not-production-isolation', checks: [], reserveBytes };
  async function free() {
    const stats = await Promise.all([statfs(root), statfs(scratch), statfs('/')]);
    const values = stats.map(s => s.bavail * s.bsize);
    minimumRootFree = Math.min(minimumRootFree, values[0], values[2]);
    minimumScratchFree = Math.min(minimumScratchFree, values[1]);
    const available = Math.min(...values);
    minimumFree = Math.min(minimumFree, available);
    // An extra GiB is a reaction margin; sampling is not a filesystem quota.
    requireSpace(available, GiB);
    return available;
  }
  async function command(bin, argv, { timeout = 120_000, expected = 0, monitor = true, maxBytes = 2 * 1024 * 1024, input } = {}) {
    if (monitor) { if (interrupted) throw interrupted; await free(); }
    return await new Promise((resolveCommand, reject) => {
      const child = spawn(bin, argv, { cwd: root, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
      let stdout = '', stderr = '', bytes = 0, failure;
      const stop = error => {
        if (failure) return;
        failure = error;
        try { process.kill(-child.pid, 'SIGINT'); } catch {}
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
      };
      if (input) { child.stdin.on('error', error => stop(error)); child.stdin.end(input); }
      activeStop = stop;
      const timer = setTimeout(() => stop(new Error('Bounded command timed out')), timeout);
      let checking = false;
      const diskTimer = monitor ? setInterval(async () => {
        if (checking) return;
        checking = true;
        try { await free(); } catch (error) { stop(error); } finally { checking = false; }
      }, 500) : undefined;
      for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) return stop(new Error('Bounded command output exceeded limit'));
        if (kind === 'stdout') stdout += chunk; else stderr += chunk;
      });
      child.on('error', error => { failure = error; });
      child.on('close', code => {
        activeStop = undefined;
        clearTimeout(timer); clearInterval(diskTimer);
        if (failure) return reject(failure);
        if (code !== expected) {
          // Build output contains public package names only; never pass ambient env/secrets.
          return reject(new Error(`${bin} ${argv[0]} exited ${code}: ${stderr.slice(-5000)}`));
        }
        resolveCommand({ stdout, stderr, code });
      });
    });
  }
  const docker = (argv, opts) => command('docker', argv, opts);
  let checksPassed = false;
  try {
    evidence.sourceSha = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim();
    const branch = (await command('git', ['branch', '--show-current'])).stdout.trim();
    assert.ok(branch, 'Named source branch required');
    assert.equal((await command('git', ['status', '--porcelain'])).stdout, '', 'Commit source before building');
    const driver = (await docker(['info', '--format', '{{.Driver}}'])).stdout.trim();
    assert.equal(driver, 'vfs', 'This capacity experiment is scoped to the VFS builder');
    evidence.driver = driver;
    if (options.image) {
      // Caller supplies the recorded source/image association; compare every admitted
      // build input before reusing the immutable local image. This is not attestation.
      await command('git', ['diff', '--exit-code', options.imageSource, 'HEAD', '--',
        'package.json', 'package-lock.json', 'tsconfig.json', 'src', 'deploy/tsconfig.build.json',
        'deploy/workspace-worker/Dockerfile.bounded', 'deploy/workspace-worker/Dockerfile.bounded.dockerignore',
        'deploy/workspace-worker/prepare-image.mjs', 'deploy/workspace-worker/workspace-worker',
        'deploy/workspace-worker/workspace-worker.json']);
      evidence.imageSourceSha = options.imageSource;
      evidence.reusedImage = true;
    } else {
    // Pull is explicit and bounded; no mutable tag resolution or registry auth config.
    requireSpace(await free(), 3 * GiB);
    await docker(['pull', options.base], { timeout: 300_000 });
    const [base] = JSON.parse((await docker(['image', 'inspect', options.base])).stdout);
    assert.equal(base.Os, 'linux');
    assert.ok(['amd64', 'arm64'].includes(base.Architecture));
    assert.ok(!base.Config.OnBuild?.length && !Object.keys(base.Config.Volumes ?? {}).length, 'Unexpected inherited hooks/volumes');
    assert.ok((base.Config.Env ?? []).every(s => /^(PATH|NODE_VERSION|YARN_VERSION)=/.test(s)), 'Unexpected inherited environment');
    evidence.base = { reference: options.base, id: base.Id, size: base.Size, architecture: base.Architecture };
    evidence.estimatedBuildBytes = budgetBytes(base.Size, options.cacheBytes);
    // Root and scratch can be distinct devices: cache lives on scratch, build on root.
    const rootFree = Math.min(...(await Promise.all([statfs(root), statfs('/')])).map(s => s.bavail * s.bsize));
    requireSpace(rootFree, evidence.estimatedBuildBytes);
    await docker(['build', '--network', 'none', '--progress', 'plain', '--build-context', `npmcache=${options.cache}`,
      '--file', 'deploy/workspace-worker/Dockerfile.bounded', '--build-arg', `WORKSPACE_WORKER_BASE_IMAGE=${options.base}`,
      '--label', label, '--tag', image, '.'], { timeout: 600_000, maxBytes: 4 * 1024 * 1024 });
    }
    const [built] = JSON.parse((await docker(['image', 'inspect', image])).stdout);
    if (options.image) assert.equal(built.Id, options.image);
    assert.match(built.Config.Labels?.['org.flyrewheel.verification'] ?? '', /^flyrewheel-bounded-[a-f0-9-]+$/);
    evidence.imageId = built.Id; evidence.imageBytes = built.Size; evidence.imageRetainedForInspection = image;
    assert.equal(built.Config.User, '10001:10001');
    await docker(['create', '--name', container, '--label', label, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m', '--cpus', '1',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777',
      '--tmpfs', '/workspace/repo:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700', image]);
    await docker(['start', container]);
    assert.equal((await docker(['exec', container, '/usr/bin/id', '-u'])).stdout.trim(), '10001');
    const inspection = JSON.parse((await docker(['inspect', container])).stdout)[0];
    assert.equal(inspection.HostConfig.NetworkMode, 'none');
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(Object.keys(inspection.NetworkSettings.Ports ?? {}).length, 0);
    assert.ok(!inspection.HostConfig.Binds?.length);
    evidence.checks.push('nonroot-10001-network-none-readonly-no-host-binds');
    const assetProbe = `const fs=require('fs');const a=require('assert/strict');for(const p of ['/opt/flyrewheel/bin/workspace-worker','/opt/flyrewheel/codex/bin/codex','/opt/flyrewheel/workspace-worker.json','/run/flyrewheel']){const s=fs.lstatSync(p);a.equal(s.uid,0);a.equal(s.mode&18,0);a.throws(()=>fs.accessSync(p,fs.constants.W_OK))}a.equal(JSON.parse(fs.readFileSync('/opt/flyrewheel/workspace-worker.json')).gateway.kind,'blocked');for(const p of ['/npm-cache','/opt/flyrewheel/src','/opt/flyrewheel/node_modules/typescript','/opt/flyrewheel/node_modules/@openai/codex-linux-x64/vendor','/opt/flyrewheel/node_modules/@openai/codex-linux-arm64/vendor'])a.equal(fs.existsSync(p),false);a.ok(fs.readdirSync('/opt/flyrewheel/codex/bin').length>1);console.log('assets-ok')`;
    await docker(['exec', container, '/usr/local/bin/node', '-e', assetProbe]);
    await docker(['exec', container, '/opt/flyrewheel/codex/bin/codex', '--version']);
    evidence.checks.push('immutable-assets-single-native-copy-native-cli-starts');
    const refused = await docker(['exec', container, '/opt/flyrewheel/bin/workspace-worker', 'run', '/run/flyrewheel/request.json'], { expected: 78 });
    assert.equal(refused.stdout, '');
    assert.equal(JSON.parse(refused.stderr).error, 'WORKSPACE_WORKER_PRODUCTION_BLOCKED');
    evidence.checks.push('compiled-entrypoint-blocked-exit-78-no-output');
    const bundle = join(scratch, 'source.bundle');
    await command('git', ['bundle', 'create', bundle, '--all']);
    assert.ok((await lstat(bundle)).size <= 16 * 1024 * 1024, 'Bundle exceeds 16 MiB smoke bound');
    const receive = `const fs=require('fs');let n=0;const chunks=[];process.stdin.on('data',b=>{n+=b.length;if(n>16777216)process.exit(1);chunks.push(b)});process.stdin.on('end',()=>{fs.writeFileSync('/tmp/source.bundle',Buffer.concat(chunks),{flag:'wx',mode:0o600});console.log(n)})`;
    const transferred = await docker(['exec', '-i', container, '/usr/local/bin/node', '-e', receive], { input: await readFile(bundle) });
    assert.equal(Number(transferred.stdout.trim()), (await lstat(bundle)).size);
    await docker(['exec', container, '/usr/bin/git', 'clone', '--branch', branch, '/tmp/source.bundle', '/workspace/repo']);
    const runtimeBranch = 'attempt/runtime--smoke';
    await docker(['exec', container, '/usr/bin/git', 'checkout', '-b', runtimeBranch, evidence.sourceSha]);
    evidence.runtimeBranch = runtimeBranch;
    const verify = async sha => docker(['exec', container, '/opt/flyrewheel/bin/workspace-worker', 'verify', sha, runtimeBranch, 'all-local-refs-v1']);
    const observed = JSON.parse((await verify(evidence.sourceSha)).stdout);
    assert.equal(observed.headSha, evidence.sourceSha); assert.equal(observed.clean, true); assert.equal(observed.identityValid, true);
    const wrong = JSON.parse((await verify('0'.repeat(40))).stdout);
    assert.equal(wrong.identityValid, false);
    await docker(['exec', container, '/usr/local/bin/node', '-e', `require('fs').writeFileSync('/workspace/repo/unauthorized-extra','dirty')`]);
    assert.equal(JSON.parse((await verify(evidence.sourceSha)).stdout).clean, false);
    evidence.checks.push('real-git-bundle-exact-sha-wrong-sha-dirty-refusal');
    await docker(['stop', '--time', '5', container]);
    assert.equal(JSON.parse((await docker(['inspect', container])).stdout)[0].State.Running, false);
    evidence.checks.push('actual-container-stop-observed');
    checksPassed = true;
  } finally {
    // Reconcile unknown create outcomes by both exact name and unique label.
    // Never daemon-wide image/cache/volume prune; never remove another task.
    try {
      const rows = (await docker(['ps', '-a', '--filter', `label=${label}`, '--format', '{{json .}}'], { monitor: false })).stdout;
      for (const id of ownedContainerIds(rows, container)) await docker(['rm', '--force', id], { monitor: false });
      const remaining = (await docker(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}'], { monitor: false })).stdout.trim();
      assert.equal(remaining, '', 'Task container cleanup was not observed');
      evidence.checks.push('task-container-removal-observed');
      evidence.status = checksPassed ? 'passed' : 'failed';
    } catch (error) {
      evidence.status = 'failed-cleanup-unverified';
      throw error;
    } finally {
      evidence.minimumObservedFreeBytes = Number.isFinite(minimumFree) ? minimumFree : null;
      evidence.minimumRootFreeBytes = Number.isFinite(minimumRootFree) ? minimumRootFree : null;
      evidence.minimumScratchFreeBytes = Number.isFinite(minimumScratchFree) ? minimumScratchFree : null;
      evidence.buildCacheRetained = true;
      try { await rm(scratch, { recursive: true, force: true }); }
      finally {
        process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
        process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
      }
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
