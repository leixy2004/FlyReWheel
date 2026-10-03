import { validateGitObjectDeclarations, type GitBlobSide } from './git-object-evidence.js';
import { digestOf } from './core/identity.js';
import { REVIEW_CONTEXT_LIMITS, RepositoryContextDigestSetSchema } from './core/semantic-review-context.js';
import { validateRepositoryContextForSnapshot, RepositoryContextPackageSchema, type RepositoryContextEntry, type StoredRepositoryContext } from './repository-context.js';
import type { StoredChangeSnapshot } from './change-snapshot.js';

export function reviewRepositoryContextDigests(contexts: readonly StoredRepositoryContext[]): string[] {
  return RepositoryContextDigestSetSchema.parse(contexts.map(value => value.digest).sort());
}
/** Offline integrity/binding only. Workspace execution separately recaptures local Git. */
export function validateReviewRepositoryContexts(input: readonly StoredRepositoryContext[], snapshot: StoredChangeSnapshot): StoredRepositoryContext[] {
  if (input.length > REVIEW_CONTEXT_LIMITS.packages || Buffer.byteLength(JSON.stringify(input)) > REVIEW_CONTEXT_LIMITS.jsonBytes) throw new Error('Review repository context selection exceeds bounded package bytes/count');
  const contexts = input.map(value => {
    const { digest, context } = RepositoryContextPackageSchema.parse(value);
    return { digest, context }; // Imported/copied receipts never supply authority.
  }).sort((a, b) => a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0);
  reviewRepositoryContextDigests(contexts);
  let paths = 0, bytes = 0;
  const selected = new Map<string, RepositoryContextEntry>();
  for (const context of contexts) {
    validateRepositoryContextForSnapshot(context, snapshot);
    paths += context.context.coverage.selectedPaths; bytes += context.context.coverage.capturedBytes;
    for (const entry of context.context.entries) {
      const prior = selected.get(entry.path);
      if (prior !== undefined && digestOf(prior) !== digestOf(entry)) throw new Error('Selected repository context packages conflict at an overlapping path');
      selected.set(entry.path, entry);
    }
  }
  const headEntries = snapshot.snapshot.changes.flatMap(change => change.after.state === 'absent' ? [] : [change.after]);
  const declarations: RepositoryContextEntry[] = [...selected.values(), ...headEntries];
  const headPaths = new Map([...selected, ...headEntries.map(entry => [entry.path, entry] as const)]);
  validateGitObjectDeclarations(declarations.filter((entry): entry is Exclude<GitBlobSide, { state: 'absent' }> =>
    entry.state !== 'missing' && !(entry.state === 'excluded' && entry.reason === 'directory')), message => { throw new Error(message); });
  // Preserve single-package tree-consistency checks across the complete frozen set.
  const directoryObjects = new Set(declarations.flatMap(entry => entry.state === 'excluded' && entry.reason === 'directory' ? [entry.objectId] : []));
  for (const entry of declarations) {
    if (entry.state !== 'missing' && entry.mode !== '040000' && directoryObjects.has(entry.objectId)) throw new Error('Selected repository contexts conflict on tree/blob object identity');
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = headPaths.get(parts.slice(0, i).join('/'));
      if (parent && (parent.state === 'missing' || parent.mode !== '040000') && entry.state !== 'missing') throw new Error('Selected repository contexts conflict on missing or non-directory parent');
    }
  }
  if (paths > REVIEW_CONTEXT_LIMITS.selectedPaths || bytes > REVIEW_CONTEXT_LIMITS.capturedBytes) throw new Error('Review repository context selection exceeds aggregate path/byte limits');
  return contexts;
}
