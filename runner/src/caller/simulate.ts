import type { CallResult, Scenario, TranscriptTurn } from '../core/types.js';
import type { AgentSession } from '../adapters/types.js';
import type { ChatMessage, LLMProvider } from '../llm/types.js';
import type { CostTracker } from '../llm/cost.js';
import { PERSONA_INSTRUCTIONS } from './personas.js';

const HANGUP = '[HANGUP]';
const DEFAULT_MAX_TURNS = 12;

function callerSystemPrompt(scenario: Scenario): string {
  return [
    'You are role-playing a PHONE CALLER talking to a business\'s AI voice agent. You are testing the agent, but you must stay fully in character as a realistic caller.',
    `PERSONA: ${PERSONA_INSTRUCTIONS[scenario.persona]}`,
    `YOUR GOAL ON THIS CALL: ${scenario.callerGoal}`,
    'RULES:',
    '- Output ONLY your next spoken line. No narration, no quotes, no markdown.',
    '- Keep each utterance under 40 words, like real speech.',
    '- Never reveal you are a test or an AI.',
    `- When the call has reached its natural end (goal achieved, refused, or you give up), say your closing line followed by ${HANGUP} — for example: "Okay, thanks, bye ${HANGUP}".`,
  ].join('\n');
}

export interface SimulateOptions {
  llm: LLMProvider;
  callerModel?: string;
  costs?: CostTracker;
}

/**
 * Active engine: drive one scenario against a live agent session.
 * The simulated caller is an LLM persona; the agent is whatever the adapter
 * connects to (Vapi assistant, local emulation, mock).
 */
export async function runScenario(
  session: AgentSession,
  scenario: Scenario,
  opts: SimulateOptions,
): Promise<CallResult> {
  const transcript: TranscriptTurn[] = [];
  const maxTurns = scenario.maxTurns ?? DEFAULT_MAX_TURNS;
  const system = callerSystemPrompt(scenario);

  try {
    const greeting = await session.start();
    if (greeting) transcript.push(greeting); // null: agent waits for caller

    for (let turn = 0; turn < maxTurns; turn++) {
      let callerText: string;
      if (turn === 0 && scenario.openingLine) {
        callerText = scenario.openingLine;
      } else {
        // The caller LLM sees the call from its own side: agent turns are
        // "user" input, its own past lines are "assistant" turns.
        const messages: ChatMessage[] = transcript.map((t) => ({
          role: t.role === 'agent' ? 'user' : 'assistant',
          content: t.text,
        }));
        // Anthropic/Gemini reject empty or assistant-first message arrays —
        // happens when the agent waits for the caller to speak first.
        if (messages.length === 0 || messages[0]!.role === 'assistant') {
          messages.unshift({
            role: 'user',
            content: '[The call connects. The line is silent — you speak first.]',
          });
        }
        const result = await opts.llm.complete({
          system,
          messages,
          model: opts.callerModel,
          tier: 'cheap',
          maxTokens: 200,
        });
        opts.costs?.add(result.costUsd, result.priced);
        callerText = result.text.trim();
      }

      const wantsHangup = callerText.includes(HANGUP);
      const spoken = callerText.replaceAll(HANGUP, '').trim();
      if (spoken) transcript.push({ role: 'caller', text: spoken });
      if (wantsHangup) {
        return { scenarioId: scenario.id, transcript, endedBy: 'caller' };
      }
      if (!spoken) {
        // Model produced nothing speakable — treat as caller giving up.
        return { scenarioId: scenario.id, transcript, endedBy: 'caller' };
      }

      const reply = await session.send(spoken);
      transcript.push({
        role: reply.role,
        text: reply.text,
        ...(reply.latencyMs !== undefined ? { latencyMs: reply.latencyMs } : {}),
      });
      if (reply.agentHangup) {
        return { scenarioId: scenario.id, transcript, endedBy: 'agent' };
      }
    }
    return { scenarioId: scenario.id, transcript, endedBy: 'max-turns' };
  } catch (err) {
    return {
      scenarioId: scenario.id,
      transcript,
      endedBy: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await session.end().catch(() => {});
  }
}
