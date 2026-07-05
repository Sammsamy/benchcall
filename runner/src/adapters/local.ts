import type { AgentConfig, TranscriptTurn } from '../core/types.js';
import type { ChatMessage, LLMProvider } from '../llm/types.js';
import type { CostTracker } from '../llm/cost.js';
import type {
  AdapterCapabilities,
  AgentSession,
  AgentSummary,
  PlatformCallRecord,
  VoicePlatformAdapter,
} from './types.js';

/**
 * Emulates the voice agent locally from its config (system prompt + first
 * message) using an LLM on the customer's key. Lets anyone run the full
 * generate → simulate → judge loop with no platform account.
 *
 * Honesty note: this tests the agent's *prompt and logic*, not the
 * deployed telephony stack — reports label it as emulation.
 */
export interface LocalAdapterOptions {
  model?: string;
  /** Emulation spend counts toward the run's cost report. */
  costs?: CostTracker;
}

export class LocalAdapter implements VoicePlatformAdapter {
  readonly platform = 'local';

  constructor(
    private readonly config: AgentConfig,
    private readonly llm: LLMProvider,
    private readonly opts: LocalAdapterOptions = {},
  ) {}

  capabilities(): AdapterCapabilities {
    return { textSessions: true, voiceTestCalls: false, latencyMetadata: true, audioInjection: false };
  }

  async listAgents(): Promise<AgentSummary[]> {
    return [{ id: this.config.id, name: this.config.name }];
  }

  async getAgentConfig(): Promise<AgentConfig> {
    return this.config;
  }

  async listRecentCalls(): Promise<PlatformCallRecord[]> {
    return [];
  }

  async createSession(): Promise<AgentSession> {
    const history: ChatMessage[] = [];
    const system = [
      this.config.systemPrompt,
      'You are on a live phone call. Respond with ONLY your next spoken line — short, natural, no stage directions, no markdown.',
    ].join('\n\n');

    const reply = async (): Promise<TranscriptTurn> => {
      const startedAt = Date.now();
      const result = await this.llm.complete({
        system,
        messages: history,
        model: this.opts.model,
        tier: 'cheap',
        maxTokens: 300,
      });
      this.opts.costs?.add(result.costUsd, result.priced);
      const text = result.text.trim();
      history.push({ role: 'assistant', content: text });
      return { role: 'agent', text, latencyMs: Date.now() - startedAt };
    };

    return {
      start: async (): Promise<TranscriptTurn> => {
        // History must open with a user turn — Anthropic and Gemini reject
        // conversations whose first message is the assistant's.
        history.push({ role: 'user', content: '[The phone connects.]' });
        if (this.config.firstMessage) {
          history.push({ role: 'assistant', content: this.config.firstMessage });
          return { role: 'agent', text: this.config.firstMessage };
        }
        return reply();
      },
      send: async (text: string): Promise<TranscriptTurn> => {
        history.push({ role: 'user', content: text });
        return reply();
      },
      end: async () => {},
    };
  }
}
