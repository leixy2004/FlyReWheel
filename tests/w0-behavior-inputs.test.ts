import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { checkW0BehaviorInputs } from '../scripts/check-w0-behavior-inputs.js';
it('reproduces the offline quality record without networking, labels or action execution', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
  try {
    const result = await checkW0BehaviorInputs();
    const recorded = JSON.parse(await readFile(new URL('../experiments/temporal-pilot/w0-first-three/behavior-validation/input-quality.json', import.meta.url), 'utf8'));
    expect(result).toEqual(recorded);
    expect(result.items.map(item => item.sourceCases)).toEqual([2, 2, 4]);
    expect(result.items.every(item => item.allCaseExpectationsUnknown && !item.executableTemplate)).toBe(true);
    expect(result.items[2]!.workflows).toHaveLength(4);
    expect(result.modelCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
