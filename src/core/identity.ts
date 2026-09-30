import { createHash } from 'node:crypto';
import { RuleBundleSchema, type RuleBundle } from './model.js';

/** Stable canonical JSON, rejecting unsupported values instead of silently dropping identity fields. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!(i in value)) throw new Error('Canonical JSON rejects sparse arrays');
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new Error('Canonical JSON accepts only JSON values');
}
export function digestOf(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function bundleDigest(bundle: RuleBundle): string { return digestOf(RuleBundleSchema.parse(bundle)); }
