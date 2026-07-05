import { z } from 'zod';
import {
  computeScenarioVerdict,
  CriterionVerdictSchema,
  ExperienceMetricsSchema,
  type CallResult,
  type JudgeResult,
  type Scenario,
} from '../core/types.js';
import { completeJSONWithRepair } from '../llm/json.js';
import type { CostTracker } from '../llm/cost.js';
import type { LLMProvider } from '../llm/types.js';
import { buildJudgeUserPrompt, JUDGE_OUTPUT_SCHEMA, JUDGE_SYSTEM_PROMPT } from './prompts.js';

const JudgeLLMOutputSchema = z.object({
  verdicts: z.array(CriterionVerdictSchema),
  experience: ExperienceMetricsSchema,
  summary: z.string(),
});

export interface JudgeOptions {
  llm: LLMProvider;
  /** Cheap-model class by default; override per project. */
  judgeModel?: string;
  costs?: CostTracker;
}

/**
 * Score one call against its scenario rubric. The scenario verdict is computed
 * deterministically from per-criterion verdicts — the model never gets to
 * hand-wave an overall pass.
 */
export async function judgeCall(
  scenario: Scenario,
  call: CallResult,
  opts: JudgeOptions,
): Promise<JudgeResult> {
  const expectedIds = new Set(scenario.successCriteria.map((c) => c.id));

  const validate = (raw: unknown) => {
    const parsed = JudgeLLMOutputSchema.parse(raw);
    const gotIds = new Set(parsed.verdicts.map((v) => v.criterionId));
    const missing = [...expectedIds].filter((id) => !gotIds.has(id));
    const extra = [...gotIds].filter((id) => !expectedIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `verdicts must cover exactly the rubric criterion ids. missing: [${missing.join(', ')}] unexpected: [${extra.join(', ')}]`,
      );
    }
    return parsed;
  };

  const result = await completeJSONWithRepair(opts.llm, {
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildJudgeUserPrompt(scenario, call) }],
    model: opts.judgeModel,
    tier: 'cheap',
    maxTokens: 2048,
    schemaName: 'call_judgement',
    schema: JUDGE_OUTPUT_SCHEMA,
    validate,
  });
  opts.costs?.add(result.costUsd, result.priced);

  return {
    scenarioId: scenario.id,
    verdicts: result.data.verdicts,
    scenarioVerdict: computeScenarioVerdict(result.data.verdicts),
    experience: result.data.experience,
    summary: result.data.summary,
  };
}
