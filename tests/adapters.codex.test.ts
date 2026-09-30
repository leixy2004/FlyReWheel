import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mock = vi.hoisted(() => ({ construct: vi.fn(), startThread: vi.fn(), runStreamed: vi.fn() }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class { constructor(options: unknown) { mock.construct(options); } startThread(options: unknown) { mock.startThread(options); return { id: 'mock-thread', runStreamed: mock.runStreamed }; } } }));
import { createCodexAgentAdapter } from '../src/adapters/codex-agent.js';
import { detectAstGrep } from '../src/adapters/ast-grep.js';
import type { ThreadEvent } from '@openai/codex-sdk';

const source = 'const x = eval(input);';
const candidate = detectAstGrep({ source, path: 'input.ts', language: 'typescript', pattern: 'eval($ARG)', ruleId: 'eval-rule', ruleVersion: '1', bundleDigest: 'a'.repeat(64) })[0];
const skill = { title: 'No dynamic eval', invariant: 'Reject global eval of untrusted input', applicability: ['Global eval'], exceptions: ['Local non-executing binding'], requiredContext: ['binding-resolution'] };
const input = { candidate, source, skill, evidence: [{ id: 'binding-1', kind: 'binding-resolution', content: 'Global eval, not shadowed. Input is untrusted.' }] };
const config = { enabled: true, auth: { mode: 'api_key' as const, apiKey: 'test-placeholder-not-a-real-key' }, model: 'test-model', timeoutMs: 10_000, maxReportedTokens: 10_000 };
const decision = { decision: 'violation', reasoning: 'Supplied context resolves global eval and untrusted input.', evidenceRefs: ['binding-1'] };
const usage = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 };
function events(value: unknown, extras: ThreadEvent[] = []) {
  mock.runStreamed.mockImplementation(async () => ({ events: (async function* () { for (const event of extras) yield event; yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: JSON.stringify(value) } }; yield { type: 'turn.completed', usage }; })() }));
}
beforeEach(() => { vi.clearAllMocks(); events(decision); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('official Codex SDK contract (mocked, no model/network calls)', () => {
  it('uses schema output and independent read-only, shell-disabled, isolated sessions', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-must-not-leak');
    vi.stubEnv('CODEX_HOME', '/ambient/must-not-be-used');
    const adapter = createCodexAgentAdapter(config);
    const result = await adapter.adjudicate(input);
    expect(result.execution).toBe('succeeded');
    expect(result.adjudication?.source).toBe('agent');
    expect(result.metadata).toMatchObject({ mode: 'codex_sdk', model: 'test-model', costUsd: null });
    const options = mock.construct.mock.calls[0][0];
    expect(options.apiKey).toBe(config.auth.apiKey);
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.CODEX_HOME).not.toBe('/ambient/must-not-be-used');
    expect(options.config.features).toMatchObject({ shell_tool: false, unified_exec: false, hooks: false, multi_agent: false });
    expect(mock.startThread.mock.calls[0][0]).toMatchObject({ sandboxMode: 'read-only', networkAccessEnabled: false, webSearchMode: 'disabled', approvalPolicy: 'never', additionalDirectories: [] });
    expect(mock.runStreamed.mock.calls[0][1].outputSchema).toMatchObject({ type: 'object' });
    expect(mock.runStreamed.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await expect(access(options.env.HOME)).rejects.toThrow();
    await adapter.adjudicate(input);
    expect(mock.startThread).toHaveBeenCalledTimes(2);
  });
  it('does not instantiate the SDK when disabled or when required evidence is missing', async () => {
    expect((await createCodexAgentAdapter({ ...config, enabled: false }).adjudicate(input)).execution).toBe('failed');
    const missing = await createCodexAgentAdapter(config).adjudicate({ ...input, evidence: [] });
    expect(missing.adjudication?.decision).toBe('unknown');
    expect(missing.metadata.origin).toBe('evidence_gate');
    expect(mock.construct).not.toHaveBeenCalled();
  });
  it('fails closed on fabricated evidence, malformed output and tool activity', async () => {
    events({ ...decision, evidenceRefs: ['invented'] });
    expect((await createCodexAgentAdapter(config).adjudicate(input)).execution).toBe('failed');
    events({ decision: 'TP' });
    expect((await createCodexAgentAdapter(config).adjudicate(input)).execution).toBe('failed');
    events(decision, [{ type: 'item.started', item: { id: 'bad', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' } }]);
    expect((await createCodexAgentAdapter(config).adjudicate(input)).error).toContain('Unexpected tool activity');
  });
  it('preserves runtime failure rather than converting it into a safe verdict', async () => {
    events(decision, [{ type: 'turn.failed', error: { message: 'provider unavailable' } }]);
    const result = await createCodexAgentAdapter(config).adjudicate(input);
    expect(result.execution).toBe('failed'); expect(result.adjudication).toBeNull();
  });
  it('times out stalled SDK calls with an abort signal', async () => {
    mock.runStreamed.mockImplementation(async () => ({ events: (async function* () { await new Promise(() => {}); })() }));
    const result = await createCodexAgentAdapter({ ...config, timeoutMs: 5 }).adjudicate(input);
    expect(result.error).toContain('timed out');
    expect(mock.runStreamed.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('checks actual native pre/post structural replay before returning a synthesis draft', async () => {
    events({ result: { status: 'candidate', skill, detector: { kind: 'ast-grep', language: 'typescript', pattern: 'eval($ARG)' }, supportingCaseIds: ['training-1'], reasoning: 'The bug fix replaced code execution with JSON parsing.' } });
    const result = await createCodexAgentAdapter(config).synthesize({ goal: 'Find unsafe eval', pairs: [{ caseId: 'training-1', split: 'training', path: 'input.ts', language: 'typescript', before: source, after: 'const x = JSON.parse(input);', problem: 'Untrusted source was evaluated', evidenceRefs: ['case://training-1'] }] });
    expect(result).toMatchObject({ execution: 'succeeded', status: 'draft_requires_review', validations: [{ beforeMatches: 1, afterMatches: 0 }] });
  });
  it('accepts Python synthesis and replays the official native Python grammar', async () => {
    events({ result: { status: 'candidate', skill, detector: { kind: 'ast-grep', language: 'python', pattern: 'unsafe_load($X)' }, supportingCaseIds: ['python-training-1'], reasoning: 'The fix replaced unsafe deserialization.' } });
    const result = await createCodexAgentAdapter(config).synthesize({ goal: 'Avoid unsafe loading', pairs: [{ caseId: 'python-training-1', split: 'training', path: 'input.py', language: 'python', before: 'value = unsafe_load(text)\n', after: 'value = safe_load(text)\n', problem: 'Unsafe deserialization', evidenceRefs: ['case://python-training-1'] }] });
    expect(result).toMatchObject({ execution: 'succeeded', status: 'draft_requires_review', draft: { detector: { language: 'python' } }, validations: [{ beforeMatches: 1, afterMatches: 0 }] });
  });
  it('keeps a high-recall candidate after a guarding fix and requires semantic regression', async () => {
    events({ result: { status: 'candidate', skill, detector: { kind: 'ast-grep', language: 'python', pattern: 'tokens[-count:]' }, supportingCaseIds: ['guard-training-1'], reasoning: 'A zero-length suffix must return an empty list rather than the whole list.' } });
    const result = await createCodexAgentAdapter(config).synthesize({ goal: 'Validate suffix length behavior', pairs: [{ caseId: 'guard-training-1', split: 'training', path: 'suffix.py', language: 'python', before: 'def suffix(tokens, count):\n    return tokens[-count:]\n', after: 'def suffix(tokens, count):\n    if count == 0:\n        return []\n    return tokens[-count:]\n', problem: 'Zero count returned all tokens', evidenceRefs: ['case://guard-training-1'] }] });
    expect(result).toMatchObject({ execution: 'succeeded', status: 'draft_requires_review', validations: [{ beforeMatches: 1, afterMatches: 1, requiresSemanticValidation: true }] });
  });
  it('accepts insufficient evidence as zero rules without structural replay', async () => {
    events({ result: { status: 'insufficient_evidence', reasoning: 'This one-off change does not establish a reusable invariant.', missingEvidence: ['A second independent failure with the same cause'] } });
    // Invalid parser inputs are intentional: no detector may be run for a no-rule response.
    const result = await createCodexAgentAdapter(config).synthesize({ goal: 'Consider a rule', pairs: [{ caseId: 'training-1', split: 'training', path: 'input.ts', language: 'typescript', before: 'const invalid = {', after: 'const alsoInvalid = {', problem: 'Cause is not established', evidenceRefs: ['case://training-1'] }] });
    expect(result).toMatchObject({ execution: 'succeeded', status: 'no_rule', draft: null, validations: [], missingEvidence: ['A second independent failure with the same cause'] });
    expect(mock.runStreamed.mock.calls[0][1].outputSchema).toMatchObject({ type: 'object', properties: { result: {} } });
    expect(mock.runStreamed.mock.calls[0][0]).toContain('zero proposed rules is a valid successful result');
  });
  it('rejects heldout synthesis data without a model call', async () => {
    const result = await createCodexAgentAdapter(config).synthesize({ goal: 'rule', pairs: [{ caseId: 'holdout', split: 'holdout' as 'training', path: 'x.ts', language: 'typescript', before: source, after: 'ok()', problem: 'bug', evidenceRefs: ['case://heldout'] }] });
    expect(result.execution).toBe('failed'); expect(mock.construct).not.toHaveBeenCalled();
  });
  it('allows explicit login-only home without reading credentials and rejects configuration files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'flyrewheel-test-login-'));
    try {
      await writeFile(join(home, 'auth.json'), 'NOT VALID JSON: this must never be parsed');
      const adapter = createCodexAgentAdapter({ ...config, auth: { mode: 'dedicated_login', codexHome: home } });
      expect((await adapter.adjudicate(input)).execution).toBe('succeeded');
      expect(mock.construct.mock.calls[0][0]).not.toHaveProperty('apiKey');
      expect(mock.construct.mock.calls[0][0].env.CODEX_HOME).toBe(home);
      await writeFile(join(home, 'config.toml'), '[mcp_servers.bad]');
      expect((await adapter.adjudicate(input)).error).toContain('configuration');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
