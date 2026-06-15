import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────────────

/**
 * Zod schema for a replay case input — mirrors FactSchema in src/state/facts.ts.
 * All timestamps are ISO 8601 strings; the store never reads the clock.
 */
export const ReplayCaseSchema = z.object({
  contractId: z.string().min(1),
  iteration: z.number().int(),
  baselineVerdict: z.enum(["pass", "fail"]),
  diffDigest: z.string().min(1),
  evalDetailsJson: z.string(),
  tCaptured: z.string().datetime(),
});

export type ReplayCaseInput = z.infer<typeof ReplayCaseSchema>;

// ── Record ────────────────────────────────────────────────────────────

export interface ReplayCaseRecord extends ReplayCaseInput {
  caseId: string;
}
