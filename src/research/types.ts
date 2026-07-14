import { z } from "zod";

// ── Cadence ───────────────────────────────────────────────────────────

/**
 * Recurrence cadence for a research job.
 *
 * Representation choice: a closed string-literal enum (`"daily" | "weekly" | "monthly"`).
 * This is simpler and safer than a free-form cron string for the current use-cases;
 * next-due computation (Sprint 4) will map these to concrete intervals without
 * requiring a cron parser. Do NOT compute next-due dates in this module — that is
 * Sprint 4 (contract outOfScope L55).
 */
export const CadenceSchema = z.enum(["daily", "weekly", "monthly"]);
export type Cadence = z.infer<typeof CadenceSchema>;

// ── ResearchJob ───────────────────────────────────────────────────────

/**
 * A recurring research job definition stored as a JSON file under
 * `.bober/research/jobs/<jobId>.json`.
 *
 * All timestamps are ISO-8601 strings; this module never reads the clock
 * (mirrors src/state/facts.ts:18-21 — clock is stamped at the CLI boundary).
 *
 * tier vs modelSet: both are optional; the executor (Sprint 2) resolves
 * which to use at runtime. Storing both allows flexible scheduling without
 * commitment to either axis in Sprint 1.
 *
 * onlineResearch defaults to false — the online-research egress axis is not
 * enabled until Sprint 3. The field is stored verbatim for forward-compatibility.
 */
export const ResearchJobSchema = z.object({
  id: z.string().min(1),
  /** The research question to answer. Must be non-empty (sc-1-1). */
  question: z.string().min(1),
  /** How often the job runs. See CadenceSchema for allowed values. */
  cadence: CadenceSchema,
  /** Difficulty tier hint (e.g. "hard") — optional, resolved at execution time. */
  tier: z.string().optional(),
  /** Explicit model set override — optional, resolved at execution time. */
  modelSet: z.array(z.string()).optional(),
  /** Repository slug to scope the research against, if any. */
  targetRepo: z.string().optional(),
  /** Domain tag (e.g. "medical", "coding") for priority-hub routing. */
  domain: z.string().optional(),
  /**
   * Whether online retrieval is enabled for this job.
   * Defaults to false — online-research egress is not active until Sprint 3.
   */
  onlineResearch: z.boolean().default(false),
  /** ISO-8601 creation timestamp — set once at CLI boundary, never mutated. */
  createdAt: z.string().datetime(),
  /**
   * ISO-8601 next-due instant (Sprint 4). Unset => due immediately on first tick.
   * Advanced by computeNextDue(cadence, now) after each run. Never read from the wall clock.
   */
  nextDueAt: z.string().datetime().optional(),
  /** ISO-8601 timestamp of the most recent successful run (Sprint 4). Unset until first run. */
  lastRunAt: z.string().datetime().optional(),
});

export type ResearchJob = z.infer<typeof ResearchJobSchema>;
