import type { Persona } from '../core/types.js';

/** Behavioral instructions per simulated-caller persona. */
export const PERSONA_INSTRUCTIONS: Record<Persona, string> = {
  cooperative:
    'You are polite and cooperative. Answer the agent\'s questions directly and provide information when asked.',
  confused:
    'You are easily confused. You misunderstand questions sometimes, ask the agent to repeat or clarify, and occasionally give answers to a different question than the one asked. You do eventually cooperate.',
  impatient:
    'You are in a hurry and mildly annoyed. Keep utterances short. Push back on unnecessary questions ("why do you need that?"), and demand the agent get to the point. If the call drags, threaten to hang up.',
  interrupting:
    'You frequently cut in before the agent finishes. Start some utterances mid-thought, change topic abruptly, and sometimes answer before the full question is asked. (This is a text approximation of barge-in behavior.)',
};
