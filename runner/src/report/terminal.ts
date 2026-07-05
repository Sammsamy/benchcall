import type { RunReport } from '../core/types.js';
import type { RunDiff } from './diff.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (useColor ? `[${code}m${s}[0m` : s);
export const green = (s: string) => paint(32, s);
export const red = (s: string) => paint(31, s);
export const yellow = (s: string) => paint(33, s);
export const dim = (s: string) => paint(2, s);
export const bold = (s: string) => paint(1, s);

import { countLongPauses } from './metrics.js';

export function renderTerminalReport(report: RunReport): string {
  const lines: string[] = [];
  const { totals } = report;
  lines.push(bold(`\n${report.agentName ?? report.agentId} — run ${report.runId}`));
  lines.push(dim(`suite ${report.suiteId} · ${report.startedAt}`));
  lines.push('');

  for (const outcome of report.outcomes) {
    const verdict = outcome.judge
      ? outcome.judge.scenarioVerdict === 'pass'
        ? green('PASS')
        : red('FAIL')
      : yellow('ERROR');
    lines.push(`${verdict}  ${outcome.scenario.title} ${dim(`(${outcome.scenario.category})`)}`);
    if (outcome.judge && outcome.judge.scenarioVerdict === 'fail') {
      for (const v of outcome.judge.verdicts.filter((v) => v.verdict === 'fail')) {
        const criterion = outcome.scenario.successCriteria.find((c) => c.id === v.criterionId);
        lines.push(red(`      ↳ ${criterion?.description ?? v.criterionId}`));
        if (v.evidence && v.evidence !== 'none') lines.push(dim(`        "${v.evidence}"`));
      }
    }
    if (!outcome.judge && outcome.call.error) {
      lines.push(yellow(`      ↳ ${outcome.call.error}`));
    }
  }

  lines.push('');
  const rate = totals.scenarios === 0 ? 0 : Math.round((totals.passed / totals.scenarios) * 100);
  lines.push(
    bold(
      `${totals.passed}/${totals.scenarios} passed (${rate}%)` +
        (totals.errored > 0 ? yellow(`  ·  ${totals.errored} errored`) : ''),
    ),
  );
  const pauses = countLongPauses(report);
  if (pauses > 0) lines.push(yellow(`⏱  ${pauses} agent response(s) took >1.5s — callers feel these as dead air`));
  lines.push(dim(`LLM spend this run (your keys): $${report.llmCostUsd.toFixed(4)}`));
  if (report.unpricedLlmCalls) {
    lines.push(yellow(`   ${report.unpricedLlmCalls} call(s) used models without pricing data — actual spend is higher`));
  }
  return lines.join('\n');
}

export function renderTerminalDiff(diff: RunDiff): string {
  const lines: string[] = [];
  lines.push(bold('\nChange vs previous run'));
  lines.push(
    `pass rate ${Math.round(diff.passRateBefore * 100)}% → ${Math.round(diff.passRateAfter * 100)}%`,
  );
  if (diff.regressions.length === 0 && diff.fixes.length === 0 && diff.changed.length === 0) {
    lines.push(dim('no scenario changed verdict'));
  }
  for (const r of diff.regressions) {
    lines.push(red(`REGRESSION  ${r.title} (${r.category}): ${r.before} → ${r.after}`));
  }
  for (const f of diff.fixes) {
    lines.push(green(`FIXED       ${f.title} (${f.category}): ${f.before} → ${f.after}`));
  }
  for (const c of diff.changed) {
    lines.push(yellow(`CHANGED     ${c.title} (${c.category}): ${c.before} → ${c.after}`));
  }
  return lines.join('\n');
}
