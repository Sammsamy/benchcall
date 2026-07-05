import { afterEach, describe, expect, it, vi } from 'vitest';
import { VapiAdapter } from '../src/adapters/vapi.js';

function mockFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace('https://api.vapi.ai', '').split('?')[0]!;
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

const assistant = {
  id: 'asst_1',
  name: 'Front Desk',
  firstMessage: 'Thanks for calling Lakeside Dental!',
  model: {
    provider: 'openai',
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are the Lakeside Dental receptionist.' },
      { role: 'assistant', content: 'ignored' },
    ],
    tools: [{ type: 'function', name: 'bookSlot' }],
  },
  voice: { provider: 'eleven', voiceId: 'nova' },
};

describe('VapiAdapter', () => {
  it('extracts the system prompt from model.messages', async () => {
    vi.stubGlobal('fetch', mockFetch({ 'GET /assistant/asst_1': () => assistant }));
    const config = await new VapiAdapter('key').getAgentConfig('asst_1');
    expect(config.systemPrompt).toBe('You are the Lakeside Dental receptionist.');
    expect(config.firstMessage).toBe('Thanks for calling Lakeside Dental!');
    expect(config.model).toBe('gpt-4o');
    expect(config.tools).toHaveLength(1);
  });

  it('survives assistants with a missing/polymorphic model block', async () => {
    vi.stubGlobal('fetch', mockFetch({ 'GET /assistant/asst_1': () => ({ id: 'asst_1' }) }));
    const config = await new VapiAdapter('key').getAgentConfig('asst_1');
    expect(config.systemPrompt).toBe('');
    expect(config.name).toBe('(unnamed assistant)');
  });

  it('maps calls from call.artifact with latency attached to agent turns', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'GET /call': () => [
          {
            id: 'call_1',
            startedAt: '2026-07-01T10:00:00Z',
            cost: 0.12,
            artifact: {
              messages: [
                { role: 'system', message: 'hidden' },
                { role: 'bot', message: 'Hello!' },
                { role: 'user', message: 'Hi, booking please.' },
                { role: 'bot', message: 'Sure.' },
              ],
              performanceMetrics: { turnLatencies: [{ turnLatency: 900 }, { turnLatency: 2100 }] },
            },
          },
        ],
      }),
    );
    const calls = await new VapiAdapter('key').listRecentCalls('asst_1');
    expect(calls[0]!.transcript).toEqual([
      { role: 'agent', text: 'Hello!', latencyMs: 900 },
      { role: 'caller', text: 'Hi, booking please.' },
      { role: 'agent', text: 'Sure.', latencyMs: 2100 },
    ]);
    expect(calls[0]!.costUsd).toBe(0.12);
  });

  it('chains chat turns via previousChatId', async () => {
    const chatBodies: Array<Record<string, unknown>> = [];
    let n = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'GET /assistant/asst_1': () => assistant,
        'POST /chat': (init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          chatBodies.push(body);
          n += 1;
          return { id: `chat_${n}`, output: [{ role: 'assistant', content: `reply ${n}` }] };
        },
      }),
    );

    const session = await new VapiAdapter('key').createSession('asst_1');
    const greeting = await session.start();
    expect(greeting?.text).toBe('Thanks for calling Lakeside Dental!');

    const first = await session.send('Hi');
    const second = await session.send('Book me in');

    expect(first.text).toBe('reply 1');
    expect(second.text).toBe('reply 2');
    expect(chatBodies[0]!.previousChatId).toBeUndefined();
    expect(chatBodies[1]!.previousChatId).toBe('chat_1');
  });
});
