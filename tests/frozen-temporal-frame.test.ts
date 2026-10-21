import { expect, it, vi } from 'vitest';
import { authoredTemporalFrame } from './helpers/authored-temporal-frame.js';
const { readFile }=vi.hoisted(()=>({readFile:vi.fn()}));
vi.mock('node:fs/promises',()=>({readFile}));
import { loadFrozenTemporalFrame } from '../scripts/lib/frozen-temporal-frame.js';

it('rejects synthetic bytes at the real pinned-data boundary before loading any collector or verifier',async()=>{
 readFile.mockResolvedValueOnce(Buffer.from(JSON.stringify(authoredTemporalFrame())));
 await expect(loadFrozenTemporalFrame()).rejects.toThrow('Frozen frame changed');
 expect(readFile).toHaveBeenCalledTimes(1);
});
