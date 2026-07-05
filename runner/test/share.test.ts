import { describe, expect, it } from 'vitest';
import { renderShareCard } from '../src/report/share.js';
import type { RunReport, ScenarioOutcome } from '../src/core/types.js';

function outcome(id: string, verdict?: 'pass' | 'fail'): ScenarioOutcome {
  return {
    scenario: {
      id,
      category: 'happy-path',
      title: id,
      persona: 'cooperative',
      callerGoal: 'g',
      successCriteria: [{ id: 'c', kind: 'must', description: 'd' }],
    },
    call: { scenarioId: id, transcript: [], endedBy: 'caller' },
    ...(verdict
      ? {
          judge: {
            scenarioId: id,
            verdicts: [
              { criterionId: 'c', verdict: verdict === 'pass' ? ('pass' as const) : ('fail' as const), evidence: 'none', reasoning: 'r' },
            ],
            scenarioVerdict: verdict,
            experience: {
              resolutionQuality: 'resolved' as const,
              callerEffort: 'low' as const,
              feltHeard: 'acknowledged' as const,
              frustrationTrajectory: 'stable' as const,
              abandonmentRisk: 'low' as const,
            },
            summary: 's',
          },
        }
      : {}),
  };
}

describe('renderShareCard', () => {
  it('renders emoji grid with pass/fail/error cells, wrapped at 7', () => {
    const outcomes = [
      ...Array.from({ length: 6 }, (_, i) => outcome(`p${i}`, 'pass')),
      outcome('f1', 'fail'),
      outcome('e1'), // no judge → error cell
    ];
    const report: RunReport = {
      runId: 'r1',
      suiteId: 's1',
      agentId: 'a1',
      startedAt: '',
      finishedAt: '',
      outcomes,
      totals: { scenarios: 8, passed: 6, failed: 1, errored: 1 },
      llmCostUsd: 0,
    };
    const card = renderShareCard(report);
    expect(card).toContain('🟩🟩🟩🟩🟩🟩🟥');
    expect(card).toContain('🟨');
    expect(card).toContain('6/8 scenarios survived (75%)');
    expect(card).toContain('benchcall.ai');
    // two grid rows: 7 cells + 1 cell
    expect(card.split('\n')).toHaveLength(5);
  });
});
