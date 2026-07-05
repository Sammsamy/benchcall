import type { AgentConfig, TranscriptTurn } from '../core/types.js';
import type {
  AdapterCapabilities,
  AgentSession,
  AgentSummary,
  PlatformCallRecord,
  VoicePlatformAdapter,
} from './types.js';

/**
 * Deterministic adapter for unit tests. The "agent" replies from a scripted
 * list, so tests exercise the whole pipeline without network or keys.
 */
export class MockAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock';

  constructor(
    private readonly config: AgentConfig,
    private readonly scriptedReplies: string[] = [],
    private readonly recentCalls: PlatformCallRecord[] = [],
  ) {}

  capabilities(): AdapterCapabilities {
    return { textSessions: true, voiceTestCalls: false, latencyMetadata: false, audioInjection: false };
  }

  async listAgents(): Promise<AgentSummary[]> {
    return [{ id: this.config.id, name: this.config.name }];
  }

  async getAgentConfig(): Promise<AgentConfig> {
    return this.config;
  }

  async listRecentCalls(): Promise<PlatformCallRecord[]> {
    return this.recentCalls;
  }

  async createSession(): Promise<AgentSession> {
    const replies = [...this.scriptedReplies];
    const greeting = this.config.firstMessage ?? 'Hello, how can I help you today?';
    return {
      start: async (): Promise<TranscriptTurn> => ({ role: 'agent', text: greeting }),
      send: async (): Promise<TranscriptTurn> => ({
        role: 'agent',
        text: replies.shift() ?? 'Is there anything else I can help you with?',
      }),
      end: async () => {},
    };
  }
}
