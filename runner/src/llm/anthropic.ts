import Anthropic from '@anthropic-ai/sdk';
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

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private async createMessage(
    opts: CompleteOptions,
    outputConfig?: { format: { type: 'json_schema'; schema: Record<string, unknown> } },
  ) {
    const model = resolveModel('anthropic', opts.model, opts.tier);
    const response = await withRetry(
      () =>
        this.client.messages.create(
          {
            model,
            max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(opts.system ? { system: opts.system } : {}),
            messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
            ...(outputConfig ? { output_config: outputConfig } : {}),
          },
          { timeout: opts.timeoutMs ?? 120_000 },
        ),
      { timeoutMs: (opts.timeoutMs ?? 120_000) + 5_000, label: `anthropic:${model}` },
    );

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
    return { text, usage, costUsd: estimateCostUsd(model, usage), priced: hasPricing(model), model };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    return this.createMessage(opts);
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<JSONResult<T>> {
    const result = await this.createMessage(opts, {
      format: { type: 'json_schema', schema: strictify(opts.schema) },
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
      // Preserve the raw output so the repair round can show the model what
      // it produced (validation errors are the primary repair trigger).
      throw new JSONParseError(err instanceof Error ? err.message : String(err), result.text);
    }
    return { ...result, data, raw: result.text };
  }
}
