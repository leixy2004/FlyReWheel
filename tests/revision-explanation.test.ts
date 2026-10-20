import { expect, it } from 'vitest';
import { ruleFieldChanges } from '../src/revision-explanation.js';

it('reports literal rule edits without treating provenance or array order as semantic proof', () => {
  expect(ruleFieldChanges({ semantics: { exceptions: [], invariant: 'same' }, version: 'v1', obsolete: null },
    { version: 'v2', semantics: { invariant: 'same', exceptions: ['guarded'] }, rationale: 'authored' })).toEqual([
    { path: '/obsolete', operation: 'remove', before: null },
    { path: '/rationale', operation: 'add', after: 'authored' },
    { path: '/semantics/exceptions', operation: 'replace', before: [], after: ['guarded'] },
    { path: '/version', operation: 'replace', before: 'v1', after: 'v2' },
  ]);
  expect(ruleFieldChanges({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
  expect(ruleFieldChanges([1, 2], [2, 1])).toEqual([{ path: '', operation: 'replace', before: [1, 2], after: [2, 1] }]);
  expect(ruleFieldChanges({ 'a/b~c': false }, { 'a/b~c': true })[0].path).toBe('/a~1b~0c');
});
