import type { CompleteJSONOptions, JSONResult, LLMProvider } from './types.js';

/** Model produced output that failed JSON.parse or schema validation. */
export class JSONParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'JSONParseError';
  }
}

/**
 * completeJSON with one repair round: if the model's output fails parsing or
 * validation, re-prompt with the error attached so it can correct itself.
 * Providers enforce schemas natively, so repairs are rare — but validation is
 * the contract the rest of the pipeline relies on (the benchcall design principles: tests for
 * generation-engine JSON validation).
 */
export async function completeJSONWithRepair<T>(
  provider: LLMProvider,
  opts: CompleteJSONOptions<T>,
  repairs = 1,
): Promise<JSONResult<T> & { repaired: boolean }> {
  let lastError: unknown;
  let lastRaw = '';
  for (let attempt = 0; attempt <= repairs; attempt++) {
    const attemptOpts =
      attempt === 0
        ? opts
        : {
            ...opts,
            messages: [
              ...opts.messages,
              {
                role: 'assistant' as const,
                // Never send empty content — Anthropic rejects empty
                // non-final assistant messages with a 400.
                content: lastRaw.slice(0, 8_000) || '(previous output was not captured)',
              },
              {
                role: 'user' as const,
                content: `Your previous response was not valid against the required schema. Error: ${
                  lastError instanceof Error ? lastError.message.slice(0, 2_000) : String(lastError).slice(0, 2_000)
                }\nRespond again with ONLY corrected JSON matching the schema.`,
              },
            ],
          };
    try {
      const result = await provider.completeJSON(attemptOpts);
      return { ...result, repaired: attempt > 0 };
    } catch (err) {
      lastError = err;
      lastRaw = err instanceof JSONParseError ? err.raw : '';
      if (attempt === repairs) break;
    }
  }
  throw lastError;
}
