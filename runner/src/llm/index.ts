import type { EnvConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { OpenAIProvider } from './openai.js';
import type { LLMProvider, ProviderName } from './types.js';

export * from './types.js';
export * from './models.js';
export * from './schema.js';
export { withRetry } from './retry.js';
export { completeJSONWithRepair, JSONParseError } from './json.js';
export { MockProvider } from './mock.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export { GoogleProvider } from './google.js';

export function createProvider(name: Exclude<ProviderName, 'mock'>, apiKey: string): LLMProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(apiKey);
    case 'openai':
      return new OpenAIProvider(apiKey);
    case 'openrouter':
      return new OpenAIProvider(apiKey, 'openrouter');
    case 'google':
      return new GoogleProvider(apiKey);
  }
}

export interface DetectedProvider {
  provider: LLMProvider;
  name: Exclude<ProviderName, 'mock'>;
  apiKey: string;
}

/** Pick the first provider that has a key configured (BYOK — the benchcall design principles). */
export function detectProvider(env: EnvConfig): DetectedProvider | undefined {
  if (env.anthropicApiKey) {
    return { provider: new AnthropicProvider(env.anthropicApiKey), name: 'anthropic', apiKey: env.anthropicApiKey };
  }
  if (env.openaiApiKey) {
    return { provider: new OpenAIProvider(env.openaiApiKey), name: 'openai', apiKey: env.openaiApiKey };
  }
  if (env.googleApiKey) {
    return { provider: new GoogleProvider(env.googleApiKey), name: 'google', apiKey: env.googleApiKey };
  }
  if (env.openrouterApiKey) {
    return {
      provider: new OpenAIProvider(env.openrouterApiKey, 'openrouter'),
      name: 'openrouter',
      apiKey: env.openrouterApiKey,
    };
  }
  return undefined;
}
