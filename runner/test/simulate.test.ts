import { describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock.js';
import { MockProvider } from '../src/llm/mock.js';
import { runScenario } from '../src/caller/simulate.js';
import type { AgentConfig, Scenario } from '../src/core/types.js';

const agent: AgentConfig = {
  id: 'a1',
  name: 'Test Agent',
  platform: 'mock',
  systemPrompt: 'You book appointments.',
  firstMessage: 'Thanks for calling!',
};

const scenario: Scenario = {
  id: 's1',
  category: 'happy-path',
  title: 'Books a cleaning',
  persona: 'cooperative',
  callerGoal: 'Book a cleaning.',
  maxTurns: 5,
  successCriteria: [{ id: 'c1', kind: 'must', description: 'Books it.' }],
};

describe('runScenario', () => {
  it('alternates caller/agent turns and ends on [HANGUP]', async () => {
    const adapter = new MockAdapter(agent, ['Sure, when works for you?', 'Booked for Tuesday!']);
    const llm = new MockProvider()
      .queueText('Hi, I need a cleaning.')
      .queueText('Tuesday please.')
      .queueText('Great, thanks, bye [HANGUP]');
    const session = await adapter.createSession();

    const result = await runScenario(session, scenario, { llm });

    expect(result.endedBy).toBe('caller');
    expect(result.transcript.map((t) => t.role)).toEqual([
      'agent', // greeting
      'caller',
      'agent',
      'caller',
      'agent',
      'caller', // closing line before hangup
    ]);
    expect(result.transcript.at(-1)?.text).toBe('Great, thanks, bye');
  });

  it('uses the scripted openingLine for the first caller turn', async () => {
    const adapter = new MockAdapter(agent, ['Reply 1']);
    const llm = new MockProvider().queueText('bye [HANGUP]');
    const withOpening = { ...scenario, openingLine: 'Do you take walk-ins?' };

    const result = await runScenario(await adapter.createSession(), withOpening, { llm });

    expect(result.transcript[1]).toMatchObject({ role: 'caller', text: 'Do you take walk-ins?' });
  });

  it('stops at maxTurns when the caller never hangs up', async () => {
    const adapter = new MockAdapter(agent, Array(10).fill('And anything else?'));
    const llm = new MockProvider();
    for (let i = 0; i < 10; i++) llm.queueText(`caller line ${i}`);

    const result = await runScenario(await adapter.createSession(), { ...scenario, maxTurns: 3 }, { llm });

    expect(result.endedBy).toBe('max-turns');
  });

  it('sends a user-first, non-empty message array when the agent waits for the caller', async () => {
    const silentAgent = { ...agent, firstMessage: undefined };
    const adapter = new MockAdapter(silentAgent, ['How can I help?']);
    const session = await adapter.createSession();
    session.start = async () => null; // agent waits for caller (e.g. Vapi assistant-waits-for-user)
    const llm = new MockProvider().queueText('Hello, anyone there?').queueText('bye [HANGUP]');

    const result = await runScenario(session, scenario, { llm });

    expect(result.endedBy).toBe('caller');
    const firstCall = llm.calls[0]!.opts;
    expect(firstCall.messages.length).toBeGreaterThan(0);
    expect(firstCall.messages[0]!.role).toBe('user');
    // The synthetic scaffold turn never leaks into the recorded transcript.
    expect(result.transcript[0]).toMatchObject({ role: 'caller', text: 'Hello, anyone there?' });
  });

  it('keeps caller-LLM messages user-first when the scenario has an openingLine and no greeting', async () => {
    const adapter = new MockAdapter(agent, ['Reply 1']);
    const session = await adapter.createSession();
    session.start = async () => null;
    const llm = new MockProvider().queueText('bye [HANGUP]');
    const withOpening = { ...scenario, openingLine: 'Do you take walk-ins?' };

    await runScenario(session, withOpening, { llm });

    // Transcript starts with a caller turn → mapped array would start with
    // 'assistant'; the guard must prepend a user turn.
    expect(llm.calls[0]!.opts.messages[0]!.role).toBe('user');
  });

  it('captures adapter errors as endedBy=error with partial transcript', async () => {
    const adapter = new MockAdapter(agent);
    const session = await adapter.createSession();
    session.send = async () => {
      throw new Error('platform exploded');
    };
    const llm = new MockProvider().queueText('Hello?');

    const result = await runScenario(session, scenario, { llm });

    expect(result.endedBy).toBe('error');
    expect(result.error).toContain('platform exploded');
    expect(result.transcript.length).toBeGreaterThan(0);
  });
});
