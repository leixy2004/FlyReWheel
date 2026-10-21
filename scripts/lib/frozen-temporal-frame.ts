import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Explicit research-data boundary. Routine tests mock this loader, not validation.
// This function retains the original pinned bytes requirement for real preparation.
export async function loadFrozenTemporalFrame() {
  const bytes = await readFile(new URL('../../experiments/temporal-pilot/httpx-2024-frame.json', import.meta.url));
  const frameHash = createHash('sha256').update(bytes).digest('hex');
  if (frameHash !== '07c1ded10a03002eed7b3f25d75c33e161876d72f71371b4cbfc1652022f477b') throw new Error('Frozen frame changed');
  const frame = JSON.parse(bytes.toString('utf8'));
  const collector = await readFile(new URL('../capture-temporal-frame.mjs', import.meta.url));
  const { validateTemporalFrame } = await import(new URL('../validate-temporal-frame.mjs', import.meta.url).href);
  await validateTemporalFrame(frame, collector);
  return { frame, frameHash };
}
