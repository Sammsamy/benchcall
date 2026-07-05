import { describe, expect, it } from 'vitest';
import { computeScenarioVerdict, TestSuiteSchema } from '../src/core/types.js';

const validSuite = {
  id: 'suite_1',
  agentId: 'agent_1',
  createdAt: new Date().toISOString(),
  analysis: { obligations: ['collect name'], prohibitions: ['no prices'], taskGraph: ['greet', 'book'] },
  scenarios: [
    {
      id: 'happy_path',
      category: 'happy-path',
      title: 'Simple booking',
      persona: 'cooperative',
      callerGoal: 'You want to book a cleaning.',
      successCriteria: [{ id: 'books', kind: 'must', description: 'Books the appointment.' }],
    },
  ],
};

describe('TestSuiteSchema', () => {
  it('accepts a valid suite', () => {
    expect(TestSuiteSchema.parse(validSuite).scenarios).toHaveLength(1);
  });

  it('rejects a scenario with no criteria', () => {
    const bad = structuredClone(validSuite);
    bad.scenarios[0]!.successCriteria = [];
    expect(() => TestSuiteSchema.parse(bad)).toThrow();
  });

  it('rejects unknown categories', () => {
    const bad = structuredClone(validSuite);
    (bad.scenarios[0] as { category: string }).category = 'vibes';
    expect(() => TestSuiteSchema.parse(bad)).toThrow();
  });
});

describe('computeScenarioVerdict', () => {
  const v = (verdict: 'pass' | 'fail' | 'not_applicable') => ({
    criterionId: 'c',
    verdict,
    evidence: 'none',
    reasoning: 'r',
  });

  it('fails when any criterion fails', () => {
    expect(computeScenarioVerdict([v('pass'), v('fail')])).toBe('fail');
  });

  it('passes with passes and not_applicable only', () => {
    expect(computeScenarioVerdict([v('pass'), v('not_applicable')])).toBe('pass');
  });
});
