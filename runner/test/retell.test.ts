import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetellAdapter } from '../src/adapters/retell.js';

function mockFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace('https://api.retellai.com', '').split('?')[0]!;
    const key = `${init?.method ?? 'GET'} ${path}`;
    const handler = routes[key];
    if (!handler) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(handler(init)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('RetellAdapter', () => {
  it('composes the system prompt from a retell-llm engine (general + states)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'GET /get-agent/agent_1': () => ({
          agent_id: 'agent_1',
          agent_name: 'Clinic Bot',
          voice_id: 'nova',
          response_engine: { type: 'retell-llm', llm_id: 'llm_9' },
        }),
        'GET /get-retell-llm/llm_9': () => ({
          general_prompt: 'You schedule clinic appointments.',
          begin_message: 'Thanks for calling the clinic!',
          model: 'gpt-4.1',
          states: [{ name: 'booking', state_prompt: 'Collect name and time.' }],
        }),
      }),
    );
    const config = await new RetellAdapter('key').getAgentConfig('agent_1');
    expect(config.systemPrompt).toContain('You schedule clinic appointments.');
    expect(config.systemPrompt).toContain('## State: booking');
    expect(config.firstMessage).toBe('Thanks for calling the clinic!');
    expect(config.model).toBe('gpt-4.1');
    expect(config.platform).toBe('retell');
  });

  it('maps production calls: transcript_object roles, cents → USD, latency percentiles', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'POST /v3/list-calls': () => ({ items: [{ call_id: 'call_1' }] }),
        'GET /v2/get-call/call_1': () => ({
          call_id: 'call_1',
          start_timestamp: 1751600000000,
          transcript_object: [
            { role: 'agent', content: 'Hello!' },
            { role: 'user', content: 'Hi, booking please.' },
          ],
          latency: { e2e: { p50: 800, p90: 1900 } },
          call_cost: { combined_cost: 42 },
          disconnection_reason: 'user_hangup',
        }),
      }),
    );
    const calls = await new RetellAdapter('key').listRecentCalls('agent_1');
    expect(calls[0]!.transcript).toEqual([
      { role: 'agent', text: 'Hello!' },
      { role: 'caller', text: 'Hi, booking please.' },
    ]);
    expect(calls[0]!.costUsd).toBeCloseTo(0.42);
    expect(calls[0]!.metadata).toMatchObject({ latencyE2eP50Ms: 800, disconnectionReason: 'user_hangup' });
  });

  it('drives sessions via the playground endpoint and surfaces call_ended', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'POST /agent-playground-completion/agent_1': (init) => {
          bodies.push(JSON.parse(String(init?.body)));
          calls += 1;
          if (calls === 1) return { messages: [{ role: 'agent', content: 'Welcome!' }] };
          return { messages: [{ role: 'agent', content: 'Goodbye.' }], call_ended: true };
        },
      }),
    );
    const session = await new RetellAdapter('key').createSession('agent_1');
    const greeting = await session.start();
    expect(greeting?.text).toBe('Welcome!');

    const reply = await session.send('I want to cancel.');
    expect(reply.text).toBe('Goodbye.');
    expect(reply.agentHangup).toBe(true);
    // Full history resent each turn: greeting + user turn.
    expect(bodies[1]!.messages).toEqual([
      { role: 'agent', content: 'Welcome!' },
      { role: 'user', content: 'I want to cancel.' },
    ]);
  });
});
