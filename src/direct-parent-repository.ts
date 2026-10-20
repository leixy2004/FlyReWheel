import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedProcessBytes } from './workspace/process.js';
import { gitUtf8 } from './git-object-evidence.js';

/** A limited local object-store reader. Shallow/promisor markers are preserved;
 * no ancestry walk, lazy fetch, replacement objects, hooks or target code run. */
export async function openDirectParentRepository(path: string, parent: string, head: string, deadline: number) {
  const repositoryPath = await realpath(path);
  const gitBytes = (...args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Direct-parent capture exceeded the 120-second aggregate deadline');
    return boundedProcessBytes('git', args, repositoryPath, 1_500_000, true, Math.min(30_000, remaining));
  };
  const git = async (...args: string[]) => gitUtf8(await gitBytes(...args));
  if ((await git('rev-parse', '--show-object-format')).trim() !== 'sha1') throw new Error('Direct-parent capture requires SHA-1 objects');
  const gitCommonDirectory = await realpath((await git('rev-parse', '--path-format=absolute', '--git-common-dir')).trim());
  const grafts = await stat(join(gitCommonDirectory, 'info', 'grafts')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (grafts && grafts.size > 0) throw new Error('Direct-parent capture refuses grafted ancestry');
  const object = async (type: 'commit' | 'tree', id: string) => {
    if ((await git('cat-file', '-t', id)).trim() !== type) throw new Error(`Expected local ${type} object`);
    const bytes = await gitBytes('cat-file', type, id);
    if (createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex') !== id) throw new Error(`${type} identity check failed`);
    return bytes;
  };
  const commit = async (id: string) => {
    const bytes = await object('commit', id);
    const boundary = bytes.indexOf('\n\n');
    if (boundary < 0) throw new Error('Malformed original commit header');
    const lines = bytes.subarray(0, boundary).toString('latin1').split('\n');
    const trees = lines.filter(line => line.startsWith('tree '));
    const parents = lines.filter(line => line.startsWith('parent '));
    if (trees.length !== 1 || lines[0] !== trees[0] || !/^tree [a-f0-9]{40}$/.test(trees[0]) || parents.some(line => !/^parent [a-f0-9]{40}$/.test(line))) throw new Error('Malformed original tree/parent header');
    return { tree: trees[0].slice(5), parents: parents.map(line => line.slice(7)) };
  };
  const base = await commit(parent), child = await commit(head);
  if (head === parent || child.parents.length !== 1 || child.parents[0] !== parent) throw new Error('Head must have exactly the requested single original parent');
  // Verify every subtree, including unchanged paths. Unchanged blobs are outside
  // this contract; changed blobs are hash-checked by the snapshot capture layer.
  const pending = [base.tree, child.tree], seen = new Set<string>();
  let treeBytes = 0;
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 5000) throw new Error('Direct-parent tree count exceeds 5000');
    const bytes = await object('tree', id);
    treeBytes += bytes.length;
    if (treeBytes > 16_777_216) throw new Error('Direct-parent tree bytes exceed 16MiB');
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, offset);
      if (space < offset || nul <= space + 1 || nul + 21 > bytes.length) throw new Error('Malformed original tree entry');
      const mode = bytes.subarray(offset, space).toString('ascii');
      const name = bytes.subarray(space + 1, nul);
      if (!['40000', '100644', '100755', '120000', '160000'].includes(mode) || name.includes(47) || name.equals(Buffer.from('.')) || name.equals(Buffer.from('..'))) throw new Error('Unsupported original tree entry');
      if (mode === '40000') pending.push(bytes.subarray(nul + 1, nul + 21).toString('hex'));
      offset = nul + 21;
    }
  }
  return { repositoryPath, gitCommonDirectory, gitBytes, git };
}
