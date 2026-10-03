import { spawn } from 'node:child_process';

/** No ambient credentials, user Git configuration, hooks, network transports or lazy fetch. */
export function workspaceEnvironment(): NodeJS.ProcessEnv {
  const settings = {
    'core.hooksPath': '/dev/null', 'core.fsmonitor': 'false',
    // Case-folding can hide a distinct untracked Linux path behind a tracked path.
    'core.ignoreCase': 'false',
    'commit.gpgSign': 'false', 'credential.helper': '', 'protocol.allow': 'never',
    'maintenance.auto': 'false', 'gc.auto': '0',
  };
  return {
    PATH: process.env.PATH, HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent',
    LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: String(Object.keys(settings).length),
    ...Object.fromEntries(Object.entries(settings).flatMap(([key, value], i) => [
      [`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value],
    ])),
  };
}

/** Linux process group termination bounds descendants as well as the direct child. */
export async function boundedProcessBytes(command: string, args: string[], cwd: string, maxBytes = 8_000_000, detached = true, timeoutMs = 30_000, input?: Uint8Array) {
  if (process.platform !== 'linux') throw new Error('Workspace commands currently support Linux only');
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: workspaceEnvironment(), detached, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      if (child.pid) { try { if (detached) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') failure = e as Error; } }
    };
    const timeout = setTimeout(() => stop(new Error(`Workspace process exceeded ${timeoutMs} milliseconds; inspect the retained attempt before recovery`)), timeoutMs);
    // Optional bounded in-memory input for Git plumbing. No shell, file redirection,
    // ambient environment, or independently surviving pipeline is introduced.
    if (input && child.stdin) {
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error); });
      child.stdin.end(input);
    }
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new Error(`Workspace process output exceeded ${maxBytes} bytes; no successful cleanup is assumed`));
      else chunks.push(chunk);
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 2000)}`));
      else resolve(Buffer.concat(stdout));
    });
  });
}

/** Text wrapper retained for the existing workspace lifecycle. */
export async function boundedProcess(command: string, args: string[], cwd: string, maxBytes = 8_000_000, detached = true) {
  return (await boundedProcessBytes(command, args, cwd, maxBytes, detached)).toString('utf8');
}

export const workspaceGit = (cwd: string, ...args: string[]) => boundedProcess('git', args, cwd);

/** Git status/diff trust these index flags and can omit modified tracked bytes. Never clear them implicitly. */
export async function workspaceIndexFlags(cwd: string, git = workspaceGit) {
  const entries = (await git(cwd, 'ls-files', '-v', '-z')).split('\0').filter(Boolean);
  return {
    assumeUnchangedPaths: entries.filter(entry => /^[a-z] /.test(entry)).map(entry => entry.slice(2)),
    skipWorktreePaths: entries.filter(entry => /^[Ss] /.test(entry)).map(entry => entry.slice(2)),
  };
}
