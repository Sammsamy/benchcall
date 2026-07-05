export type OutcomeState = 'pass' | 'fail' | 'error' | 'absent';

/**
 * Structural minimum diffRuns needs — satisfied by both full RunReports
 * (local) and transcript-free SyncedRunReports (hosted dashboard).
 */
export interface DiffableRun {
  outcomes: Array<{
    scenario: { id: string; title: string; category: string };
    judge?: { scenarioVerdict: 'pass' | 'fail' } | undefined;
  }>;
  totals: { scenarios: number; passed: number };
}

export interface ScenarioDiff {
  scenarioId: string;
  title: string;
  category: string;
  before: OutcomeState;
  after: OutcomeState;
}

export interface RunDiff {
  /** pass → fail/error: the agent got worse. */
  regressions: ScenarioDiff[];
  /** fail/error → pass: the agent got better. */
  fixes: ScenarioDiff[];
  /** Verdict changed between non-pass states (fail ↔ error) or appeared/disappeared. */
  changed: ScenarioDiff[];
  unchanged: ScenarioDiff[];
  passRateBefore: number;
  passRateAfter: number;
}

function stateOf(report: DiffableRun, scenarioId: string): OutcomeState {
  const outcome = report.outcomes.find((o) => o.scenario.id === scenarioId);
  if (!outcome) return 'absent';
  if (!outcome.judge) return 'error';
  return outcome.judge.scenarioVerdict;
}

function passRate(report: DiffableRun): number {
  return report.totals.scenarios === 0 ? 0 : report.totals.passed / report.totals.scenarios;
}

/** Run-vs-run comparison — the drift signal behind "your prompt change broke X". */
export function diffRuns(before: DiffableRun, after: DiffableRun): RunDiff {
  const ids = new Map<string, { title: string; category: string }>();
  for (const o of [...before.outcomes, ...after.outcomes]) {
    ids.set(o.scenario.id, { title: o.scenario.title, category: o.scenario.category });
  }

  const diffs: ScenarioDiff[] = [...ids.entries()].map(([scenarioId, meta]) => ({
    scenarioId,
    title: meta.title,
    category: meta.category,
    before: stateOf(before, scenarioId),
    after: stateOf(after, scenarioId),
  }));

  const regressions = diffs.filter((d) => d.before === 'pass' && d.after !== 'pass' && d.after !== 'absent');
  const fixes = diffs.filter((d) => d.before !== 'pass' && d.before !== 'absent' && d.after === 'pass');
  const counted = new Set([...regressions, ...fixes].map((d) => d.scenarioId));
  return {
    regressions,
    fixes,
    changed: diffs.filter((d) => d.before !== d.after && !counted.has(d.scenarioId)),
    unchanged: diffs.filter((d) => d.before === d.after),
    passRateBefore: passRate(before),
    passRateAfter: passRate(after),
  };
}
