import type { AgentConfig, TranscriptTurn } from '../core/types.js';
import { withRetry } from '../llm/retry.js';
import type {
  AdapterCapabilities,
  AgentSession,
  AgentSummary,
  AgentTurn,
  PlatformCallRecord,
  VoicePlatformAdapter,
} from './types.js';

/**
 * Retell adapter. Endpoint shapes verified against official docs 2026-07-04:
 * - Bearer auth against https://api.retellai.com (keys are all-or-nothing).
 * - GET /get-agent/{id} → response_engine points at the prompt config:
 *   retell-llm (general_prompt + states) or conversation-flow (global_prompt +
 *   node instructions); custom-llm agents host their own prompt.
 * - POST /v3/list-calls + GET /v2/get-call/{id} → transcript_object, latency
 *   percentiles (e2e.p50 …), call_cost.combined_cost in CENTS.
 * - POST /agent-playground-completion/{agent_id}: stateless text completion
 *   against the real agent config with tool mocking — ideal for active tests
 *   (no audio path, so voice latency is not exercised in text mode).
 */

const BASE_URL = 'https://api.retellai.com';

interface RetellMessage {
  role?: string;
  content?: string;
}

interface PlaygroundResponse {
  messages?: RetellMessage[];
  call_ended?: boolean;
  current_state?: string;
  current_node_id?: string;
}

