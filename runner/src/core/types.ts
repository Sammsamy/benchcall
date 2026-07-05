import { z } from 'zod';

// ── Agent under test ────────────────────────────────────────────────────────

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['vapi', 'retell', 'local', 'mock']),
  systemPrompt: z.string(),
  firstMessage: z.string().optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  /** Tool/function definitions as the platform reports them, opaque to us. */
  tools: z.array(z.unknown()).optional(),
  /** Raw platform payload for debugging; never sent to the hosted server. */
  raw: z.unknown().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ── Test suites ──────────────────────────────────────

export const ScenarioCategorySchema = z.enum([
  'happy-path',
  'identity-verification',
  'mandatory-questions',
  'prohibited-disclosure',
  'hallucination-probe',
  'interruption',
  'noise-robustness',
  'silence-timeout',
  'goal-change',
  'escalation',
  'prompt-injection',
  'payment-refusal',
  'edge-time',
  'memory-claims',
]);
export type ScenarioCategory = z.infer<typeof ScenarioCategorySchema>;

export const PersonaSchema = z.enum(['cooperative', 'confused', 'impatient', 'interrupting']);
export type Persona = z.infer<typeof PersonaSchema>;

export const CriterionSchema = z.object({
  id: z.string(),
  /** What the agent must do (kind=must) or must never do (kind=must_not). */
  description: z.string(),
  kind: z.enum(['must', 'must_not']),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export const ScenarioSchema = z.object({
  id: z.string(),
  category: ScenarioCategorySchema,
  title: z.string(),
  persona: PersonaSchema,
  /** What the simulated caller is trying to achieve, in second person. */
  callerGoal: z.string(),
  /** Optional scripted first caller utterance; otherwise the caller improvises. */
  openingLine: z.string().optional(),
  maxTurns: z.number().int().min(2).max(40).optional(),
  successCriteria: z.array(CriterionSchema).min(1),
  notes: z.string().optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const TestSuiteSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string().optional(),
  createdAt: z.string(),
  pack: z.string().optional(),
  /** What the generation engine extracted from the agent config. */
  analysis: z.object({
    obligations: z.array(z.string()),
    prohibitions: z.array(z.string()),
    taskGraph: z.array(z.string()),
  }),
  scenarios: z.array(ScenarioSchema).min(1),
});
export type TestSuite = z.infer<typeof TestSuiteSchema>;

// ── Calls & transcripts ─────────────────────────────────────────────────────

export const TranscriptTurnSchema = z.object({
  role: z.enum(['agent', 'caller']),
  text: z.string(),
  /** Milliseconds the agent took to respond (from platform metadata or measured). */
  latencyMs: z.number().optional(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const CallResultSchema = z.object({
  scenarioId: z.string(),
  transcript: z.array(TranscriptTurnSchema),
  endedBy: z.enum(['caller', 'agent', 'max-turns', 'error']),
  error: z.string().optional(),
  metadata: z
    .object({
      platformCallId: z.string().optional(),
      costUsd: z.number().optional(),
      durationMs: z.number().optional(),
    })
    .optional(),
});
export type CallResult = z.infer<typeof CallResultSchema>;

// ── Judging ───────────

export const CriterionVerdictSchema = z.object({
  criterionId: z.string(),
  verdict: z.enum(['pass', 'fail', 'not_applicable']),
  /** Short quote from the transcript supporting the verdict. */
  evidence: z.string(),
  reasoning: z.string(),
});
export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

/** Caller-experience metrics — anchored grades, not 1–10 vibes. */
export const ExperienceMetricsSchema = z.object({
  /** Was the caller's actual need met by the end of the call? */
  resolutionQuality: z.enum(['unresolved', 'partially_resolved', 'resolved']),
  /** How much work did the caller do — repeats, re-explaining, correcting the agent? */
  callerEffort: z.enum(['low', 'moderate', 'high']),
  /** Did the agent acknowledge what the caller said, or steamroll past it? */
  feltHeard: z.enum(['steamrolled', 'mixed', 'acknowledged']),
  frustrationTrajectory: z.enum(['improving', 'stable', 'worsening']),
  abandonmentRisk: z.enum(['low', 'medium', 'high']),
});
export type ExperienceMetrics = z.infer<typeof ExperienceMetricsSchema>;

export const JudgeResultSchema = z.object({
  scenarioId: z.string(),
  verdicts: z.array(CriterionVerdictSchema),
  scenarioVerdict: z.enum(['pass', 'fail']),
  experience: ExperienceMetricsSchema,
  summary: z.string(),
});
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

// ── Runs & reports ──────────────────────────────────────────────────────────

export const ScenarioOutcomeSchema = z.object({
  scenario: ScenarioSchema,
  call: CallResultSchema,
  judge: JudgeResultSchema.optional(),
});
export type ScenarioOutcome = z.infer<typeof ScenarioOutcomeSchema>;

export const RunReportSchema = z.object({
  runId: z.string(),
  suiteId: z.string(),
  agentId: z.string(),
  agentName: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  outcomes: z.array(ScenarioOutcomeSchema),
  totals: z.object({
    scenarios: z.number(),
    passed: z.number(),
    failed: z.number(),
    errored: z.number(),
  }),
  /** What the run cost on the customer's own LLM keys (estimate). */
  llmCostUsd: z.number(),
  /** Calls made with models we have no pricing for — real spend is higher. */
  unpricedLlmCalls: z.number().optional(),
});
export type RunReport = z.infer<typeof RunReportSchema>;

export function computeScenarioVerdict(verdicts: CriterionVerdict[]): 'pass' | 'fail' {
  return verdicts.some((v) => v.verdict === 'fail') ? 'fail' : 'pass';
}
