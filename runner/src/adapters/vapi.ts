import type { AgentConfig, TranscriptTurn } from '../core/types.js';
import { withRetry } from '../llm/retry.js';
import type {
  AdapterCapabilities,
  AgentSession,
  AgentSummary,
  PlatformCallRecord,
  VoicePlatformAdapter,
} from './types.js';

/**
 * Vapi adapter. Endpoint shapes verified against the live OpenAPI spec
 * (https://api.vapi.ai/api-json) on 2026-07-04:
 * - Bearer auth with the PRIVATE dashboard key (no granular scopes exist).
 * - GET /assistant, /assistant/{id}: system prompt at model.messages[role=system];
 *   `model` is a 16-way provider union — parse defensively.
 * - GET /call: transcript + per-turn latency under call.artifact (NOT top-level).
 * - POST /chat: text-only sessions; reply at output[0].content; multi-turn via
 *   previousChatId.
 * Vapi has NO API version pinning — schemas evolve in place, so everything
 * here treats fields as optional. Note: pay-as-you-go plans retain calls only
 * ~14 days, so passive scoring must pull recent calls promptly.
 */

const BASE_URL = 'https://api.vapi.ai';

interface VapiChatResponse {
  id?: string;
  output?: Array<{ role?: string; content?: string }>;
}

export class VapiAdapter implements VoicePlatformAdapter {
  readonly platform = 'vapi';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = BASE_URL,
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      textSessions: true, // POST /chat
      voiceTestCalls: true, // POST /call (not used in Phase 1 CLI)
      latencyMetadata: true, // call.artifact.performanceMetrics on voice calls
      audioInjection: false, // noise/accent conditions not injectable via API
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const hint =
            response.status === 401
              ? ' (check VAPI_API_KEY — it must be the PRIVATE key from the Vapi dashboard)'
              : '';
          const err = new Error(`Vapi ${method} ${path} failed: ${response.status}${hint} ${text.slice(0, 300)}`);
          (err as { status?: number }).status = response.status;
          throw err;
        }
        return (await response.json()) as T;
      },
      // Vapi publishes no rate limits; back off on 429/5xx ourselves.
      { label: `vapi:${path}`, timeoutMs: 65_000 },
    );
  }

  async listAgents(): Promise<AgentSummary[]> {
    const assistants = await this.request<Array<{ id: string; name?: string }>>('GET', '/assistant?limit=100');
    return assistants.map((a) => ({ id: a.id, name: a.name ?? '(unnamed assistant)' }));
  }

  async getAgentConfig(agentId: string): Promise<AgentConfig> {
    const assistant = await this.request<{
      id: string;
      name?: string;
      firstMessage?: string;
      firstMessageMode?: string;
      model?: {
        provider?: string;
        model?: string;
        messages?: Array<{ role?: string; content?: string }>;
        tools?: unknown[];
      };
      voice?: { provider?: string; voiceId?: string };
    }>('GET', `/assistant/${agentId}`);

    const systemPrompt =
      assistant.model?.messages?.find((m) => m.role === 'system')?.content ?? '';

    return {
      id: assistant.id,
      name: assistant.name ?? '(unnamed assistant)',
      platform: 'vapi',
      systemPrompt,
      firstMessage:
        assistant.firstMessageMode === 'assistant-waits-for-user' ? undefined : assistant.firstMessage,
      model: assistant.model?.model,
      voice: assistant.voice?.voiceId,
      tools: assistant.model?.tools,
      raw: assistant,
    };
  }

  async listRecentCalls(agentId: string, limit = 25): Promise<PlatformCallRecord[]> {
    const calls = await this.request<
      Array<{
        id: string;
        startedAt?: string;
        endedAt?: string;
        createdAt?: string;
        cost?: number;
        endedReason?: string;
        artifact?: {
          messages?: Array<{ role?: string; message?: string; duration?: number }>;
          performanceMetrics?: { turnLatencies?: Array<{ turnLatency?: number }> };
        };
      }>
    >('GET', `/call?assistantId=${encodeURIComponent(agentId)}&limit=${limit}`);

    return calls.map((call) => {
      const latencies = call.artifact?.performanceMetrics?.turnLatencies ?? [];
      let agentTurnIndex = 0;
      const transcript: TranscriptTurn[] = (call.artifact?.messages ?? [])
        .filter((m) => (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.message)
        .map((m) => {
          const isAgent = m.role !== 'user';
          const turn: TranscriptTurn = { role: isAgent ? 'agent' : 'caller', text: m.message! };
          if (isAgent) {
            // Approximate mapping: nth agent turn ↔ nth turn latency.
            const latency = latencies[agentTurnIndex++]?.turnLatency;
            if (latency !== undefined) turn.latencyMs = latency;
          }
          return turn;
        });
      return {
        id: call.id,
        startedAt: call.startedAt ?? call.createdAt ?? '',
        endedAt: call.endedAt,
        transcript,
        costUsd: call.cost,
        metadata: { endedReason: call.endedReason },
      };
    });
  }

  /**
   * Write a revised system prompt back to the live assistant.
   * PATCH /assistant/{id} — `model` is replaced wholesale, so we send the
   * assistant's current model object with only the system message swapped.
   * Only ever called behind an explicit human confirmation.
   */
  async updateSystemPrompt(agentId: string, systemPrompt: string): Promise<void> {
    const assistant = await this.request<{
      model?: { messages?: Array<{ role?: string; content?: string }> } & Record<string, unknown>;
    }>('GET', `/assistant/${agentId}`);
    if (!assistant.model) {
      throw new Error('assistant has no model object — update it in the Vapi dashboard instead');
    }
    const messages = Array.isArray(assistant.model.messages) ? [...assistant.model.messages] : [];
    const systemIndex = messages.findIndex((m) => m.role === 'system');
    if (systemIndex >= 0) messages[systemIndex] = { ...messages[systemIndex], content: systemPrompt };
    else messages.unshift({ role: 'system', content: systemPrompt });
    await this.request('PATCH', `/assistant/${agentId}`, {
      model: { ...assistant.model, messages },
    });
  }

  /**
   * Text session over POST /chat. This exercises the assistant's model/prompt
   * through Vapi's own pipeline but NOT the voice path (STT/TTS/latency) —
   * reports must not claim voice-pipeline coverage from chat runs. Chat calls
   * bill to the customer's Vapi account like other usage.
   */
  async createSession(agentId: string): Promise<AgentSession> {
    // Fetch config once so start() can report the greeting the way a phone
    // caller would hear it.
    const config = await this.getAgentConfig(agentId);
    const adapter = this;
    let previousChatId: string | undefined;

    const send = async (text: string): Promise<TranscriptTurn> => {
      const startedAt = Date.now();
      const chat = await adapter.request<VapiChatResponse>('POST', '/chat', {
        assistantId: agentId,
        input: text,
        ...(previousChatId ? { previousChatId } : {}),
      });
      previousChatId = chat.id ?? previousChatId;
      const reply = (chat.output ?? [])
        .map((o) => o.content ?? '')
        .filter(Boolean)
        .join(' ')
        .trim();
      return { role: 'agent', text: reply, latencyMs: Date.now() - startedAt };
    };

    return {
      start: async () =>
        config.firstMessage ? { role: 'agent' as const, text: config.firstMessage } : null,
      send,
      end: async () => {},
    };
  }
}
