import { describe, expect, it } from 'vitest';
import { buildEvidenceData, renderEvidenceHTML, EVIDENCE_DISCLAIMER } from '../src/report/evidence.js';
import type { RunReport } from '../src/core/types.js';

const run: RunReport = {
  runId: 'run_1',
  suiteId: 'suite_1',
  agentId: 'a1',
  agentName: 'Clinic Bot',
  startedAt: '2026-07-04T10:00:00Z',
  finishedAt: '2026-07-04T10:05:00Z',
  outcomes: [
    {
      scenario: {
        id: 's1',
        category: 'hallucination-probe',
        title: 'Price probe',
        persona: 'impatient',
        callerGoal: 'g',
        successCriteria: [{ id: 'no_price', kind: 'must_not', description: 'Never quotes prices.' }],
      },
      call: { scenarioId: 's1', transcript: [{ role: 'agent', text: 'SECRET-TRANSCRIPT-LINE' }], endedBy: 'caller' },
      judge: {
        scenarioId: 's1',
        verdicts: [{ criterionId: 'no_price', verdict: 'fail', evidence: 'About $1200.', reasoning: 'quoted price' }],
        scenarioVerdict: 'fail',
        experience: {
          resolutionQuality: 'resolved',
          callerEffort: 'low',
          feltHeard: 'acknowledged',
          frustrationTrajectory: 'stable',
          abandonmentRisk: 'low',
        },
        summary: 'quoted a price',
      },
    },
  ],
  totals: { scenarios: 1, passed: 0, failed: 1, errored: 0 },
  llmCostUsd: 0.01,
};

const input = {
  agentId: 'a1',
  agentName: 'Clinic Bot',
  generatedAt: '2026-07-04T12:00:00Z',
  brand: 'Acme Voice Agency',
  runs: [run],
  agreement: { agreed: 4, total: 5 },
  configHistory: [{ at: '2026-07-03T09:00:00Z', changedFields: ['model'], changes: ['model: gpt-4.1 → gpt-4.2'] }],
};

describe('evidence pack', () => {
  it('collects testing records, oversight, and change log', () => {
    const data = buildEvidenceData(input);
    expect(data.testingRecords[0]!.failures[0]).toMatchObject({ criterion: 'Never quotes prices.', evidence: 'About $1200.' });
    expect(data.humanOversight).toEqual({ reviewedVerdicts: 5, agreementPct: 80 });
    expect(data.changeLog[0]!.changes[0]).toContain('gpt-4.2');
    expect(data.meta.disclaimer).toBe(EVIDENCE_DISCLAIMER);
  });

  it('renders HTML with the disclaimer and brand, without full transcripts', () => {
    const html = renderEvidenceHTML(input);
    expect(html).toContain('Important:');
    expect(html).toContain('not legal advice');
    expect(html).toContain('Prepared by Acme Voice Agency');
    expect(html).toContain('Never quotes prices.');
    expect(html).not.toContain('SECRET-TRANSCRIPT-LINE');
  });

  it('escapes HTML in customer-controlled fields', () => {
    const html = renderEvidenceHTML({ ...input, agentName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });
});
