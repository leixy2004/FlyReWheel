import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CodexWorkspaceWorkerError, runCodexWorkspaceWorker, type CodexWorkerInput } from '../src/adapters/codex-workspace-worker.js';

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'flyrewheel-sdk-workspace-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const usage = { input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 };
async function fixture(name: string, code: string) {
  const workingDirectory = join(root, name); await mkdir(workingDirectory);
  const executable = join(root, `${name}.cjs`);
  await writeFile(executable, `#!${process.execPath}\nconst send = event => console.log(JSON.stringify(event));\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {\n${code}\n});\n`, { mode: 0o700 });
  const input: CodexWorkerInput = { workingDirectory, model: 'fixture-model', prompt: 'Authored SDK contract test only', toolPolicy: 'full-repo-shell-v1', historyPolicy: 'all-local-refs-v1',
    limits: { maxInputBytes: 32_768, maxOutputBytes: 32_768, maxArtifactBytes: 4096, maxArtifacts: 3, timeoutMs: 2000, cleanupTimeoutMs: 1500 } };
  const dependencies = { codexPathOverride: executable, boundary: { kind: 'authored-test-no-isolation' as const, fixtureRoot: root } };
  return { input, dependencies };
}
const events = (response = '{ok:true}') => `send({ type: 'thread.started', thread_id: 'authored-fixture-session' });
send({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: JSON.stringify(${response}) } });
send({ type: 'turn.completed', usage: ${JSON.stringify(usage)} });`;
async function failure(f: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) {
  try { await runCodexWorkspaceWorker(f.input, z.object({ ok: z.boolean() }).strict(), f.dependencies, signal); throw new Error('Unexpected success'); }
  catch (error) { expect(error).toBeInstanceOf(CodexWorkspaceWorkerError); return error as CodexWorkspaceWorkerError; }
}

