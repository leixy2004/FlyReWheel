import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ construct: vi.fn(), create: vi.fn() }));
vi.mock('openai', () => ({ default: class { chat = { completions: { create: mock.create } }; constructor(options: unknown) { mock.construct(options); } } }));
import { createOpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { detectAstGrep } from '../src/adapters/ast-grep.js';

const config = { enabled: true, baseURL: 'http://inference.flyrewheel.svc.cluster.local:8000/v1', apiKey: 'explicit-local-placeholder', model: 'local-model', timeoutMs: 30_000, maxOutputTokens: 1_000, responseFormat: 'json_schema' as const };
const source = 'eval(input);';
const candidate = detectAstGrep({ source, path: 'x.ts', language: 'typescript', pattern: 'eval($X)', ruleId: 'eval', ruleVersion: '1', bundleDigest: 'a'.repeat(64) })[0];
const input = { candidate, source, skill: { title: 'No eval', invariant: 'Do not eval untrusted code', applicability: ['global eval'], exceptions: [], requiredContext: ['binding'] }, evidence: [{ id: 'binding-1', kind: 'binding', content: 'Resolves to global eval; input is untrusted.' }] };
const decision = { decision: 'violation', reasoning: 'The supplied binding evidence establishes applicability.', evidenceRefs: ['binding-1'] };
beforeEach(() => { vi.clearAllMocks(); mock.create.mockResolvedValue({ id: 'mock-request', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }); });

describe('OpenAI-compatible adapter (mocked SDK, no inference)', () => {
  it('uses only explicitly configured endpoint/auth with no tools or retries', async () => {
    const result = await createOpenAICompatibleAdapter(config).adjudicate(input);
    expect(result.execution).toBe('succeeded');
    expect(result.metadata).toMatchObject({ mode: 'openai_compatible', costUsd: null, usage: { inputTokens: 10, outputTokens: 20 } });
    expect(mock.construct).toHaveBeenCalledWith({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 0 });
    expect(mock.create.mock.calls[0][0]).toMatchObject({ tools: [], store: false, max_completion_tokens: 1_000, response_format: { type: 'json_schema', json_schema: { strict: true } } });
  });
  it('never silently falls back if provider rejects strict JSON schema', async () => {
    mock.create.mockRejectedValue(new Error('json_schema unsupported by this provider'));
    const result = await createOpenAICompatibleAdapter(config).adjudicate(input);
    expect(result.execution).toBe('failed'); expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it('permits JSON-only mode only by explicit config and still validates output', async () => {
    const result = await createOpenAICompatibleAdapter({ ...config, responseFormat: 'json_object' }).adjudicate(input);
    expect(result.execution).toBe('succeeded');
    expect(mock.create.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
    expect(mock.create.mock.calls[0][0].messages[1].content).toContain('conforming to this schema');
  });
  it('abstains before SDK/network use on missing evidence and rejects truncated outputs', async () => {
    expect((await createOpenAICompatibleAdapter(config).adjudicate({ ...input, evidence: [] })).adjudication?.decision).toBe('unknown');
    expect(mock.construct).not.toHaveBeenCalled();
    mock.create.mockResolvedValue({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(decision) } }] });
    expect((await createOpenAICompatibleAdapter(config).adjudicate(input)).execution).toBe('failed');
  });
  it('accepts a no-rule synthesis response without requiring a detector', async () => {
    mock.create.mockResolvedValue({ id: 'mock-no-rule', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ result: { status: 'insufficient_evidence', reasoning: 'No shared failure mechanism is established.', missingEvidence: ['Root-cause evidence'] } }) } }] });
    const result = await createOpenAICompatibleAdapter(config).synthesize({ goal: 'Find a reusable rule', pairs: [{ caseId: 'training-1', split: 'training', path: 'x.ts', language: 'typescript', before: 'const invalid = {', after: 'const stillInvalid = {', problem: 'Unknown root cause', evidenceRefs: ['case://training-1'] }] });
    expect(result).toMatchObject({ execution: 'succeeded', status: 'no_rule', draft: null, validations: [], reasoning: 'No shared failure mechanism is established.' });
    expect(mock.create.mock.calls[0][0].response_format.json_schema.schema).toMatchObject({ type: 'object', properties: { result: {} } });
  });
  it('replays a candidate synthesis response through the native scanner', async () => {
    mock.create.mockResolvedValue({ id: 'mock-candidate', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ result: { status: 'candidate', skill: input.skill, detector: { kind: 'ast-grep', language: 'typescript', pattern: 'eval($X)' }, supportingCaseIds: ['training-1'], reasoning: 'The fix removes executable input.' } }) } }] });
    const result = await createOpenAICompatibleAdapter(config).synthesize({ goal: 'Avoid dynamic eval', pairs: [{ caseId: 'training-1', split: 'training', path: 'x.ts', language: 'typescript', before: source, after: 'JSON.parse(input);', problem: 'Untrusted code execution', evidenceRefs: ['case://training-1'] }] });
    expect(result).toMatchObject({ execution: 'succeeded', status: 'draft_requires_review', draft: { status: 'candidate' }, validations: [{ beforeMatches: 1, afterMatches: 0 }] });
  });
  it('makes disabled live mode fail without constructing a client', async () => {
    expect((await createOpenAICompatibleAdapter({ ...config, enabled: false }).adjudicate(input)).error).toContain('disabled');
    expect(mock.construct).not.toHaveBeenCalled();
  });
});
