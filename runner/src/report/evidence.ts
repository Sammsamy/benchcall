import type { RunReport } from '../core/types.js';

/**
 * Compliance Evidence Pack: audit-ready export of test history,
 * scores, incidents, change log, and human-oversight (calibration) records,
 * organized under headings mapped to EU AI Act themes.
 *
 * HONESTY RULE: this is testing EVIDENCE, generated locally from
 * the customer's own data. It is not legal advice and does not certify
 * compliance with the EU AI Act or any other regulation — the disclaimer is
 * rendered prominently and must never be removed.
 */

export interface EvidenceInput {
  agentId: string;
  agentName?: string;
  platform?: string;
  generatedAt: string;
  brand?: string;
  runs: RunReport[]; // newest first
  agreement: { agreed: number; total: number };
  configHistory: Array<{ at: string; changedFields: string[]; changes: string[] }>;
}

export interface EvidenceData {
  meta: {
    tool: string;
    generatedAt: string;
    agentId: string;
    agentName?: string;
    platform?: string;
    disclaimer: string;
  };
  testingRecords: Array<{
    runId: string;
    startedAt: string;
    scenarios: number;
    passed: number;
    failed: number;
    errored: number;
    categoriesCovered: string[];
    failures: Array<{ scenario: string; category: string; criterion: string; evidence?: string }>;
  }>;
  humanOversight: { reviewedVerdicts: number; agreementPct: number | null };
  changeLog: Array<{ at: string; changes: string[] }>;
}

export const EVIDENCE_DISCLAIMER =
  'This document is automated testing evidence generated from your own test runs. It is not legal advice, ' +
  'not a certification, and does not by itself establish compliance with the EU AI Act or any other regulation. ' +
  'No test suite catches every failure.';

