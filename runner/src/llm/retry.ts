import { LLMError } from './types.js';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  label?: string;
}

const DEFAULTS = { retries: 2, baseDelayMs: 750, maxDelayMs: 15_000, timeoutMs: 120_000 };

// Includes undici transport codes: Node's fetch wraps network failures in
// TypeError('fetch failed') with the real code on err.cause.
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'ABORT_ERR',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown, depth = 0): boolean {
  if (err == null || depth > 5) return false;
  if (err instanceof LLMError) return err.retryable;
  const status = (err as { status?: number }).status;
  if (typeof status === 'number') return status === 408 || status === 409 || status === 429 || status >= 500;
  const code = (err as { code?: string }).code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return true;
    if (err instanceof AggregateError && err.errors.some((e) => isRetryable(e, depth + 1))) return true;
    if (err.cause !== undefined) return isRetryable(err.cause, depth + 1);
  }
  return false;
}

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hard timeout + exponential backoff with jitter around any LLM call.
 * SDKs retry transient errors internally too; this is the outer safety net so
 * a single stuck call can never hang a whole run.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries, baseDelayMs, maxDelayMs, timeoutMs } = { ...DEFAULTS, ...opts };
  const label = opts.label ?? 'llm call';
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(fn, timeoutMs, label);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + Math.random());
      await sleep(delay);
    }
  }
  throw lastErr;
}
