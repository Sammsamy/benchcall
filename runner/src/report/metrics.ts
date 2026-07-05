import type { RunReport } from '../core/types.js';

/**
 * Latency-as-experienced: agent responses slower than ~1.5s feel
 * like dead air to a phone caller. Computed deterministically from metadata,
 * never judged by an LLM.
 */
export const LONG_PAUSE_MS = 1500;

export function countLongPauses(report: RunReport): number {
  return report.outcomes
    .flatMap((o) => o.call.transcript)
    .filter((t) => t.role === 'agent' && (t.latencyMs ?? 0) > LONG_PAUSE_MS).length;
}