export function buildEvidenceData(input: EvidenceInput): EvidenceData {
  return {
    meta: {
      tool: 'benchcall',
      generatedAt: input.generatedAt,
      agentId: input.agentId,
      agentName: input.agentName,
      platform: input.platform,
      disclaimer: EVIDENCE_DISCLAIMER,
    },
    testingRecords: input.runs.map((run) => ({
      runId: run.runId,
      startedAt: run.startedAt,
      scenarios: run.totals.scenarios,
      passed: run.totals.passed,
      failed: run.totals.failed,
      errored: run.totals.errored,
      categoriesCovered: [...new Set(run.outcomes.map((o) => o.scenario.category))],
      failures: run.outcomes.flatMap((o) =>
        (o.judge?.verdicts ?? [])
          .filter((v) => v.verdict === 'fail')
          .map((v) => ({
            scenario: o.scenario.title,
            category: o.scenario.category,
            criterion:
              o.scenario.successCriteria.find((c) => c.id === v.criterionId)?.description ?? v.criterionId,
            ...(v.evidence && v.evidence !== 'none' ? { evidence: v.evidence } : {}),
          })),
      ),
    })),
    humanOversight: {
      reviewedVerdicts: input.agreement.total,
      agreementPct: input.agreement.total > 0 ? Math.round((input.agreement.agreed / input.agreement.total) * 100) : null,
    },
    changeLog: input.configHistory.map((h) => ({ at: h.at, changes: h.changes })),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Print-friendly HTML (browser → Print → Save as PDF). */
export function renderEvidenceHTML(input: EvidenceInput): string {
  const data = buildEvidenceData(input);
  const name = esc(input.agentName ?? input.agentId);
  const brandLine = input.brand ? `<div class="brand">Prepared by ${esc(input.brand)}</div>` : '';
  const totalRuns = data.testingRecords.length;
  const totalScenarios = data.testingRecords.reduce((n, r) => n + r.scenarios, 0);
  const categories = [...new Set(data.testingRecords.flatMap((r) => r.categoriesCovered))];

  const runRows = data.testingRecords
    .map(
      (r) => `<tr><td>${esc(r.startedAt.slice(0, 16).replace('T', ' '))}</td><td>${esc(r.runId)}</td>
      <td>${r.passed}/${r.scenarios}</td><td>${r.failed}</td><td>${r.errored}</td></tr>`,
    )
    .join('');

  const incidents = data.testingRecords.flatMap((r) =>
    r.failures.map(
      (f) => `<tr><td>${esc(r.startedAt.slice(0, 10))}</td><td>${esc(f.scenario)}</td><td>${esc(f.category)}</td>
      <td>${esc(f.criterion)}</td><td>${esc(f.evidence ?? '')}</td></tr>`,
    ),
  );

  const changeRows =
    data.changeLog.length > 0
      ? data.changeLog
          .map((h) => `<tr><td>${esc(h.at.slice(0, 16).replace('T', ' '))}</td><td>${esc(h.changes.join('; ') || 'fields changed')}</td></tr>`)
          .join('')
      : '<tr><td colspan="2">No configuration changes recorded yet.</td></tr>';

  const oversight =
    data.humanOversight.agreementPct !== null
      ? `${data.humanOversight.reviewedVerdicts} judge verdicts were reviewed by a human; agreement was ${data.humanOversight.agreementPct}%.`
      : 'No human calibration reviews recorded yet — run <code>benchcall calibrate</code> regularly to build the human-oversight record.';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Testing evidence — ${name}</title>
<style>
  body { font: 14px/1.6 Georgia, 'Times New Roman', serif; color: #1a1a1a; max-width: 820px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 26px; margin-bottom: 4px; } h2 { font-size: 18px; margin-top: 34px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  .meta, .brand { color: #555; } .brand { font-weight: bold; margin-top: 2px; }
  .disclaimer { border: 2px solid #b45309; background: #fef3e2; padding: 12px 16px; margin: 22px 0; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 10px 0; }
  th { text-align: left; border-bottom: 2px solid #333; padding: 5px 8px; } td { border-bottom: 1px solid #ddd; padding: 5px 8px; vertical-align: top; }
  .themes { font-size: 12px; color: #555; font-style: italic; }
  @media print { body { margin: 10mm; } }
</style></head><body>
<h1>Voice agent testing evidence</h1>
<div class="meta">${name} · ${esc(input.platform ?? '')} · agent id ${esc(input.agentId)} · generated ${esc(input.generatedAt.slice(0, 16).replace('T', ' '))} by benchcall</div>
${brandLine}
<div class="disclaimer"><strong>Important:</strong> ${esc(EVIDENCE_DISCLAIMER)}</div>

<h2>1. Risk evaluation &amp; testing records</h2>
<p class="themes">Relevant EU AI Act themes: iterative risk evaluation, testing documentation.</p>
<p>${totalRuns} automated test run(s) covering ${totalScenarios} scenario executions across ${categories.length} risk categories: ${categories.map(esc).join(', ')}.</p>
<table><tr><th>Date</th><th>Run</th><th>Passed</th><th>Failed</th><th>Errored</th></tr>${runRows}</table>

<h2>2. Incident log — failed criteria with evidence</h2>
<p class="themes">Relevant themes: incident documentation, audit trails.</p>
${
  incidents.length > 0
    ? `<table><tr><th>Date</th><th>Scenario</th><th>Category</th><th>Rule violated</th><th>Evidence</th></tr>${incidents.join('')}</table>`
    : '<p>No failed criteria recorded in the included runs.</p>'
}

<h2>3. Human oversight — judge calibration</h2>
<p class="themes">Relevant themes: human oversight of automated assessment.</p>
<p>${oversight}</p>

<h2>4. Change management — agent configuration log</h2>
<p class="themes">Relevant themes: change documentation, traceability.</p>
<table><tr><th>Date</th><th>Detected change</th></tr>${changeRows}</table>

<h2>5. Methodology &amp; transparency</h2>
<p>Tests are generated from the agent's own configuration, executed by LLM-simulated callers with varied personas, and scored by an LLM judge against explicit pass/fail criteria (rubric-anchored — never subjective 1–10 scores). Judge quality is tracked via the human agreement metric in section 3. Full transcripts are retained locally by the operator and are intentionally excluded from this export.</p>
</body></html>`;
}
