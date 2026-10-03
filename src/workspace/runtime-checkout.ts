import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { boundedProcessBytes, workspaceIndexFlags } from './process.js';
import { verifyEvaluationRepository } from './evaluation-checkout.js';
import { validateHistoryBinding, type EvaluationWorkspaceBinding } from './history-policy.js';
import type { RuntimeObservation } from './codex-runner.js';

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Branch = z.string().max(100).regex(/^attempt\/[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*$/);
const absent = async (path: string) => lstat(path).then(() => { throw new Error('Forbidden runtime checkout configuration'); }, error => {
  if (error.code !== 'ENOENT') throw error;
});

/** Observe a standalone clone. No mutation, fetch, checkout, repository code or hooks. */
export async function verifyRuntimeCheckout(cwd: string, expectedSha: string, expectedBranch: string,
  historyPolicy: string, fixtureRoot?: string, evaluation?: EvaluationWorkspaceBinding): Promise<RuntimeObservation> {
  Sha.parse(expectedSha); Branch.parse(expectedBranch);
  if (!['all-local-refs-v1', 'exact-allowed-head-closure-v1'].includes(historyPolicy)) throw new Error('Unsupported runtime history policy');
  validateHistoryBinding({ historyPolicy, evaluation }, expectedSha);
  if (!isAbsolute(cwd) || await realpath(cwd) !== cwd) throw new Error('Runtime checkout must be canonical');
  for (let ancestor = cwd; ; ancestor = dirname(ancestor)) {
    await absent(join(ancestor, '.codex'));
    await absent(join(ancestor, '.sandcastle', '.env'));
    if (ancestor === fixtureRoot || dirname(ancestor) === ancestor) break;
  }
  for (const path of ['.git', '.git/objects', '.git/refs']) {
    const info = await lstat(join(cwd, path));
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(join(cwd, path)) !== join(cwd, path)) throw new Error('Runtime checkout requires standalone Git storage');
  }
  for (const path of ['.git/HEAD', '.git/config', '.git/index']) {
    const info = await lstat(join(cwd, path));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Invalid runtime Git control file');
  }
  for (const path of ['.git/shallow', '.git/commondir', '.git/config.worktree', '.git/info/grafts', '.git/objects/info/alternates', '.git/objects/info/http-alternates']) await absent(join(cwd, path));
  // --no-includes must be applied BEFORE inspecting any repo-local setting.
  // Use an absolute Git binary; PATH and ambient Git/auth variables cannot select it.
  const deadline = Date.now() + 10_000;
  const git = async (path: string, ...args: string[]) => {
    if (Date.now() >= deadline) throw new Error('Runtime checkout verification exceeded its deadline');
    return (await boundedProcessBytes('/usr/bin/git', ['-c', 'core.filemode=true', ...args], path, 1_048_576, true, Math.max(1, deadline - Date.now()))).toString('utf8');
  };
  const config = await git(cwd, 'config', '--no-includes', '--file', join(cwd, '.git/config'), '--null', '--list');
  for (const entry of config.split('\0').filter(Boolean)) {
    const key = entry.split('\n')[0].toLowerCase();
    if (!/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.[^.]+\.(url|fetch)|branch\.[^\n]+\.(remote|merge))$/.test(key)) {
      throw new Error('Unsupported runtime repository configuration');
    }
  }
  if ((await git(cwd, 'rev-parse', '--show-toplevel')).trim() !== cwd
    || (await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim() !== join(cwd, '.git')
    || (await git(cwd, 'rev-parse', '--is-shallow-repository')).trim() !== 'false'
    || (await git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/replace')).trim()) throw new Error('Invalid full-history runtime repository');
  // Completeness is of the received local refs; provenance of the transferred
  // ref set belongs to Sandcastle/admission, not something this clone can infer.
  await git(cwd, 'rev-list', '--objects', '--all', '--quiet');
  await git(cwd, 'fsck', '--connectivity-only', '--no-reflogs');
  const headSha = Sha.parse((await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}')).trim());
  const branch = (await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD')).trim();
  const branchSha = (await git(cwd, 'rev-parse', '--verify', '--end-of-options', `refs/heads/${expectedBranch}^{commit}`)).trim();
  const status = await git(cwd, 'status', '--porcelain=v1', '--untracked-files=all');
  const untracked = await git(cwd, 'ls-files', '--others', '-z');
  const flags = await workspaceIndexFlags(cwd, git);
  if (evaluation) await verifyEvaluationRepository(cwd, evaluation, expectedBranch, true);
  return { expectedSha, headSha, identityValid: headSha === expectedSha && branchSha === expectedSha && branch === expectedBranch,
    clean: !status && !untracked && flags.assumeUnchangedPaths.length === 0 && flags.skipWorktreePaths.length === 0,
    historyPolicy: evaluation ? 'exact-allowed-head-closure-v1' : 'all-local-refs-v1', ...(evaluation ? { evaluation } : {}) };
}
