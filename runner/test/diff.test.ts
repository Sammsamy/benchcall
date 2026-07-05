import { describe, expect, it } from 'vitest';
import { diffRuns } from '../src/report/diff.js';
import type { RunReport, ScenarioOutcome } from '../src/core/types.js';

function outcome(id: string, verdict: 'pass' | 'fail'): ScenarioOutcome {
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
    judge: {
      scenarioId: id,
      verdicts: [{ criterionId: 'c', verdict: verdict === 'pass' ? 'pass' : 'fail', evidence: 'none', reasoning: 'r' }],
      scenarioVerdict: verdict,
      experience: {
        resolutionQuality: 'resolved',
        callerEffort: 'low',
        feltHeard: 'acknowledged',
        frustrationTrajectory: 'stable',
        abandonmentRisk: 'low',
      },
      summary: 's',
    },
  };
}

function report(runId: string, outcomes: ScenarioOutcome[]): RunReport {
  const passed = outcomes.filter((o) => o.judge?.scenarioVerdict === 'pass').length;
  return {
    runId,
    suiteId: 'suite',
    agentId: 'agent',
    startedAt: '2026-07-04T00:00:00Z',
    finishedAt: '2026-07-04T00:01:00Z',
    outcomes,
    totals: { scenarios: outcomes.length, passed, failed: outcomes.length - passed, errored: 0 },
    llmCostUsd: 0,
  };
}

function erroredOutcome(id: string): ScenarioOutcome {
  const o = outcome(id, 'fail');
  return { scenario: o.scenario, call: { ...o.call, endedBy: 'error', error: 'boom' } }; // no judge
}

describe('diffRuns', () => {
  it('finds regressions and fixes', () => {
    const before = report('r1', [outcome('a', 'pass'), outcome('b', 'fail'), outcome('c', 'pass')]);
    const after = report('r2', [outcome('a', 'fail'), outcome('b', 'pass'), outcome('c', 'pass')]);

    const diff = diffRuns(before, after);

    expect(diff.regressions.map((d) => d.scenarioId)).toEqual(['a']);
    expect(diff.fixes.map((d) => d.scenarioId)).toEqual(['b']);
    expect(diff.unchanged.map((d) => d.scenarioId)).toEqual(['c']);
  });

  it('surfaces fail↔error transitions in the changed bucket instead of dropping them', () => {
    const before = report('r1', [outcome('a', 'fail')]);
    const after = report('r2', [erroredOutcome('a')]);

    const diff = diffRuns(before, after);

    expect(diff.regressions).toHaveLength(0);
    expect(diff.fixes).toHaveLength(0);
    expect(diff.changed).toEqual([
      expect.objectContaining({ scenarioId: 'a', before: 'fail', after: 'error' }),
    ]);
  });
});
