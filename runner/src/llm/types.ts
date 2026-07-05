export type ProviderName = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'mock';

/** quality = generation-engine class; cheap = high-volume judge class. */
export type ModelTier = 'quality' | 'cheap';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  system?: string;
  messages: ChatMessage[];
  /** Explicit model id; when omitted, `tier` picks the provider default. */
  model?: string;
  tier?: ModelTier;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompleteResult {
  text: string;
  usage: LLMUsage;
  costUsd: number;
  /** False when the model has no PRICING entry — costUsd is 0, not free. */
  priced: boolean;
  model: string;
}

export interface CompleteJSONOptions<T> extends CompleteOptions {
  /** Short identifier for the schema (some providers require a name). */
  schemaName: string;
  /** Plain JSON Schema object guiding the provider's structured output. */
  schema: Record<string, unknown>;
  /** Runtime validation (typically zod .parse); throw to trigger repair. */
  validate: (raw: unknown) => T;
}

export interface JSONResult<T> {
  data: T;
  usage: LLMUsage;
  costUsd: number;
  /** False when the model has no PRICING entry — costUsd is 0, not free. */
  priced: boolean;
  model: string;
  raw: string;
}

export interface LLMProvider {
  readonly name: ProviderName;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
  completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<JSONResult<T>>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
