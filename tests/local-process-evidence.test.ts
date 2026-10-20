import { expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestOf } from '../src/core/identity.js';
import { startLocalProcessProbe, inspectLocalProcessEvidence } from '../src/local-process-evidence.js';

test('owned fixed probe persists identity, refuses unproven stop and verifies creator close idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-identity-')), path = join(root, 'probe');
  const probe = await startLocalProcessProbe(path);
  try {
    const live = await inspectLocalProcessEvidence(path, probe.receipt.digest);
    expect(live).toMatchObject({ processState: 'present', childStopVerified: false, reason: 'creator-exit-evidence-missing', leaseReleaseAuthorized: false });
    const stopped = await probe.stop();
    expect(stopped).toMatchObject({ childStopVerified: true, automaticRecovery: false, leaseReleaseAuthorized: false });
    expect(await probe.stop()).toEqual(stopped);
    expect(await inspectLocalProcessEvidence(path, probe.receipt.digest)).toEqual(stopped);
    await expect(startLocalProcessProbe(path)).rejects.toMatchObject({ code: 'EEXIST' });
  } finally { await probe.stop(); await rm(root, { recursive: true, force: true }); }
});

test('identity and exit mismatches refuse; missing exit is not inferred from absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-identity-bad-')), path = join(root, 'probe');
  const probe = await startLocalProcessProbe(path);
  await probe.stop();
  try {
    await expect(inspectLocalProcessEvidence(path, '0'.repeat(64))).rejects.toThrow(/identity/);
    const identityPath = join(path, 'identity.json'), original = await readFile(identityPath, 'utf8');
    const forged = JSON.parse(original); forged.identity.bootId = '00000000-0000-4000-8000-000000000000'; forged.digest = digestOf(forged.identity);
    await writeFile(identityPath, JSON.stringify(forged));
    await expect(inspectLocalProcessEvidence(path, forged.digest)).rejects.toThrow(/boot identity/);
    await writeFile(identityPath, original);
    const exitPath = join(path, 'exit.json'), originalExit = await readFile(exitPath, 'utf8');
    const exit = JSON.parse(originalExit); exit.evidence.identityDigest = '0'.repeat(64); exit.digest = digestOf(exit.evidence);
    await writeFile(exitPath, JSON.stringify(exit));
    await expect(inspectLocalProcessEvidence(path, probe.receipt.digest)).rejects.toThrow(/binding/);
    await rm(exitPath);
    expect(await inspectLocalProcessEvidence(path, probe.receipt.digest)).toMatchObject({ childStopVerified: false, reason: 'creator-exit-evidence-missing' });
    await symlink(identityPath, exitPath);
    await expect(inspectLocalProcessEvidence(path, probe.receipt.digest)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('running process birth mismatch fails closed even with a recomputed local checksum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flyrewheel-birth-bad-')), path = join(root, 'probe');
  const probe = await startLocalProcessProbe(path), identityPath = join(path, 'identity.json');
  const original = await readFile(identityPath, 'utf8');
  try {
    const forged = JSON.parse(original); forged.identity.startTicks = '0'; forged.digest = digestOf(forged.identity);
    await writeFile(identityPath, JSON.stringify(forged));
    await expect(inspectLocalProcessEvidence(path, forged.digest)).rejects.toThrow(/birth identity/);
  } finally { await writeFile(identityPath, original); await probe.stop(); await rm(root, { recursive: true, force: true }); }
});
