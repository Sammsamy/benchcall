import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '../src/adapters/local.js';
import { MockProvider } from '../src/llm/mock.js';
import { CostTracker } from '../src/llm/cost.js';
import type { AgentConfig } from '../src/core/types.js';

const agent: AgentConfig = {
  id: 'a1',
  name: 'Emulated Agent',
  platform: 'local',
  systemPrompt: 'You book appointments.',
  firstMessage: 'Thanks for calling!',
};

describe('LocalAdapter', () => {
  it('keeps LLM history user-first even when the agent greets first (Anthropic/Gemini contract)', async () => {
    const llm = new MockProvider().queueText('Sure, when works for you?');
    const session = await new LocalAdapter(agent, llm).createSession();

    const greeting = await session.start();
    expect(greeting?.text).toBe('Thanks for calling!');

    await session.send('I need a cleaning.');

    // Note: the adapter mutates its history array after the call, so assert
    // the prefix by index (the mock holds a live reference).
    const messages = llm.calls[0]!.opts.messages;
    expect(messages[0]!.role).toBe('user'); // synthetic [phone connects] turn
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Thanks for calling!' });
    expect(messages[2]).toMatchObject({ role: 'user', content: 'I need a cleaning.' });
  });

  it('tracks emulation spend in the shared CostTracker', async () => {
    const llm = new MockProvider().queueText('Hello there!');
    const costs = new CostTracker();
    const session = await new LocalAdapter({ ...agent, firstMessage: undefined }, llm, { costs }).createSession();

    await session.start(); // no firstMessage → LLM generates the greeting

    expect(costs.callCount).toBe(1);
  });
});
