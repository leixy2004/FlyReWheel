import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sourceDigest } from './adapters/index.js';
const run = promisify(execFile);

/** Reads exact committed blobs with the installed Git client. Never checks out or executes repository content. */
export async function extractBugFixPair(input: { repository: string; base: string; head: string; path: string; caseId: string; language: string; problem: string }) {
  if (!input.path || input.path.startsWith('/') || input.path.includes('\\') || input.path.split('/').some(p => p === '..' || p === '.' || !p) || input.path.includes(':')) throw new Error('Use a normalized repository-relative file path');
  const git = async (...args: string[]) => {
    const { stdout } = await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd: input.repository, encoding: 'utf8', maxBuffer: 1_000_000, timeout: 15_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  };
  const resolve = async (ref: string) => {
    const sha = (await git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Git did not return a concrete commit SHA');
    return sha;
  };
  const base = await resolve(input.base), head = await resolve(input.head);
  if (base === head) throw new Error('Bug/fix pair requires different commits');
  const before = await git('show', '--no-ext-diff', '--no-textconv', `${base}:${input.path}`);
  const after = await git('show', '--no-ext-diff', '--no-textconv', `${head}:${input.path}`);
  if ([before, after].some(text => text.includes('\0') || text.includes('\ufffd'))) throw new Error('Only UTF-8 text blobs are supported');
  if (before === after) throw new Error('Selected file is unchanged between commits');
  return {
    goal: 'Derive a reviewable rule only when the supplied bug claim is supported by this explicit before/after evidence',
    pairs: [{ caseId: input.caseId, split: 'training' as const, path: input.path, language: input.language, before, after, problem: input.problem, evidenceRefs: [`git:${base}:${input.path}:${sourceDigest(before)}`, `git:${head}:${input.path}:${sourceDigest(after)}`] }],
  };
}
