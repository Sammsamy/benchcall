import { z } from 'zod';
import {
  JudgeResultSchema,
  ScenarioSchema,
  type RunReport,
} from './types.js';

/**
 * What the hosted dashboard receives.
 * Call transcripts NEVER leave the customer's environment — only scores,
 * verdicts, and shape metadata sync. The judge's short evidence quotes are
 * included (they are what makes a verdict auditable); a customer who wants
 * zero excerpts shared can disable sync entirely (BENCHCALL_SYNC=off).
 */
export const SyncedCallSummarySchema = z.object({
  scenarioId: z.string(),
  endedBy: z.enum(['caller', 'agent', 'max-turns', 'error']),
  error: z.string().optional(),
  turnCount: z.number().int().min(0),
  /** Agent responses that took >1.5s — dead air as callers experience it. */
  longPauseCount: z.number().int().min(0),
});
export type SyncedCallSummary = z.infer<typeof SyncedCallSummarySchema>;

export const SyncedOutcomeSchema = z.object({
  scenario: ScenarioSchema,
  call: SyncedCallSummarySchema,
  judge: JudgeResultSchema.optional(),
});

export const SyncedRunReportSchema = z.object({
  runId: z.string(),
  suiteId: z.string(),
  agentId: z.string(),
  agentName: z.string().optional(),
  platform: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  outcomes: z.array(SyncedOutcomeSchema),
  totals: z.object({
    scenarios: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    errored: z.number().int(),
  }),
  llmCostUsd: z.number(),
  /** Human-readable config changes detected right before this run (e.g. "model: gpt-4.1 → gpt-4.2"). */
  configChanges: z.array(z.string()).optional(),
});
export type SyncedRunReport = z.infer<typeof SyncedRunReportSchema>;

/** Strip everything conversational from a run report before it leaves the machine. */
export function toSyncReport(report: RunReport, platform?: string, configChanges?: string[]): SyncedRunReport {
  return SyncedRunReportSchema.parse({
    runId: report.runId,
    suiteId: report.suiteId,
    agentId: report.agentId,
    agentName: report.agentName,
    platform,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    outcomes: report.outcomes.map((o) => ({
      scenario: o.scenario,
      call: {
        scenarioId: o.call.scenarioId,
        endedBy: o.call.endedBy,
        ...(o.call.error ? { error: o.call.error } : {}),
        turnCount: o.call.transcript.length,
        longPauseCount: o.call.transcript.filter((t) => t.role === 'agent' && (t.latencyMs ?? 0) > 1500).length,
      },
      ...(o.judge ? { judge: o.judge } : {}),
    })),
    totals: report.totals,
    llmCostUsd: report.llmCostUsd,
    ...(configChanges && configChanges.length > 0 ? { configChanges } : {}),
  });
}
