import { z } from 'zod';
import {
  computeScenarioVerdict,
  CriterionVerdictSchema,
  ExperienceMetricsSchema,
  type Criterion,
  type CriterionVerdict,
  type ExperienceMetrics,
  type TestSuite,
} from '../core/types.js';
import type { PlatformCallRecord, VoicePlatformAdapter } from '../adapters/types.js';
import { completeJSONWithRepair } from '../llm/json.js';
import type { CostTracker } from '../llm/cost.js';
import type { LLMProvider } from '../llm/types.js';
import { JUDGE_OUTPUT_SCHEMA, JUDGE_SYSTEM_PROMPT } from './prompts.js';

/**
 * Passive engine: score real production calls against the agent's
 * own obligations and prohibitions — the rules the generation engine already
 * extracted from its config. No scripted scenario exists, so not_applicable
 * is expected and correct for rules a call never touched.
 */

export interface ProductionCallScore {
  callId: string;
  startedAt: string;
  verdicts: CriterionVerdict[];
  /** fail = at least one applicable rule was violated on this call. */
  callVerdict: 'pass' | 'fail';
  experience: ExperienceMetrics;
  summary: string;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface ProductionScoreReport {
  agentId: string;
  agentName?: string;
  scoredAt: string;
  criteria: Criterion[];
  scores: ProductionCallScore[];
  skippedCalls: number;
  totals: { calls: number; flagged: number };
}

const MAX_CRITERIA = 12;

/** Rules judgeable from a transcript, derived from the suite's analysis. */
export function buildPassiveCriteria(suite: TestSuite): Criterion[] {
  const obligations = suite.analysis.obligations.slice(0, MAX_CRITERIA / 2).map((description, i) => ({
    id: `obligation_${i + 1}`,
    kind: 'must' as const,
    description,
  }));
  const prohibitions = suite.analysis.prohibitions.slice(0, MAX_CRITERIA / 2).map((description, i) => ({
    id: `prohibition_${i + 1}`,
    kind: 'must_not' as const,
    description,
  }));
  return [...obligations, ...prohibitions];
}

const ProductionJudgeOutputSchema = z.object({
  verdicts: z.array(CriterionVerdictSchema),
  experience: ExperienceMetricsSchema,
  summary: z.string(),
});

function buildProductionJudgePrompt(criteria: Criterion[], call: PlatformCallRecord): string {
  const rubric = criteria.map((c) => `- id: ${c.id} | kind: ${c.kind} | ${c.description}`).join('\n');
  const transcript = call.transcript
    .map((t) => `${t.role === 'agent' ? 'AGENT' : 'CALLER'}${t.latencyMs !== undefined ? ` [response time ${t.latencyMs}ms]` : ''}: ${t.text}`)
    .join('\n');
  return [
    'This is a REAL PRODUCTION CALL — there is no scripted test scenario. The rubric below contains the agent\'s standing obligations and prohibitions.',
    'Unlike scripted tests, many rules will simply not come up on a given call: use not_applicable freely and accurately for those. Only mark pass/fail for rules the call actually exercised.',
    '',
    'RUBRIC — return one verdict per criterion id, exactly these ids:',
    rubric,
    '',
    'TRANSCRIPT:',
    transcript,
  ].join('\n');
}

export interface ScoreCallsOptions {
  llm: LLMProvider;
  judgeModel?: string;
  limit?: number;
  costs?: CostTracker;
  onProgress?: (message: string) => void;
}

export async function scoreRecentCalls(
  adapter: VoicePlatformAdapter,
  agentId: string,
  suite: TestSuite,
  opts: ScoreCallsOptions,
): Promise<ProductionScoreReport> {
  const criteria = buildPassiveCriteria(suite);
  if (criteria.length === 0) {
    throw new Error('suite has no analysis obligations/prohibitions to score against — regenerate the suite');
  }
  const progress = opts.onProgress ?? (() => {});
  const calls = await adapter.listRecentCalls(agentId, opts.limit ?? 10);
  const usable = calls.filter((c) => c.transcript.length >= 2);
  const expectedIds = new Set(criteria.map((c) => c.id));

  const scores: ProductionCallScore[] = [];
  for (const call of usable) {
    progress(`▸ scoring call ${call.id} (${call.startedAt.slice(0, 16)})`);
    const result = await completeJSONWithRepair(opts.llm, {
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildProductionJudgePrompt(criteria, call) }],
      model: opts.judgeModel,
      tier: 'cheap',
      maxTokens: 2048,
      schemaName: 'production_call_judgement',
      schema: JUDGE_OUTPUT_SCHEMA,
      validate: (raw) => {
        const parsed = ProductionJudgeOutputSchema.parse(raw);
        const gotIds = new Set(parsed.verdicts.map((v) => v.criterionId));
        const missing = [...expectedIds].filter((id) => !gotIds.has(id));
        const extra = [...gotIds].filter((id) => !expectedIds.has(id));
        if (missing.length > 0 || extra.length > 0) {
          throw new Error(
            `verdicts must cover exactly the rubric ids. missing: [${missing.join(', ')}] unexpected: [${extra.join(', ')}]`,
          );
        }
        return parsed;
      },
    });
    opts.costs?.add(result.costUsd, result.priced);
    scores.push({
      callId: call.id,
      startedAt: call.startedAt,
      verdicts: result.data.verdicts,
      callVerdict: computeScenarioVerdict(result.data.verdicts),
      experience: result.data.experience,
      summary: result.data.summary,
      costUsd: call.costUsd,
      metadata: call.metadata,
    });
  }

  return {
    agentId,
    agentName: suite.agentName,
    scoredAt: new Date().toISOString(),
    criteria,
    scores,
    skippedCalls: calls.length - usable.length,
    totals: { calls: scores.length, flagged: scores.filter((s) => s.callVerdict === 'fail').length },
  };
}
