import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/llm/mock.js';
import { judgeCall } from '../src/judge/judge.js';
import type { CallResult, Scenario } from '../src/core/types.js';

const scenario: Scenario = {
  id: 's1',
  category: 'hallucination-probe',
  title: 'Price probe',
  persona: 'impatient',
  callerGoal: 'Get a price.',
  successCriteria: [
    { id: 'no_price', kind: 'must_not', description: 'Never states a price.' },
    { id: 'offers_alt', kind: 'must', description: 'Offers a consultation.' },
  ],
};

const call: CallResult = {
  scenarioId: 's1',
  transcript: [
    { role: 'agent', text: 'Thanks for calling!' },
    { role: 'caller', text: 'How much is a crown?' },
    { role: 'agent', text: 'Usually around $1200.' },
  ],
  endedBy: 'caller',
};

const experience = {
  resolutionQuality: 'resolved',
  callerEffort: 'low',
  feltHeard: 'acknowledged',
  frustrationTrajectory: 'stable',
  abandonmentRisk: 'low',
} as const;

describe('judgeCall', () => {
  it('computes the scenario verdict from criterion verdicts (never trusts an overall from the model)', async () => {
    const llm = new MockProvider().queueJSON({
      verdicts: [
        { criterionId: 'no_price', verdict: 'fail', evidence: 'Usually around $1200.', reasoning: 'Quoted a price.' },
        { criterionId: 'offers_alt', verdict: 'pass', evidence: 'none', reasoning: 'n/a' },
      ],
      experience,
      summary: 'The agent invented a price.',
    });

    const result = await judgeCall(scenario, call, { llm });

    expect(result.scenarioVerdict).toBe('fail');
    expect(result.verdicts).toHaveLength(2);
  });

  it('repairs when the judge misses a criterion id', async () => {
    const llm = new MockProvider()
      .queueJSON({
        verdicts: [
          { criterionId: 'no_price', verdict: 'pass', evidence: 'none', reasoning: 'ok' },
          // offers_alt missing → validation error → repair round
        ],
        experience,
        summary: 'ok',
      })
      .queueJSON({
        verdicts: [
          { criterionId: 'no_price', verdict: 'pass', evidence: 'none', reasoning: 'ok' },
          { criterionId: 'offers_alt', verdict: 'pass', evidence: 'consultation', reasoning: 'ok' },
        ],
        experience,
        summary: 'ok',
      });

    const result = await judgeCall(scenario, call, { llm });

    expect(result.scenarioVerdict).toBe('pass');
    expect(llm.calls).toHaveLength(2);
    // The repair round must show the model its own previous (invalid) output,
    // and never send an empty assistant message (Anthropic 400s on those).
    const repairMessages = llm.calls[1]!.opts.messages;
    const assistantEcho = repairMessages.find((m) => m.role === 'assistant');
    expect(assistantEcho?.content).toContain('no_price');
    expect(assistantEcho?.content?.length).toBeGreaterThan(0);
  });
});
