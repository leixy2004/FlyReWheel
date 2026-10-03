/**
 * Self-authored provider-contract fixtures only. The local transport below is a
 * TEST DOUBLE: it executes on this machine and provides NO security isolation.
 * Never pass repository-supplied code, credentials, or untrusted commands to it.
 *
 * Sandcastle 0.12.0 inherits process.env for its internal host Git operations.
 * Run each scenario in a separate, clean-environment process rather than mutate
 * Vitest's global environment or mock Sandcastle's public implementation.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedSandboxProvider, createWorktree,
  type AgentProvider, type ExecResult, type IsolatedSandboxHandle, type Worktree,
} from '@ai-hero/sandcastle';

export type ContractScenario = 'reuse' | 'preabort' | 'bundle' | 'cancel' | 'failure';
const scenarios: readonly ContractScenario[] = ['reuse', 'preabort', 'bundle', 'cancel', 'failure'];
const resultPrefix = 'SANDCASTLE_CONTRACT_RESULT=';
const commandTimeoutMs = 8_000;
const maxOutputBytes = 256 * 1024;
const activeChildren = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const exists = (path: string) => access(path).then(() => true, () => false);

/** No ambient PATH, credentials, Git configuration, hooks, or signing settings. */
export function fixtureEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file', GIT_TEMPLATE_DIR: join(root, 'empty-template'),
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'commit.gpgSign', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'tag.gpgSign', GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'credential.helper', GIT_CONFIG_VALUE_3: '',
    GIT_CONFIG_KEY_4: 'core.fsmonitor', GIT_CONFIG_VALUE_4: 'false',
  };
}

async function prepareEnvironment(root: string) {
  await Promise.all(['home', 'tmp', 'empty-template'].map(name => mkdir(join(root, name), { recursive: true })));
  // Sandcastle writes safe.directory during run(); permit that only in this fixture.
  await writeFile(join(root, 'gitconfig'), '');
}

function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function stopChildren(children: Iterable<ChildProcessWithoutNullStreams>) {
  const pending = [...children];
  const closed = Promise.all(pending.map(child => activeChildren.get(child)));
  for (const child of pending) signalGroup(child, 'SIGTERM');
  try { await within(closed, 500, 'fixture shutdown grace period'); }
  catch {
    for (const child of pending) signalGroup(child, 'SIGKILL');
    await within(closed, 2_000, 'Fixture processes did not stop after SIGKILL');
  }
}

interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  onLine?: (line: string) => void;
  active?: Set<ChildProcessWithoutNullStreams>;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Bounded capture and process-group termination, including shell descendants. */
async function command(file: string, args: string[], options: CommandOptions): Promise<ExecResult> {
  const child = spawn(file, args, {
    cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let markClosed!: () => void;
  const closed = new Promise<void>(resolveClosed => { markClosed = resolveClosed; });
  activeChildren.set(child, closed);
  options.active?.add(child);
  return new Promise<ExecResult>((resolveResult, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let lineBuffer = '';
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      // The fixtures are authored, and exceeding either bound is always a bug.
      signalGroup(child, 'SIGKILL');
    };
    const timer = setTimeout(() => fail(new Error('Fixture command timed out')), options.timeoutMs ?? commandTimeoutMs);
    const capture = (chunk: Buffer, stream: Buffer[], live: boolean) => {
      totalBytes += chunk.length;
      if (totalBytes > (options.maxBytes ?? maxOutputBytes)) {
        fail(new Error('Fixture command exceeded output limit'));
        return;
      }
      stream.push(chunk);
      if (live && options.onLine) {
        lineBuffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
          lineBuffer = lineBuffer.slice(newline + 1);
          try { options.onLine(line); } catch (error) { fail(error as Error); }
        }
      }
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, stdout, true));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, stderr, false));
    child.once('error', error => { failure = error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      // Also reap a background process whose shell has already exited.
      signalGroup(child, 'SIGKILL');
      activeChildren.delete(child);
      options.active?.delete(child);
      markClosed();
      if (lineBuffer && options.onLine && !failure) {
        try { options.onLine(lineBuffer); } catch (error) { failure = error as Error; }
      }
      if (failure) reject(failure);
      else resolveResult({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 128 });
    });
    child.stdin.on('error', () => { /* early command exit may close stdin */ });
    child.stdin.end(options.stdin);
  });
}

