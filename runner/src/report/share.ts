import type { RunReport } from '../core/types.js';

/**
 * Wordle-style share card: users paste this into X/Discord/Slack after a run.
 * Every share is zero-cost marketing generated on the user's own keys — the
 * crowd funds the virality (see ROADMAP appendix).
 */
export function renderShareCard(report: RunReport, siteUrl = 'benchcall.ai'): string {
  const cells = report.outcomes.map((o) =>
    o.judge ? (o.judge.scenarioVerdict === 'pass' ? '🟩' : '🟥') : '🟨',
  );
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7).join(''));
  const rate = report.totals.scenarios === 0 ? 0 : Math.round((report.totals.passed / report.totals.scenarios) * 100);
  return [
    `my voice agent ran the benchcall gauntlet:`,
    ...rows,
    `${report.totals.passed}/${report.totals.scenarios} scenarios survived (${rate}%)`,
    `can yours? → ${siteUrl}`,
  ].join('\n');
}
