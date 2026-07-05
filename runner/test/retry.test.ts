import { describe, expect, it } from 'vitest';
import { withRetry } from '../src/llm/retry.js';

describe('withRetry', () => {
  it('retries retryable status codes and succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('rate limited') as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          const err = new Error('bad request') as Error & { status: number };
          err.status = 400;
          throw err;
        },
        { retries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('bad request');
    expect(attempts).toBe(1);
  });

  it('times out hung calls', async () => {
    await expect(
      withRetry(() => new Promise(() => {}), { retries: 0, timeoutMs: 30, label: 'hung' }),
    ).rejects.toThrow(/timed out/);
  });
});
