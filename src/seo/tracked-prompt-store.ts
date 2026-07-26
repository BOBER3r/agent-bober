/**
 * TrackedPromptStore — reads the committed tracked-prompt set for a target
 * from `.bober/seo/ai-visibility/<target>.json`
 * (spec-20260718-in-house-ai-visibility, Sprint 6).
 *
 * `load()` NEVER throws: a missing file, an unreadable file, or a file that
 * fails `TrackedPromptSetSchema.safeParse` all collapse to the SAME fallback
 * — `{ target, prompts: [target], engines: [], samplesPerPrompt: 5 }` — which
 * is byte-identical (for the `target`/`prompts` fields `gatherDataBundle`
 * actually forwards into `AiVisibilityQuery`) to the pre-Sprint-6 literal at
 * `runner.ts:421` (sc-6-2). Mirrors the read-JSON -> Zod `safeParse` ->
 * fallback idiom of `readJob` (`src/research/job-store.ts:100-113`).
 *
 * `engines`/`samplesPerPrompt` are parsed for completeness (sc-6-1) but are
 * ADVISORY ONLY — the real per-target N/engines are resolved by config at
 * provider construction (`schema.ts:729-747`), and the caller in
 * `runner.ts`'s `gatherDataBundle` deliberately does NOT flow them into the
 * LOCKED `AiVisibilityQuery` shape (`data-source.ts:61`; contract nonGoal).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// ── Schema ───────────────────────────────────────────────────────────

export const TrackedPromptSetSchema = z.object({
  target: z.string(),
  prompts: z.array(z.string()),
  // Advisory — never flowed into AiVisibilityQuery (contract nonGoal). A
  // plain string array (not the config's engine enum) so a stray/unknown
  // engine name never fails the whole file's safeParse.
  engines: z.array(z.string()).default([]),
  samplesPerPrompt: z.number().int().positive().default(5),
  locale: z.string().optional(),
});

export type TrackedPromptSet = z.infer<typeof TrackedPromptSetSchema>;

// ── Paths ────────────────────────────────────────────────────────────

const TRACKED_PROMPTS_DIR = ".bober/seo/ai-visibility";

/** fs-safe filename — mirrors `report-store.ts:34-36`'s traversal-safe sanitization. */
function trackedPromptPath(projectRoot: string, target: string): string {
  const safeTarget = target.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(projectRoot, TRACKED_PROMPTS_DIR, `${safeTarget}.json`);
}

/** The byte-identical-to-pre-Sprint-6 fallback (sc-6-2). */
function fallback(target: string): TrackedPromptSet {
  return { target, prompts: [target], engines: [], samplesPerPrompt: 5 };
}

// ── Store ────────────────────────────────────────────────────────────

export class TrackedPromptStore {
  constructor(private readonly projectRoot: string) {}

  /**
   * Load the committed tracked-prompt set for `target`. Missing, unreadable,
   * or malformed (fails Zod validation) all fall back to
   * `{ target, prompts: [target], engines: [], samplesPerPrompt: 5 }`.
   * Never throws.
   */
  async load(target: string): Promise<TrackedPromptSet> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(trackedPromptPath(this.projectRoot, target), "utf-8"),
      );
      const result = TrackedPromptSetSchema.safeParse(raw);
      return result.success ? result.data : fallback(target);
    } catch {
      return fallback(target);
    }
  }
}