async function git(root: string, cwd: string, ...args: string[]) {
  const result = await command('git', args, { cwd, env: fixtureEnvironment(root) });
  if (result.exitCode !== 0) throw new Error(`Fixture Git failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(root: string) {
  const path = join(root, 'source');
  await mkdir(path);
  await git(root, path, 'init', '--initial-branch=main');
  await git(root, path, 'config', 'user.name', 'Authored Contract Fixture');
  await git(root, path, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(path, '.gitignore'), '.sandcastle/\n');
  const commits: string[] = [];
  for (let index = 1; index <= 3; index++) {
    await writeFile(join(path, 'value.txt'), `version-${index}\n`);
    await git(root, path, 'add', '.');
    await git(root, path, 'commit', '-m', `authored fixture version ${index}`);
    commits.push(await git(root, path, 'rev-parse', 'HEAD'));
  }
  return { path, commits };
}

function assertWithin(base: string, path: string) {
  const suffix = relative(resolve(base), resolve(path));
  if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) throw new Error('Fixture path outside its temporary directory');
}

interface TransportEvent {
  type: 'exec' | 'exit' | 'copyIn' | 'copyFileOut';
  command?: string;
  cwd?: string;
  hostPath?: string;
  sandboxPath?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}
interface FixtureHandle extends IsolatedSandboxHandle {
  base: string;
  active: Set<ChildProcessWithoutNullStreams>;
  events: TransportEvent[];
  readonly closed: boolean;
}

/** Public provider contract, backed by LOCAL processes, never a real sandbox. */
function localFixtureTransport(root: string) {
  const handles: FixtureHandle[] = [];
  const provider = createIsolatedSandboxProvider({
    name: 'local-authored-test-transport-NO-ISOLATION',
    create: async () => {
      const base = await mkdtemp(join(root, 'transport-'));
      const worktreePath = join(base, 'repo');
      await prepareEnvironment(base);
      const active = new Set<ChildProcessWithoutNullStreams>();
      const events: TransportEvent[] = [];
      let closed = false;
      let closing: Promise<void> | undefined;
      const handle: FixtureHandle = {
        base, worktreePath, active, events, get closed() { return closed; },
        async exec(script, options = {}) {
          if (closed) throw new Error('Fixture transport already closed');
          if (options.sudo) throw new Error('Fixture transport does not support sudo');
          const cwd = options.cwd ?? base;
          assertWithin(base, cwd);
          events.push({ type: 'exec', command: script, cwd });
          try {
            const result = await command('/bin/sh', ['-c', script], {
              cwd, env: fixtureEnvironment(base), active, stdin: options.stdin, onLine: options.onLine,
            });
            events.push({ type: 'exit', ...result });
            return result;
          } catch (error) {
            events.push({ type: 'exit', error: String(error) });
            throw error;
          }
        },
        async copyIn(hostPath, sandboxPath) {
          assertWithin(root, hostPath);
          assertWithin(base, sandboxPath);
          events.push({ type: 'copyIn', hostPath, sandboxPath });
          await mkdir(dirname(sandboxPath), { recursive: true });
          await cp(hostPath, sandboxPath, { recursive: true });
        },
        async copyFileOut(sandboxPath, hostPath) {
          assertWithin(base, sandboxPath);
          assertWithin(root, hostPath);
          events.push({ type: 'copyFileOut', hostPath, sandboxPath });
          await mkdir(dirname(hostPath), { recursive: true });
          await cp(sandboxPath, hostPath);
        },
        close() {
          return closing ??= (async () => {
            closed = true;
            await stopChildren(active);
            await writeFile(join(base, 'transport-events.json'), JSON.stringify(events, null, 2));
            // Evidence stays until the owning Vitest case has checked it.
          })();
        },
      };
      handles.push(handle);
      return handle;
    },
  });
  return { provider, handles };
}

function fixtureAgent(code: string): AgentProvider {
  return {
    name: 'self-authored-fixture-agent', env: {}, captureSessions: false,
    buildPrintCommand: () => ({ command: `exec ${quote(process.execPath)} -e ${quote(code)}` }),
    parseStreamLine: line => [{ type: 'text', text: `${line}\n` }],
  };
}

export interface ScenarioResult {
  scenario: ContractScenario;
  root: string;
  observed: Record<string, unknown>;
}

async function executeScenario(scenario: ContractScenario, root: string): Promise<ScenarioResult> {
  const f = await fixture(root);
  const baseSha = f.commits[scenario === 'reuse' || scenario === 'preabort' ? 0 : 1]!;
  // This is the real, pinned package's PUBLIC API, with no strict allocator or mock.
  const worktree = await createWorktree({
    cwd: f.path,
    branchStrategy: { type: 'branch', branch: `contract/${scenario}`, baseBranch: baseSha },
  });
  const transport = localFixtureTransport(root);
  const worktrees: Worktree[] = [worktree];
  try {
    let observed: Record<string, unknown>;
    if (scenario === 'reuse') {
      await writeFile(join(worktree.worktreePath, 'evidence.txt'), 'retain dirty evidence\n');
      const reused = await createWorktree({
        cwd: f.path,
        branchStrategy: { type: 'branch', branch: worktree.branch, baseBranch: f.commits[2]! },
      });
      worktrees.push(reused);
      const closeResult = await worktree.close();
      observed = {
        originalPath: worktree.worktreePath, reusedPath: reused.worktreePath,
        expectedHead: baseSha, actualHead: await git(root, reused.worktreePath, 'rev-parse', 'HEAD'),
        requestedNewBase: f.commits[2], preservedWorktreePath: closeResult.preservedWorktreePath,
        evidencePath: join(reused.worktreePath, 'evidence.txt'),
      };
    } else if (scenario === 'preabort') {
      let created = 0;
      const provider = createIsolatedSandboxProvider({ name: 'must-not-launch', create: async () => {
        created++;
        throw new Error('Unexpected provider setup');
      } });
      const reason = new Error('Caller cancelled before setup');
      let error: unknown;
      try {
        await worktree.run({ sandbox: provider, agent: fixtureAgent(''), prompt: 'authored fixture', signal: AbortSignal.abort(reason) });
      } catch (caught) { error = caught; }
      observed = { sameReason: error === reason, created, worktreePreserved: await exists(worktree.worktreePath) };
    } else if (scenario === 'bundle') {
      const sandbox = await worktree.createSandbox({ sandbox: transport.provider });
      try {
        const handle = transport.handles[0]!;
        const head = (await sandbox.exec('git rev-parse HEAD')).stdout.trim();
        const shallow = (await sandbox.exec('git rev-parse --is-shallow-repository')).stdout.trim();
        const objectTypes = await Promise.all(f.commits.map(async sha => (await sandbox.exec(`git cat-file -t ${sha}`)).stdout.trim()));
        const laterVersion = (await sandbox.exec(`git show ${f.commits[2]}:value.txt`)).stdout.trim();
        const lines: string[] = [];
        let finished = false;
        let streamedBeforeExit = true;
        const releasePath = join(handle.base, 'release-stream');
        let releaseWrite: Promise<unknown> | undefined;
        let releaseError: unknown;
        // The command cannot exit until its FIRST line is delivered live. Merely
        // replaying buffered lines immediately before resolving would deadlock.
        const output = await handle.exec(`printf 'first\\n'; while [ ! -f ${quote(releasePath)} ]; do sleep 0.01; done; printf 'second\\n'; exit 7`, {
          cwd: handle.worktreePath, onLine: line => {
            streamedBeforeExit &&= !finished;
            lines.push(line);
            if (line === 'first') releaseWrite = writeFile(releasePath, 'continue\n').catch(error => { releaseError = error; });
          },
        });
        await releaseWrite;
        if (releaseError) throw releaseError;
        finished = true;
        const stdin = await handle.exec('cat', { stdin: 'stdin proof\n' });
        const cwd = await handle.exec('pwd', { cwd: handle.worktreePath });
        const environment = await handle.exec(`${quote(process.execPath)} -e 'console.log(JSON.stringify(Object.keys(process.env).sort()))'`);
        await sandbox.close();
        observed = {
          head, expectedHead: baseSha, shallow, objectTypes, laterVersion,
          bundleCopied: handle.events.some(event => event.type === 'copyIn' && event.hostPath?.endsWith('repo.bundle')),
          lines, streamedBeforeExit, exitCode: output.exitCode, stdin: stdin.stdout,
          cwd: cwd.stdout.trim(), transportWorktreePath: handle.worktreePath,
          environmentKeys: JSON.parse(environment.stdout), expectedEnvironmentKeys: Object.keys(fixtureEnvironment(handle.base)).concat('PWD').sort(),
          closed: handle.closed, activeProcesses: handle.active.size,
          hostWorktreePreserved: await exists(worktree.worktreePath),
        };
      } finally { await sandbox.close(); }
    } else if (scenario === 'cancel') {
      const controller = new AbortController();
      const reason = new Error('Authored fixture cancellation');
      let ready!: () => void;
      const started = new Promise<void>(resolveStarted => { ready = resolveStarted; });
      const outcome = worktree.run({
        sandbox: transport.provider,
        agent: fixtureAgent("require('fs').writeFileSync('cancel-evidence.txt','partial result\\n'); require('fs').writeFileSync('agent.pid',String(process.pid)); console.log('FIXTURE_STARTED'); setInterval(()=>console.log('tick'),50);"),
        prompt: 'authored fixture only', signal: controller.signal,
        logging: { type: 'file', path: join(root, 'cancel.log'), onAgentStreamEvent: event => {
          if (event.type === 'raw' && event.line.includes('FIXTURE_STARTED')) ready();
        } },
      }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as unknown }));
      try {
        await within(Promise.race([started, outcome.then(result => {
          throw result.error ?? new Error('Fixture agent exited before its start marker');
        })]), 6_000, 'No live agent output before cancellation');
      }
      finally { controller.abort(reason); }
      const result = await outcome;
      const handle = transport.handles[0]!;
      const pid = Number(await readFile(join(handle.worktreePath, 'agent.pid'), 'utf8'));
      let processStopped = false;
      try { process.kill(pid, 0); } catch (error) { processStopped = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      const partialSyncedToHost = await exists(join(worktree.worktreePath, 'cancel-evidence.txt'));
      const hostWorktreePreserved = await exists(worktree.worktreePath);
      const resumed = await worktree.run({
        sandbox: transport.provider, agent: fixtureAgent("console.log('resumed fixture')"),
        prompt: 'authored fixture only', logging: { type: 'file', path: join(root, 'resume.log') },
      });
      observed = {
        sameReason: result.error === reason, closed: handle.closed, activeProcesses: handle.active.size,
        processStopped, hostWorktreePreserved, partialSyncedToHost,
        evidencePath: join(handle.worktreePath, 'cancel-evidence.txt'),
        eventsPath: join(handle.base, 'transport-events.json'), logPath: join(root, 'cancel.log'),
        resumedOutput: resumed.stdout, handlesCreated: transport.handles.length,
        allHandlesClosed: transport.handles.every(item => item.closed && item.active.size === 0),
      };
    } else {
      let failure: unknown;
      try {
        await worktree.run({
          sandbox: transport.provider,
          agent: fixtureAgent("require('fs').writeFileSync('failure-evidence.txt','failed output\\n'); console.error('DELIBERATE_FIXTURE_FAILURE'); process.exit(23)"),
          prompt: 'authored fixture only', logging: { type: 'file', path: join(root, 'failure.log') },
        });
      } catch (error) { failure = error; }
      const handle = transport.handles[0]!;
      const failurePath = join(root, 'expected-failure.txt');
      await writeFile(failurePath, String(failure));
      observed = {
        rejected: failure !== undefined, failure: String(failure), failurePath,
        closed: handle.closed, activeProcesses: handle.active.size,
        hostWorktreePreserved: await exists(worktree.worktreePath),
        evidencePath: join(handle.worktreePath, 'failure-evidence.txt'),
        eventsPath: join(handle.base, 'transport-events.json'), logPath: join(root, 'failure.log'),
      };
    }
    const report = { scenario, root, observed };
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await Promise.all(transport.handles.map(handle => handle.close()));
    await Promise.all(worktrees.map(item => item.close()));
  }
}

/** Called by Vitest; both upstream Git and local transport inherit only fixtures. */
export async function runContractScenario(scenario: ContractScenario, root: string): Promise<ScenarioResult> {
  await prepareEnvironment(root);
  const result = await command(process.execPath, [
    '--import', fileURLToPath(import.meta.resolve('tsx')), fileURLToPath(import.meta.url), '--scenario', scenario, root,
  ], { cwd: root, env: fixtureEnvironment(root), timeoutMs: 30_000, maxBytes: 1024 * 1024 });
  await writeFile(join(root, 'worker-output.json'), JSON.stringify(result, null, 2));
  if (result.exitCode !== 0) throw new Error(`Sandcastle fixture worker failed (${result.exitCode}):\n${result.stderr}\n${result.stdout}`);
  const line = result.stdout.split('\n').find(item => item.startsWith(resultPrefix));
  if (!line) throw new Error('Sandcastle fixture worker returned no report');
  return JSON.parse(line.slice(resultPrefix.length)) as ScenarioResult;
}

// Entry point for this authored TS fixture worker; importing it from Vitest is inert.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--scenario') {
  const scenario = process.argv[3] as ContractScenario;
  const root = process.argv[4];
  if (!scenarios.includes(scenario) || !root || !isAbsolute(root)) throw new Error('Invalid fixture scenario');
  const cleanup = () => { for (const child of activeChildren.keys()) signalGroup(child, 'SIGKILL'); };
  process.once('exit', cleanup);
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  try {
    const result = await executeScenario(scenario, root);
    console.log(`${resultPrefix}${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await stopChildren(activeChildren.keys());
    process.removeListener('exit', cleanup);
  }
}
