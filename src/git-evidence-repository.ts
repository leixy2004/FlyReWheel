import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedProcessBytes } from './workspace/process.js';
import { gitUtf8 as utf8 } from './git-object-evidence.js';

/** Exact local object reads only. No transport, checkout, hook, filter, or target-code execution. */
export async function openGitEvidenceRepository(path: string, commits: readonly string[], deadline: number, label: string) {
  const repositoryPath = await realpath(path);
  const gitBytes = (...args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${label} capture exceeded the 120-second aggregate deadline`);
    return boundedProcessBytes('git', args, repositoryPath, 1_500_000, true, Math.min(30_000, remaining));
  };
  const git = async (...args: string[]) => utf8(await gitBytes(...args));
  if ((await git('rev-parse', '--show-object-format')).trim() !== 'sha1') throw new Error(`${label} capture currently requires SHA-1 Git objects`);
  if ((await git('rev-parse', '--is-shallow-repository')).trim() !== 'false') throw new Error(`${label} capture requires complete local commit history`);
  const gitCommonDirectory = await realpath((await git('rev-parse', '--path-format=absolute', '--git-common-dir')).trim());
  const grafts = await stat(join(gitCommonDirectory, 'info', 'grafts')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (grafts && grafts.size > 0) throw new Error(`${label} capture refuses grafted commit ancestry`);
  try {
    const partial = await git('config', '--local', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$');
    if (partial.trim()) throw new Error(`${label} capture refuses partial/promisor repositories`);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'git exited 1: ') throw error;
  }
  for (const sha of commits) {
    if ((await git('rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`)).trim() !== sha) throw new Error('Full SHA must identify an exact locally present commit');
  }
  return { repositoryPath, gitCommonDirectory, gitBytes, git };
}
