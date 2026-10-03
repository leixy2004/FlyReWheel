import { cp, mkdir, rm } from 'node:fs/promises';
const destination = new URL('../dist/storage/migrations/', import.meta.url);
// Build output must be an exact copy: never leave removed/renamed stale SQL in dist.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(new URL('../src/storage/migrations/', import.meta.url), destination, { recursive: true });
