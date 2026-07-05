import { GoogleGenAI } from '@google/genai';
import { estimateCostUsd, hasPricing, resolveModel } from './models.js';
import { withRetry } from './retry.js';
import { forGoogle } from './schema.js';
import { JSONParseError } from './json.js';
import type {
  CompleteJSONOptions,
  CompleteOptions,
  CompleteResult,
  JSONResult,
  LLMProvider,
} from './types.js';

const DEFAULT_MAX_TOKENS = 4096;

export class GoogleProvider implements LLMProvider {
  readonly name = 'google' as const;
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  private async generate(opts: CompleteOptions, json?: { schema: Record<string, unknown> }) {
    const model = resolveModel('google', opts.model, opts.tier);
    const response = await withRetry(
      () =>
        this.client.models.generateContent({
          model,
          contents: opts.messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          config: {
            ...(opts.system ? { systemInstruction: opts.system } : {}),
            maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            // responseJsonSchema (standard JSON Schema) is the current field;
            // responseSchema (OpenAPI subset) is being phased out. Verified in
            // @google/genai 2.10.0 typings 2026-07-04.
            ...(json
              ? { responseMimeType: 'application/json', responseJsonSchema: forGoogle(json.schema) }
              : {}),
          },
        }),
      { timeoutMs: (opts.timeoutMs ?? 120_000) + 5_000, label: `google:${model}` },
    );

    const text = response.text ?? '';
    const usage = {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
    return { text, usage, costUsd: estimateCostUsd(model, usage), priced: hasPricing(model), model };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    return this.generate(opts);
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<JSONResult<T>> {
    const result = await this.generate(opts, { schema: opts.schema });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch (err) {
      throw new JSONParseError(String(err), result.text);
    }
    let data: T;
    try {
      data = opts.validate(parsed);
    } catch (err) {
      throw new JSONParseError(err instanceof Error ? err.message : String(err), result.text);
    }
    return { ...result, data, raw: result.text };
  }
}
