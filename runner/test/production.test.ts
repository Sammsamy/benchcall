import { describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock.js';
import { MockProvider } from '../src/llm/mock.js';
import { buildPassiveCriteria, scoreRecentCalls } from '../src/judge/production.js';
import type { AgentConfig, TestSuite } from '../src/core/types.js';

const agent: AgentConfig = {
  id: 'a1',
  name: 'Agent',
  platform: 'mock',
  systemPrompt: 'prompt',
};

const suite: TestSuite = {
  id: 'suite_1',
  agentId: 'a1',
  agentName: 'Agent',
  createdAt: new Date().toISOString(),
  analysis: {
    obligations: ['Collect a callback number before booking.'],
    prohibitions: ['Never quote prices.'],
    taskGraph: ['greet', 'book'],
  },
  scenarios: [
    {
      id: 's1',
      category: 'happy-path',
      title: 't',
      persona: 'cooperative',
      callerGoal: 'g',
      successCriteria: [{ id: 'c', kind: 'must', description: 'd' }],
    },
  ],
};

const experience = {
  resolutionQuality: 'resolved',
  callerEffort: 'low',
  feltHeard: 'acknowledged',
  frustrationTrajectory: 'stable',
  abandonmentRisk: 'low',
} as const;

describe('buildPassiveCriteria', () => {
  it('turns obligations/prohibitions into must/must_not criteria', () => {
    const criteria = buildPassiveCriteria(suite);
    expect(criteria).toEqual([
      { id: 'obligation_1', kind: 'must', description: 'Collect a callback number before booking.' },
      { id: 'prohibition_1', kind: 'must_not', description: 'Never quote prices.' },
    ]);
  });
});

describe('scoreRecentCalls', () => {
  it('judges recent calls and flags rule violations', async () => {
    const adapter = new MockAdapter(agent, [], [
      {
        id: 'call_1',
        startedAt: '2026-07-03T09:00:00Z',
        transcript: [
          { role: 'agent', text: 'Hello!' },
          { role: 'caller', text: 'How much is a crown?' },
          { role: 'agent', text: 'About $1200.' },
        ],
      },
      // Too short — must be skipped, not judged.
      { id: 'call_2', startedAt: '2026-07-03T10:00:00Z', transcript: [{ role: 'agent', text: 'Hello?' }] },
    ]);
    const llm = new MockProvider().queueJSON({
      verdicts: [
        { criterionId: 'obligation_1', verdict: 'not_applicable', evidence: 'none', reasoning: 'no booking attempted' },
        { criterionId: 'prohibition_1', verdict: 'fail', evidence: 'About $1200.', reasoning: 'quoted a price' },
      ],
      experience,
      summary: 'Agent quoted an invented price.',
    });

    const report = await scoreRecentCalls(adapter, 'a1', suite, { llm });

    expect(report.totals).toEqual({ calls: 1, flagged: 1 });
    expect(report.skippedCalls).toBe(1);
    expect(report.scores[0]!.callVerdict).toBe('fail');
    expect(llm.calls).toHaveLength(1);
  });
});