export class RetellAdapter implements VoicePlatformAdapter {
  readonly platform = 'retell';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = BASE_URL,
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      textSessions: true, // /agent-playground-completion
      voiceTestCalls: true, // /v2/create-phone-call (not used in text mode)
      latencyMetadata: true, // per-call latency percentiles on voice calls
      audioInjection: false,
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
          const hint = response.status === 401 ? ' (check RETELL_API_KEY)' : '';
          const err = new Error(`Retell ${method} ${path} failed: ${response.status}${hint} ${text.slice(0, 300)}`);
          (err as { status?: number }).status = response.status;
          throw err;
        }
        return (await response.json()) as T;
      },
      // Retell publishes no request rate limits; back off on 429/5xx ourselves.
      { label: `retell:${path}`, timeoutMs: 65_000 },
    );
  }

  async listAgents(): Promise<AgentSummary[]> {
    const agents = await this.request<Array<{ agent_id: string; agent_name?: string }>>('GET', '/list-agents');
    return agents.map((a) => ({ id: a.agent_id, name: a.agent_name ?? '(unnamed agent)' }));
  }

  async getAgentConfig(agentId: string): Promise<AgentConfig> {
    const agent = await this.request<{
      agent_id: string;
      agent_name?: string;
      voice_id?: string;
      response_engine?: { type?: string; llm_id?: string; conversation_flow_id?: string; llm_websocket_url?: string };
    }>('GET', `/get-agent/${encodeURIComponent(agentId)}`);

    const engine = agent.response_engine ?? {};
    let systemPrompt = '';
    let firstMessage: string | undefined;
    let model: string | undefined;
    let tools: unknown[] | undefined;
    let engineRaw: unknown;

    if (engine.type === 'retell-llm' && engine.llm_id) {
      const llm = await this.request<{
        general_prompt?: string;
        begin_message?: string;
        model?: string;
        general_tools?: unknown[];
        states?: Array<{ name?: string; state_prompt?: string }>;
      }>('GET', `/get-retell-llm/${encodeURIComponent(engine.llm_id)}`);
      const stateSections = (llm.states ?? [])
        .filter((s) => s.state_prompt)
        .map((s) => `## State: ${s.name ?? 'unnamed'}\n${s.state_prompt}`);
      systemPrompt = [llm.general_prompt ?? '', ...stateSections].filter(Boolean).join('\n\n');
      firstMessage = llm.begin_message || undefined;
      model = llm.model;
      tools = llm.general_tools;
      engineRaw = llm;
    } else if (engine.type === 'conversation-flow' && engine.conversation_flow_id) {
      const flow = await this.request<{
        global_prompt?: string;
        model_choice?: unknown;
        tools?: unknown[];
        nodes?: Array<{ name?: string; instruction?: { type?: string; text?: string } }>;
      }>('GET', `/get-conversation-flow/${encodeURIComponent(engine.conversation_flow_id)}`);
      const nodeSections = (flow.nodes ?? [])
        .filter((n) => n.instruction?.text)
        .map((n) => `## Node: ${n.name ?? 'unnamed'}\n${n.instruction!.text}`);
      systemPrompt = [flow.global_prompt ?? '', ...nodeSections].filter(Boolean).join('\n\n');
      tools = flow.tools;
      engineRaw = flow;
    } else {
      // custom-llm: the prompt lives on the customer's own server. Active
      // testing still works via the playground; generation quality is limited.
      systemPrompt = '';
    }

    return {
      id: agent.agent_id,
      name: agent.agent_name ?? '(unnamed agent)',
      platform: 'retell',
      systemPrompt,
      firstMessage,
      model,
      voice: agent.voice_id,
      tools,
      raw: { agent, engine: engineRaw },
    };
  }

  async listRecentCalls(agentId: string, limit = 25): Promise<PlatformCallRecord[]> {
    const list = await this.request<{
      calls?: Array<{ call_id: string }>;
      items?: Array<{ call_id: string }>;
    }>('POST', '/v3/list-calls', {
      filter_criteria: { agent_id: [agentId] },
      sort_order: 'descending',
      limit,
    });
    const ids = (list.items ?? list.calls ?? []).map((c) => c.call_id);

    const records: PlatformCallRecord[] = [];
    for (const callId of ids) {
      const call = await this.request<{
        call_id: string;
        start_timestamp?: number;
        end_timestamp?: number;
        disconnection_reason?: string;
        transcript_object?: Array<{ role?: string; content?: string }>;
        latency?: { e2e?: { p50?: number; p90?: number } };
        call_cost?: { combined_cost?: number };
        call_analysis?: { user_sentiment?: string; call_successful?: boolean };
      }>('GET', `/v2/get-call/${encodeURIComponent(callId)}`);

      const transcript: TranscriptTurn[] = (call.transcript_object ?? [])
        .filter((u) => (u.role === 'agent' || u.role === 'user') && u.content)
        .map((u) => ({ role: u.role === 'agent' ? ('agent' as const) : ('caller' as const), text: u.content! }));

      records.push({
        id: call.call_id,
        startedAt: call.start_timestamp ? new Date(call.start_timestamp).toISOString() : '',
        endedAt: call.end_timestamp ? new Date(call.end_timestamp).toISOString() : undefined,
        transcript,
        // combined_cost is documented in cents.
        costUsd: call.call_cost?.combined_cost !== undefined ? call.call_cost.combined_cost / 100 : undefined,
        metadata: {
          disconnectionReason: call.disconnection_reason,
          latencyE2eP50Ms: call.latency?.e2e?.p50,
          latencyE2eP90Ms: call.latency?.e2e?.p90,
          userSentiment: call.call_analysis?.user_sentiment,
        },
      });
    }
    return records;
  }

  /**
   * Text session via the stateless playground endpoint: we keep the history
   * client-side and send it in full each turn. Tool calls are auto-mocked by
   * Retell when tool_mocks are provided; v1 sends none, so real tools may
   * execute — flagged in docs.
   */
  async createSession(agentId: string): Promise<AgentSession> {
    const adapter = this;
    const history: Array<{ role: string; content: string }> = [];

    const complete = async (): Promise<AgentTurn> => {
      const startedAt = Date.now();
      const response = await adapter.request<PlaygroundResponse>(
        'POST',
        `/agent-playground-completion/${encodeURIComponent(agentId)}`,
        { messages: history },
      );
      const newMessages = (response.messages ?? []).filter((m) => m.role === 'agent' && m.content);
      for (const m of newMessages) history.push({ role: 'agent', content: m.content! });
      const text = newMessages.map((m) => m.content!.trim()).filter(Boolean).join(' ');
      return {
        role: 'agent',
        text,
        latencyMs: Date.now() - startedAt,
        ...(response.call_ended ? { agentHangup: true } : {}),
      };
    };

    return {
      start: async (): Promise<AgentTurn | null> => {
        // Ask the agent for its opening; agents configured to wait for the
        // caller return nothing, which maps to null.
        const opening = await complete();
        return opening.text ? opening : null;
      },
      send: async (text: string): Promise<AgentTurn> => {
        history.push({ role: 'user', content: text });
        return complete();
      },
      end: async () => {},
    };
  }
}
