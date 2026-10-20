import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { digestOf } from './core/identity.js';
import { workspaceEnvironment } from './workspace/process.js';

// Fixed trusted probe: no repository programs, descendants, shell or model.
const program = `process.on('message', message => { if (message === 'stop') process.exit(0); }); process.on('disconnect', () => process.exit(0)); process.send('ready');`;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = z.object({ schemaVersion: z.literal(1), kind: z.literal('local-owned-process-probe'),
  probeId: z.uuid(), bootId: z.uuid(), pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/),
  programDigest: Digest, createdAt: z.iso.datetime(), scope: z.literal('fixed-child-only-no-lease-authority'),
}).strict();
const StoredIdentity = z.object({ digest: Digest, identity: Identity }).strict();
const Exit = z.object({ schemaVersion: z.literal(1), identityDigest: Digest, observation: z.literal('creator-child-close'),
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), observedAt: z.iso.datetime(),
}).strict();
const StoredExit = z.object({ digest: Digest, evidence: Exit }).strict();
async function readJson(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid bounded process evidence file');
    const buffer = Buffer.alloc(8193), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('Process evidence exceeds bound');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await file.close(); }
}
async function birth(pid: number) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { state: fields[0], startTicks: z.string().regex(/^\d+$/).parse(fields[19]) };
}
const boot = async () => z.uuid().parse((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
async function directory(path: string) {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('Use a real absolute evidence directory');
}

/** Creator-only handle. There is deliberately no reopen/kill/release API. */
export async function startLocalProcessProbe(path: string) {
  if (process.platform !== 'linux' || !isAbsolute(path)) throw new Error('Local process evidence requires Linux and an absolute new directory');
  await mkdir(path, { mode: 0o700 });
  await directory(path);
  const bootId = await boot();
  const child = spawn(process.execPath, ['-e', program], { env: workspaceEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Probe readiness timed out')), 3000);
      const error = (value: Error) => finish(value);
      const close = () => finish(new Error('Probe closed before readiness'));
      const message = (value: unknown) => { if (value === 'ready') finish(); };
      function finish(failure?: Error) {
        clearTimeout(timer); child.off('error', error); child.off('close', close); child.off('message', message);
        if (failure) reject(failure); else resolve();
      }
      child.once('error', error); child.once('close', close); child.on('message', message);
    });
    const observed = await birth(child.pid!);
    const identity = Identity.parse({ schemaVersion: 1, kind: 'local-owned-process-probe', probeId: randomUUID(), bootId,
      pid: child.pid, startTicks: observed.startTicks, programDigest: digestOf(program), createdAt: new Date().toISOString(), scope: 'fixed-child-only-no-lease-authority' });
    const receipt = { digest: digestOf(identity), identity };
    await writeFile(join(path, 'identity.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    let stopping: Promise<unknown> | undefined;
    return { receipt, stop() {
      stopping ??= (async () => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
        try {
          if (child.connected) child.send('stop', error => { if (error) child.kill('SIGKILL'); });
          const result = await closed;
          const evidence = Exit.parse({ schemaVersion: 1, identityDigest: receipt.digest, observation: 'creator-child-close',
            ...result, observedAt: new Date().toISOString() });
          await writeFile(join(path, 'exit.json'), JSON.stringify({ digest: digestOf(evidence), evidence }), { flag: 'wx', mode: 0o600 });
          return inspectLocalProcessEvidence(path, receipt.digest);
        } finally { clearTimeout(timer); }
      })();
      return stopping;
    } };
  } catch (error) { child.kill('SIGKILL'); await closed; throw error; }
}

/** Persisted observations under a trusted local host, not independent authentication. */
export async function inspectLocalProcessEvidence(path: string, expectedDigest: string) {
  Digest.parse(expectedDigest); await directory(path);
  const stored = StoredIdentity.parse(await readJson(join(path, 'identity.json')));
  if (stored.digest !== expectedDigest || digestOf(stored.identity) !== stored.digest || stored.identity.programDigest !== digestOf(program))
    throw new Error('Process identity digest or program mismatch');
  if (await boot() !== stored.identity.bootId) throw new Error('Process boot identity mismatch; recovery refused');
  let processState = 'absent';
  try {
    const observed = await birth(stored.identity.pid);
    if (observed.startTicks !== stored.identity.startTicks) throw new Error('Process birth identity mismatch; recovery refused');
    processState = observed.state === 'Z' ? 'terminated-unreaped' : 'present';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let exitEvidence: z.infer<typeof StoredExit> | null = null;
  try {
    exitEvidence = StoredExit.parse(await readJson(join(path, 'exit.json')));
    if (digestOf(exitEvidence.evidence) !== exitEvidence.digest || exitEvidence.evidence.identityDigest !== expectedDigest)
      throw new Error('Process exit evidence binding mismatch');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const childStopVerified = exitEvidence !== null && processState !== 'present';
  return { identityDigest: stored.digest, identity: stored.identity, processState, exitEvidence,
    childStopVerified, reason: !exitEvidence ? 'creator-exit-evidence-missing' : processState === 'present' ? 'process-still-present' : 'creator-close-and-birth-observation',
    assurance: 'trusted-local-content-integrity-only', automaticRecovery: false, leaseReleaseAuthorized: false,
    descendantContainment: 'unsupported', productionRecovery: 'unsupported' };
}
