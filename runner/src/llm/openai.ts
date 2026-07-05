import OpenAI from 'openai';
import { estimateCostUsd, hasPricing, resolveModel } from './models.js';
import { withRetry } from './retry.js';
import { strictify } from './schema.js';
import { JSONParseError } from './json.js';
import type {
  CompleteJSONOptions,
  CompleteOptions,
  CompleteResult,
  JSONResult,
  LLMProvider,
} from './types.js';

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Serves both OpenAI directly and OpenRouter (an OpenAI-compatible gateway to
 * many providers' models with pass-through token pricing) — same wire format,
 * different base URL and model catalog.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name: 'openai' | 'openrouter';
  private client: OpenAI;

  constructor(apiKey: string, flavor: 'openai' | 'openrouter' = 'openai') {
    this.name = flavor;
    this.client = new OpenAI({
      apiKey,
      ...(flavor === 'openrouter' ? { baseURL: 'https://openrouter.ai/api/v1' } : {}),
    });
  }

  private async createCompletion(
    opts: CompleteOptions,
    responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'],
  ) {
    const model = resolveModel(this.name, opts.model, opts.tier);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const response = await withRetry(
      () =>
        this.client.chat.completions.create(
          {
            model,
            messages,
            max_completion_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(responseFormat ? { response_format: responseFormat } : {}),
          },
          { timeout: opts.timeoutMs ?? 120_000 },
        ),
      { timeoutMs: (opts.timeoutMs ?? 120_000) + 5_000, label: `${this.name}:${model}` },
    );

    const text = response.choices[0]?.message?.content ?? '';
    const usage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
    return { text, usage, costUsd: estimateCostUsd(model, usage), priced: hasPricing(model), model };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    return this.createCompletion(opts);
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<JSONResult<T>> {
    const result = await this.createCompletion(opts, {
      type: 'json_schema',
      json_schema: { name: opts.schemaName, strict: true, schema: strictify(opts.schema) },
    });
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
