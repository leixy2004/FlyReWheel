import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LocalArtifactStore, S3ArtifactStore } from '../src/artifacts.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function store(maxObject = 1024, maxTotal = 2048) {
  const root = await mkdtemp(join(tmpdir(), 'qe-artifacts-')); directories.push(root);
  return { root, store: new LocalArtifactStore(root, maxObject, maxTotal) };
}
test('content-addressed writes are idempotent and readback verifies bytes', async () => {
  const s = await store(); const bytes = Buffer.from('evidence');
  const ref = await s.store.put(bytes);
  expect(await s.store.put(bytes)).toEqual(ref);
  expect(Buffer.from(await s.store.get(ref)).toString()).toBe('evidence');
  await writeFile(join(s.root, ref.key), 'tampered');
  await expect(s.store.get(ref)).rejects.toThrow('integrity');
});
test('object and development total quotas fail closed', async () => {
  const s = await store(5, 7);
  await expect(s.store.put(Buffer.from('123456'))).rejects.toThrow('byte limit');
  await s.store.put(Buffer.from('12345'));
  await expect(s.store.put(Buffer.from('abc'))).rejects.toThrow('quota');
});
test('invalid references cannot traverse directories', async () => {
  const s = await store();
  await expect(s.store.get({ digest: 'a'.repeat(64), key: '../secret', size: 1 })).rejects.toThrow('Invalid');
});
test('S3 adapter requires explicit secure endpoint and does not provision resources', () => {
  expect(() => new S3ArtifactStore({ endpoint: 'http://example.com', accessKeyId: 'test', secretAccessKey: 'test', bucket: 'private' })).toThrow('HTTPS');
});
