import { describe, expect, it } from 'vitest';
import { toSyncReport } from '../src/core/sync.js';
import type { RunReport } from '../src/core/types.js';

const SECRET_LINE = 'my social security number is 123-45-6789';

const report: RunReport = {
  runId: 'run_1',
  suiteId: 'suite_1',
  agentId: 'agent_1',
  agentName: 'Front Desk',
  startedAt: '2026-07-04T10:00:00Z',
  finishedAt: '2026-07-04T10:05:00Z',
  outcomes: [
    {
      scenario: {
        id: 's1',
        category: 'happy-path',
        title: 'Books a cleaning',
        persona: 'cooperative',
        callerGoal: 'Book a cleaning.',
        successCriteria: [{ id: 'c1', kind: 'must', description: 'Books it.' }],
      },
      call: {
        scenarioId: 's1',
        transcript: [
          { role: 'agent', text: 'Hello!', latencyMs: 2000 },
          { role: 'caller', text: SECRET_LINE },
          { role: 'agent', text: 'Noted.', latencyMs: 900 },
        ],
        endedBy: 'caller',
      },
      judge: {
        scenarioId: 's1',
        verdicts: [{ criterionId: 'c1', verdict: 'pass', evidence: 'none', reasoning: 'ok' }],
        scenarioVerdict: 'pass',
        experience: {
          resolutionQuality: 'resolved',
          callerEffort: 'low',
          feltHeard: 'acknowledged',
          frustrationTrajectory: 'stable',
          abandonmentRisk: 'low',
        },
        summary: 'Fine call.',
      },
    },
  ],
  totals: { scenarios: 1, passed: 1, failed: 0, errored: 0 },
  llmCostUsd: 0.01,
};

describe('toSyncReport (privacy boundary, the benchcall design principles)', () => {
  it('never includes transcript content, only shape metadata', () => {
    const synced = toSyncReport(report, 'vapi');
    const serialized = JSON.stringify(synced);
    expect(serialized).not.toContain(SECRET_LINE);
    expect(serialized).not.toContain('Hello!');
    expect(serialized).not.toContain('transcript');
    expect(synced.outcomes[0]!.call).toEqual({
      scenarioId: 's1',
      endedBy: 'caller',
      turnCount: 3,
      longPauseCount: 1,
    });
  });

  it('keeps verdicts, totals, and cost', () => {
    const synced = toSyncReport(report);
    expect(synced.outcomes[0]!.judge?.scenarioVerdict).toBe('pass');
    expect(synced.totals.passed).toBe(1);
    expect(synced.llmCostUsd).toBe(0.01);
  });
});
