import { z } from 'zod';

/** One failed criterion with its evidence, extracted from a run report. */
export interface FixFailure {
  scenarioTitle: string;
  category: string;
  criterion: string;
  kind: 'must' | 'must_not';
  reasoning: string;
  evidence?: string;
}

/**
 * The auto-fix engine's output: a suggested prompt revision,
 * shown as a reviewable diff. NEVER auto-applied — the customer pastes it (or,
 * later, applies via API behind an explicit confirm).
 */
export const FixResultSchema = z.object({
  revisedSystemPrompt: z.string().min(1),
  rationale: z.string(),
  edits: z.array(
    z.object({
      /** Which failure(s) this edit addresses, in plain language. */
      addresses: z.string(),
      /** What was changed, quoted or described concisely. */
      change: z.string(),
    }),
  ),
});
export type FixResult = z.infer<typeof FixResultSchema>;
