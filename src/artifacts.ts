import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export interface ArtifactRef { digest: string; key: string; size: number }
export interface ArtifactStore {
  put(bytes: Uint8Array): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function reference(bytes: Uint8Array, maxBytes: number): ArtifactRef {
  if (bytes.byteLength > maxBytes) throw new Error('Artifact exceeds configured byte limit');
  const digest = sha(bytes);
  return { digest, key: `sha256/${digest}`, size: bytes.byteLength };
}
function validate(ref: ArtifactRef) {
  if (!/^[a-f0-9]{64}$/.test(ref.digest) || ref.key !== `sha256/${ref.digest}` || !Number.isSafeInteger(ref.size) || ref.size < 0) {
    throw new Error('Invalid artifact reference');
  }
}
function verify(bytes: Uint8Array, ref: ArtifactRef): Uint8Array {
  if (bytes.byteLength !== ref.size || sha(bytes) !== ref.digest) throw new Error('Artifact integrity check failed');
  return bytes;
}

/** Single-process development adapter. Not a distributed object store or a sandbox. */
export class LocalArtifactStore implements ArtifactStore {
  constructor(private root: string, private maxObjectBytes = 2_000_000, private maxTotalBytes = 64_000_000) {}
  async put(bytes: Uint8Array): Promise<ArtifactRef> {
    const ref = reference(bytes, this.maxObjectBytes);
    const directory = join(this.root, 'sha256');
    await mkdir(directory, { recursive: true });
    const path = join(directory, ref.digest);
    try { verify(await readFile(path), ref); return ref; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    let used = 0;
    for (const name of await readdir(directory)) used += (await stat(join(directory, name))).size;
    if (used + bytes.byteLength > this.maxTotalBytes) throw new Error('Local artifact quota reached; export or remove an obsolete development run explicitly');
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await this.get(ref); }
    return ref;
  }
  async get(ref: ArtifactRef): Promise<Uint8Array> {
    validate(ref);
    if (ref.size > this.maxObjectBytes) throw new Error('Artifact exceeds configured byte limit');
    return verify(await readFile(join(this.root, ref.key)), ref);
  }
}

/** Official AWS client, compatible with self-hosted S3. Does not provision a bucket. */
export class S3ArtifactStore implements ArtifactStore {
  private client: S3Client;
  constructor(config: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string; region?: string; maxObjectBytes?: number; allowInsecureDevelopment?: boolean }) {
    const url = new URL(config.endpoint);
    if (url.protocol !== 'https:' && !(config.allowInsecureDevelopment && url.protocol === 'http:')) throw new Error('S3 requires HTTPS unless insecure development is explicitly enabled');
    this.client = new S3Client({ endpoint: config.endpoint, region: config.region ?? 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 1 });
    this.bucket = config.bucket;
    this.maxBytes = config.maxObjectBytes ?? 2_000_000;
  }
  private bucket: string;
  private maxBytes: number;
  async put(bytes: Uint8Array): Promise<ArtifactRef> {
    const ref = reference(bytes, this.maxBytes);
    try { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: ref.key, Body: bytes, ContentType: 'application/octet-stream', IfNoneMatch: '*' })); }
    catch (error) {
      // A duplicate is acceptable only if the existing bytes actually match.
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 412 && status !== 409) throw error;
      await this.get(ref);
    }
    return ref;
  }
  async get(ref: ArtifactRef): Promise<Uint8Array> {
    validate(ref);
    if (ref.size > this.maxBytes) throw new Error('Artifact exceeds configured byte limit');
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: ref.key }));
    if (!response.Body) throw new Error('Artifact download returned no body');
    if ((response.ContentLength ?? 0) > this.maxBytes) throw new Error('Downloaded artifact exceeds configured byte limit');
    const parts: Uint8Array[] = []; let size = 0;
    for await (const part of response.Body as AsyncIterable<Uint8Array>) {
      size += part.byteLength;
      if (size > this.maxBytes) throw new Error('Downloaded artifact exceeds configured byte limit');
      parts.push(part);
    }
    return verify(Buffer.concat(parts), ref);
  }
}
