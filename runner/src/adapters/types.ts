import type { AgentConfig, TranscriptTurn } from '../core/types.js';

export interface AgentSummary {
  id: string;
  name: string;
}

/** A historical production call, for passive scoring. */
export interface PlatformCallRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  transcript: TranscriptTurn[];
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

/** An agent reply; `agentHangup` marks platforms that report call termination. */
export interface AgentTurn extends TranscriptTurn {
  agentHangup?: boolean;
}

/** One live conversation with the agent under test (text-first). */
export interface AgentSession {
  /**
   * Open the session and return the agent's greeting/first message, or null
   * when the agent is configured to wait for the caller to speak first.
   */
  start(): Promise<AgentTurn | null>;
  /** Send a caller utterance; resolve with the agent's reply. */
  send(text: string): Promise<AgentTurn>;
  end(): Promise<void>;
}

export interface AdapterCapabilities {
  /** Can we converse with the agent over text (no audio)? */
  textSessions: boolean;
  /** Can we place real voice test calls? */
  voiceTestCalls: boolean;
  /** Does the platform expose per-turn latency metadata on calls? */
  latencyMetadata: boolean;
  /** Can we inject audio conditions (noise, accents)? If false, report as untested. */
  audioInjection: boolean;
}

/**
 * The pluggable boundary between benchcall and any voice-agent platform
 *. Vapi first, Retell second, others by demand.
 */
export interface VoicePlatformAdapter {
  readonly platform: string;
  capabilities(): AdapterCapabilities;
  listAgents(): Promise<AgentSummary[]>;
  getAgentConfig(agentId: string): Promise<AgentConfig>;
  /** Recent production calls for passive scoring; newest first. */
  listRecentCalls(agentId: string, limit?: number): Promise<PlatformCallRecord[]>;
  /** Open a live test conversation with the agent. */
  createSession(agentId: string): Promise<AgentSession>;
  /**
   * Optional: write a new system prompt back to the live agent. Callers MUST
   * gate this behind an explicit human confirmation (the roadmap: apply-via-API
   * only behind explicit confirm).
   */
  updateSystemPrompt?(agentId: string, systemPrompt: string): Promise<void>;
}
