import { z } from 'zod';

const NonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Keep only the compact colon-separated hexadecimal form, not arbitrary header text.
const RequestId = z.string().max(128).regex(/^[a-fA-F0-9]+(?::[a-fA-F0-9]+){3,4}$/);
export const GithubHttpFailureDiagnosticSchema = z.object({
  status: z.number().int().min(300).max(599),
  requestId: RequestId.optional(),
  rateLimitRemaining: NonnegativeInteger.optional(),
  rateLimitReset: NonnegativeInteger.optional(), // Server-declared Unix seconds.
  retryAfterSeconds: NonnegativeInteger.optional(),
  retryAfterAt: z.string().datetime().max(24).optional(),
}).strict().refine(value => value.retryAfterSeconds === undefined || value.retryAfterAt === undefined,
  'Retry-After must have only one representation');
export type GithubHttpFailureDiagnostic = z.infer<typeof GithubHttpFailureDiagnosticSchema>;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function integer(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.length <= 16 && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
function httpDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 29 || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toUTCString() === value ? date.toISOString() : undefined;
}

/** Select only validated response metadata from official Octokit's normalized error.
 * Do not inspect messages, response bodies, request headers/URLs, or nested causes.
 * Octokit also assigns status 500 to transport errors with no HTTP response; those
 * must not become HTTP observations. Missing/malformed fields are omitted, not guessed.
 */
export function githubHttpFailureDiagnostic(error: unknown): GithubHttpFailureDiagnostic | undefined {
  const response = record(record(error)?.response), status = response?.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 300 || status > 599) return undefined;
  const headers = record(response?.headers); // Octokit lowercases response header names.
  const requestId = RequestId.safeParse(headers?.['x-github-request-id']);
  const rateLimitRemaining = integer(headers?.['x-ratelimit-remaining']);
  const rateLimitReset = integer(headers?.['x-ratelimit-reset']);
  const retryAfterSeconds = integer(headers?.['retry-after']);
  const retryAfterAt = retryAfterSeconds === undefined ? httpDate(headers?.['retry-after']) : undefined;
  return {
    status,
    ...(requestId.success ? { requestId: requestId.data } : {}),
    ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
    ...(rateLimitReset === undefined ? {} : { rateLimitReset }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(retryAfterAt === undefined ? {} : { retryAfterAt }),
  };
}

export type GithubReadFailureClassification = {
  category: 'http-authentication' | 'http-forbidden' | 'http-rate-limit' | 'http-api' |
    'tls' | 'network-dns' | 'network-connection' | 'network-timeout' | 'transport-unknown';
  code?: string;
};
const transportCodes: Record<string, GithubReadFailureClassification['category']> = {
  CERT_HAS_EXPIRED: 'tls', DEPTH_ZERO_SELF_SIGNED_CERT: 'tls', SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls', ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED: 'tls',
  ENOTFOUND: 'network-dns', EAI_AGAIN: 'network-dns',
  ECONNREFUSED: 'network-connection', ECONNRESET: 'network-connection', ENETUNREACH: 'network-connection',
  EHOSTUNREACH: 'network-connection', UND_ERR_SOCKET: 'network-connection',
  ETIMEDOUT: 'network-timeout', UND_ERR_CONNECT_TIMEOUT: 'network-timeout',
  UND_ERR_HEADERS_TIMEOUT: 'network-timeout', UND_ERR_BODY_TIMEOUT: 'network-timeout',
};
/** Only fixed code enums from at most three own data-property cause links are inspected.
 * Transport-code inspection never invokes getters or reads messages, URLs or headers.
 * HTTP metadata selection uses the existing response diagnostic helper; raw causes are never emitted.
 * An SDK status without a real response does not establish an HTTP failure.
 */
export function classifyGithubReadFailure(error: unknown,
  http: GithubHttpFailureDiagnostic | undefined = githubHttpFailureDiagnostic(error)): GithubReadFailureClassification {
  if (http) return { category: http.status === 401 ? 'http-authentication' :
    http.status === 429 || http.status === 403 && http.rateLimitRemaining === 0 ? 'http-rate-limit' :
    http.status === 403 ? 'http-forbidden' : 'http-api' };
  let current = record(error);
  for (let depth = 0; current && depth < 3; depth++) {
    const code = Object.getOwnPropertyDescriptor(current, 'code')?.value;
    if (typeof code === 'string' && Object.hasOwn(transportCodes, code)) return { category: transportCodes[code], code };
    current = record(Object.getOwnPropertyDescriptor(current, 'cause')?.value);
  }
  return { category: 'transport-unknown' };
}

/** Deliberately drops the raw provider error, including credential-bearing causes. */
export class GithubReadError extends Error {
  constructor(endpoint: string, public readonly diagnostic?: GithubHttpFailureDiagnostic,
    public readonly classification: GithubReadFailureClassification = classifyGithubReadFailure(undefined, diagnostic)) {
    super(`GitHub read failed for ${endpoint}${diagnostic ? ` (HTTP ${diagnostic.status})` : ''}; no evidence produced`);
    this.name = 'GithubReadError';
  }
}
