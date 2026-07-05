import { randomUUID } from 'node:crypto';
import type { RunReport, ScenarioOutcome, TestSuite } from './core/types.js';
import type { AgentSession, VoicePlatformAdapter } from './adapters/types.js';
import type { LLMProvider } from './llm/types.js';
import { CostTracker } from './llm/cost.js';
import { runScenario } from './caller/simulate.js';
import { judgeCall } from './judge/judge.js';

export interface RunSuiteOptions {
  adapter: VoicePlatformAdapter;
  agentId: string;
  llm: LLMProvider;
  callerModel?: string;
  judgeModel?: string;
  /** Scenarios run in parallel up to this limit. */
  concurrency?: number;
  costs?: CostTracker;
  onProgress?: (message: string) => void;
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** The core active-testing loop: simulate every scenario, judge every call. */
export async function runSuite(suite: TestSuite, opts: RunSuiteOptions): Promise<RunReport> {
  const costs = opts.costs ?? new CostTracker();
  // The tracker may be shared across generation + several runs — report the
  // delta this run added, not the cumulative total.
  const costStartUsd = costs.totalUsd;
  const unpricedStart = costs.unpricedCount;
  const startedAt = new Date().toISOString();
  const progress = opts.onProgress ?? (() => {});

  const outcomes = await pool(suite.scenarios, opts.concurrency ?? 4, async (scenario): Promise<ScenarioOutcome> => {
    progress(`▸ ${scenario.title}`);
    let session: AgentSession;
    try {
      session = await opts.adapter.createSession(opts.agentId);
    } catch (err) {
      // One scenario's session failure must not abort the whole run.
      const message = err instanceof Error ? err.message : String(err);
      progress(`  ✖ ${scenario.title} — could not open session: ${message}`);
      return {
        scenario,
        call: { scenarioId: scenario.id, transcript: [], endedBy: 'error', error: `session: ${message}` },
      };
    }
    let call = await runScenario(session, scenario, {
      llm: opts.llm,
      callerModel: opts.callerModel,
      costs,
    });

    if (call.endedBy === 'error') {
      // Platform hiccups shouldn't count against the agent — one fresh retry.
      progress(`  ↻ ${scenario.title} — call errored (${call.error}); retrying once`);
      try {
        const retrySession = await opts.adapter.createSession(opts.agentId);
        const retry = await runScenario(retrySession, scenario, {
          llm: opts.llm,
          callerModel: opts.callerModel,
          costs,
        });
        if (retry.endedBy !== 'error' || retry.transcript.length > call.transcript.length) {
          call = retry;
        }
      } catch {
        /* keep the first attempt */
      }
    }

    if (call.endedBy === 'error' && call.transcript.length === 0) {
      progress(`  ✖ ${scenario.title} — call failed: ${call.error}`);
      return { scenario, call };
    }

    try {
      const judge = await judgeCall(scenario, call, {
        llm: opts.llm,
        judgeModel: opts.judgeModel,
        costs,
      });
      progress(`  ${judge.scenarioVerdict === 'pass' ? '✓' : '✗'} ${scenario.title}`);
      return { scenario, call, judge };
    } catch (err) {
      progress(`  ✖ ${scenario.title} — judging failed: ${err instanceof Error ? err.message : err}`);
      return { scenario, call: { ...call, endedBy: 'error' as const, error: `judge: ${String(err)}` } };
    }
  });

  const passed = outcomes.filter((o) => o.judge?.scenarioVerdict === 'pass').length;
  const failed = outcomes.filter((o) => o.judge?.scenarioVerdict === 'fail').length;
  const errored = outcomes.length - passed - failed;

  return {
    runId: `run_${randomUUID().slice(0, 8)}`,
    suiteId: suite.id,
    agentId: suite.agentId,
    agentName: suite.agentName,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcomes,
    totals: { scenarios: outcomes.length, passed, failed, errored },
    llmCostUsd: costs.totalUsd - costStartUsd,
    ...(costs.unpricedCount > unpricedStart ? { unpricedLlmCalls: costs.unpricedCount - unpricedStart } : {}),
  };
}