describe('official SDK 0.159.2 with authored codexPathOverride (no auth, model, or sandbox calls)', () => {
  it('uses real SDK argument/config generation with a bounded executable and isolated empty environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-must-not-forward'); vi.stubEnv('CODEX_HOME', '/ambient/home');
    const f = await fixture('success', events('{ok:true, args:process.argv.slice(2), env:Object.keys(process.env).sort()}'));
    const schema = z.object({ ok: z.boolean(), args: z.array(z.string()), env: z.array(z.string()) }).strict();
    const result = await runCodexWorkspaceWorker(f.input, schema, f.dependencies);
    expect(result.value.ok).toBe(true); expect(result.sessionId).toBe('authored-fixture-session');
    expect(result.value.args.slice(0, 2)).toEqual(['exec', '--experimental-json']);
    expect(result.value.args).toEqual(expect.arrayContaining(['--model', 'fixture-model', '--cd', f.input.workingDirectory, '--sandbox', 'workspace-write', 'approval_policy="never"', 'sandbox_workspace_write.network_access=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'features.hooks=false', 'features.shell_tool=true']));
    expect(result.value.args).not.toContain('--skip-git-repo-check'); expect(result.value.args).not.toContain('--add-dir');
    expect(result.value.env).toEqual(['CODEX_HOME', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'HOME', 'LANG', 'LC_ALL', 'PATH']);
    expect(result.processEvidence).toMatchObject({ reason: 'completed', exitCode: 0, processGroupStopped: true });
    vi.unstubAllEnvs();
  });
  it('accepts progress messages followed by the last structured agent response', async () => {
    const f = await fixture('progress', `send({type:'item.completed',item:{id:'progress',type:'agent_message',text:'Inspecting the authored fixture'}}); ${events()}`);
    const result = await runCodexWorkspaceWorker(f.input, z.object({ok:z.boolean()}).strict(), f.dependencies);
    expect(result.value).toEqual({ok:true});
  });
  it('rejects schema errors after the real SDK completes', async () => {
    const error = await failure(await fixture('schema', events('{wrong:true}')));
    expect(error.processEvidence?.processGroupStopped).toBe(true); expect(error.retainedRuntimePath).toBeNull();
  });
  it('rejects nonzero exit even after a completion event', async () => {
    const error = await failure(await fixture('nonzero', `${events()}\nprocess.exitCode=23;`));
    expect(error.processEvidence).toMatchObject({ exitCode: 23, processGroupStopped: true });
  });
  it('rejects a missing completion instead of accepting partial output', async () => {
    const error = await failure(await fixture('partial', `send({type:'thread.started',thread_id:'partial'}); send({type:'item.completed',item:{id:'a',type:'agent_message',text:'{"ok":true}'}});`));
    expect(error.message).toMatch(/missing a unique completed result/);
  });
  it('times out a stalled executable and verifies its process group stopped', async () => {
    const f = await fixture('timeout', 'setInterval(() => {}, 1000);'); f.input.limits.timeoutMs = 100;
    const error = await failure(f);
    expect(error.processEvidence).toMatchObject({ reason: 'timeout', processGroupStopped: true });
  });
  it('cancels a running executable and verifies stop rather than treating abort as cleanup', async () => {
    const f = await fixture('cancel', `require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--cd')+1] + '/ready', 'ready'); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const pending = failure(f, controller.signal);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (await access(join(f.input.workingDirectory, 'ready')).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    expect((await pending).processEvidence).toMatchObject({ reason: 'cancelled', processGroupStopped: true });
  });
  it.each(['stdout', 'stderr'] as const)('bounds raw %s flooding before SDK JSONL/stderr buffering', async stream => {
    const f = await fixture(`flood-${stream}`, `setInterval(() => process.${stream}.write('x'.repeat(65536)), 1);`); f.input.limits.maxOutputBytes = 4096;
    const error = await failure(f);
    expect(error.processEvidence).toMatchObject({ reason: 'output-limit', processGroupStopped: true });
    expect(error.processEvidence!.forwardedBytes).toBeLessThanOrEqual(4096);
  });
  it('fails closed on malformed JSONL and unexpected MCP/web tools', async () => {
    expect((await failure(await fixture('jsonl', `console.log('invalid-json');`))).message).toMatch(/parse item/);
    const f = await fixture('mcp', `send({type:'item.started',item:{id:'m',type:'mcp_tool_call',server:'unexpected',tool:'run',arguments:{},status:'in_progress'}}); setInterval(() => {}, 1000);`);
    expect((await failure(f)).message).toMatch(/Unexpected workspace tool|cancelled/);
  });
  it('handles cancellation during SDK output-schema cleanup without an uncaught AbortError', async () => {
    const f = await fixture('late-cancel', `console.log('invalid-json'); setInterval(() => {},1000);`);
    const controller = new AbortController();
    const remove = fs.rm;
    const spy = vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
      if (String(path).includes('codex-output-schema-')) controller.abort();
      return remove(path, options);
    });
    try {
      const error = await failure(f, controller.signal);
      expect(controller.signal.aborted).toBe(true);
      expect(error.processEvidence?.processGroupStopped).toBe(true);
      expect(error.retainedRuntimePath).toBeNull();
    } finally { spy.mockRestore(); }
  });
  it('stops same-group background descendants after successful direct-child exit', async () => {
    const f = await fixture('descendant', `const child = require('node:child_process').spawn(${JSON.stringify(process.execPath)}, ['-e','setInterval(() => {}, 1000)'], {stdio:'ignore'}); child.unref(); ${events('{ok:true,pid:child.pid}')} `);
    const result = await runCodexWorkspaceWorker(f.input, z.object({ok:z.boolean(),pid:z.number().int()}), f.dependencies);
    const state = await readFile('/proc/' + result.value.pid + '/stat', 'utf8').then(text => text.slice(text.lastIndexOf(')') + 2).split(' ')[0], () => 'gone');
    expect(['gone', 'Z', 'X']).toContain(state);
    expect(result.processEvidence.processGroupStopped).toBe(true);
  });
  it('does not launch if the required isolated-runtime verification fails', async () => {
    const f = await fixture('boundary', events());
    await expect(runCodexWorkspaceWorker(f.input, z.object({ok:z.boolean()}), { ...f.dependencies, boundary: {kind:'isolated-runtime',verify:async()=>{throw new Error('Isolation not provisioned');}} })).rejects.toThrow('Isolation not provisioned');
    await expect(runCodexWorkspaceWorker(f.input, z.object({ok:z.boolean()}), f.dependencies, AbortSignal.abort())).rejects.toThrow(/cancelled before launch/);
  });
  it('rejects ancestor config and invalid limits before spawning', async () => {
    const f = await fixture('config', events());
    await mkdir(join(f.input.workingDirectory, '.codex'));
    await expect(runCodexWorkspaceWorker(f.input, z.object({ ok: z.boolean() }), f.dependencies)).rejects.toThrow(/configuration/);
    f.input.limits.maxInputBytes = 2;
    await expect(runCodexWorkspaceWorker(f.input, z.object({ ok: z.boolean() }), f.dependencies)).rejects.toThrow(/input\/schema/);
  });
});
