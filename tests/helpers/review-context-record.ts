import type { StoredChangeSnapshot } from '../../src/change-snapshot.js';
import { DEFAULT_REPOSITORY_CONTEXT_LIMITS, validateRepositoryContext } from '../../src/repository-context.js';
import { capturedSide } from './semantic-review-fixture.js';

/** Authored immutable bytes; no Git or historical provenance is claimed. */
export function reviewContextRecord(snapshot: StoredChangeSnapshot, source = 'Guard every dangerous read.\n', path = 'policy.md') {
  const entry = capturedSide(path, source);
  return validateRepositoryContext({ schemaVersion: 1, kind: 'git-repository-context', repository: snapshot.snapshot.repository,
    head: snapshot.snapshot.head, selection: 'explicit-paths-at-head', limits: DEFAULT_REPOSITORY_CONTEXT_LIMITS, entries: [entry],
    coverage: { selectedPaths: 1, capturedPaths: 1, excludedPaths: 0, missingPaths: 0, capturedBytes: entry.byteLength,
      scope: 'selected-paths-only', historicalAvailability: 'unproven' } });
}
