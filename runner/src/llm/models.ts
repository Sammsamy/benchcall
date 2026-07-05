import type { LLMUsage, ModelTier, ProviderName } from './types.js';

/**
 * Default model per provider and tier. Every call site can override.
 * IDs and prices verified against official provider docs + npm SDK typings on
 * 2026-07-04 (adversarially re-checked). Single place to
 * update as providers ship new models.
 */
export const DEFAULT_MODELS: Record<Exclude<ProviderName, 'mock'>, Record<ModelTier, string>> = {
  anthropic: { quality: 'claude-opus-4-8', cheap: 'claude-haiku-4-5' },
  openai: { quality: 'gpt-5.5', cheap: 'gpt-5.4-mini' },
  google: { quality: 'gemini-3.5-flash', cheap: 'gemini-2.5-flash' },
  // OpenRouter proxies other providers' models at pass-through token prices
  // (slugs + structured-output support verified against its live catalog
  // 2026-07-04). One key, any model.
  openrouter: { quality: 'openai/gpt-5.5', cheap: 'anthropic/claude-haiku-4.5' },
};

/** USD per million tokens. Estimates for user-facing cost logging, not billing. */
export const PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  'claude-opus-4-8': { inPerM: 5, outPerM: 25 },
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5 },
  'gpt-5.5': { inPerM: 5, outPerM: 30 },
  'gpt-5.4-mini': { inPerM: 0.75, outPerM: 4.5 },
  'gpt-5.4-nano': { inPerM: 0.2, outPerM: 1.25 },
  'gemini-2.5-flash': { inPerM: 0.3, outPerM: 2.5 },
  'gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4 },
  'gemini-3.1-flash-lite': { inPerM: 0.25, outPerM: 1.5 },
  'gemini-3.5-flash': { inPerM: 1.5, outPerM: 9 },
  // OpenRouter slugs (same underlying prices, verified from its catalog):
  'openai/gpt-5.5': { inPerM: 5, outPerM: 30 },
  'openai/gpt-5.4-mini': { inPerM: 0.75, outPerM: 4.5 },
  'openai/gpt-5.4-nano': { inPerM: 0.2, outPerM: 1.25 },
  'anthropic/claude-haiku-4.5': { inPerM: 1, outPerM: 5 },
  'google/gemini-2.5-flash': { inPerM: 0.3, outPerM: 2.5 },
  'google/gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4 },
  'deepseek/deepseek-v4-flash': { inPerM: 0.09, outPerM: 0.18 },
  'deepseek/deepseek-v4-pro': { inPerM: 0.435, outPerM: 0.87 },
};

export function resolveModel(
  provider: Exclude<ProviderName, 'mock'>,
  model: string | undefined,
  tier: ModelTier | undefined,
): string {
  return model ?? DEFAULT_MODELS[provider][tier ?? 'cheap'];
}

export function hasPricing(model: string): boolean {
  return Boolean(PRICING[model]);
}

export function estimateCostUsd(model: string, usage: LLMUsage): number {
  const p = PRICING[model];
  if (!p) return 0; // unknown model — report zero rather than a made-up number
  return (usage.inputTokens * p.inPerM + usage.outputTokens * p.outPerM) / 1_000_000;
}
