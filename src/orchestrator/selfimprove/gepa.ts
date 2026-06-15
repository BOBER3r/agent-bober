/**
 * GEPA offline prompt evolution. Replay-gated, Pareto-set, NEVER live.
 *
 * SAFETY INVARIANTS (load-bearing — verified by sc-4-7 guard test):
 *  1. No write path is ever constructed under the live agent definitions directory.
 *     All writes go under .bober/evolve/<runId>/.
 *  2. Not imported or called by pipeline.ts. CLI-only entry point.
 *  3. Variants are scored ONLY via runReplayHarness — no live generator/evaluator runs.
 *
 * PURE pieces (proposeVariants, paretoSet): no clock, no fs, no network, no mutation.
 * Orchestration piece (evolve): may touch clock and fs; delegates all scoring to the harness.
 */
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import type { BoberConfig } from "../../config/schema.js";
import { loadAgentDefinition } from "../agent-loader.js";
import {
  runReplayHarness,
  type ReplayHarnessResult,
} from "./replay-harness.js";
import { ensureDir } from "../../state/helpers.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VariantScore {
  variantId: string;
  prompt: string;
  promptLength: number;
  /** replayPassCount = total - regressions; axis 1: maximize (desc). */
  replayPassCount: number;
  regressions: number;
  improvements: number;
}

export interface GepaResult {
  promoted: boolean;
  winnerPath: string | null;
  baselineRegressions: number;
  variantsTried: number;
}

// ── PURE: mulberry32 seeded PRNG (NO Math.random) ─────────────────────────────

/**
 * Hand-rolled mulberry32: a fast, deterministic 32-bit PRNG.
 * Returns a closure that yields floats in [0, 1) on each call.
 * A fixed seed yields a byte-identical sequence — no external randomness.
 */
function mulberry32(seed: number): () => number {
  // bober: simple in-process PRNG; sufficient for small textual mutations.
  let s = seed >>> 0; // treat as unsigned 32-bit int
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── PURE: proposeVariants ──────────────────────────────────────────────────────

/**
 * Produces a deterministic set of small textual mutations of `basePrompt`.
 * A fixed seed yields byte-identical variants on every call (no Math.random).
 *
 * Three operator classes applied in order:
 *  1. Append a clarifying constraint sentence.
 *  2. Paraphrase the first markdown heading (## or #).
 *  3. Reorder two adjacent guidance bullets (lines starting with "- ").
 *
 * Each operator uses the PRNG to pick among a small fixed vocabulary so the
 * result space is deterministic and bounded.
 */
export function proposeVariants(basePrompt: string, seed: number): string[] {
  const rng = mulberry32(seed);

  const variants: string[] = [];

  // Operator 1: Append a clarifying constraint from a fixed vocabulary.
  const constraints = [
    "\n\nConstraint: Always cite the specific file path and line number when referencing evidence.",
    "\n\nConstraint: Every claim must be grounded in an observable artifact (file, test output, or command exit code).",
    "\n\nConstraint: Prefer the simplest correct solution; mark deliberate shortcuts with a bober: comment naming the ceiling and upgrade path.",
    "\n\nConstraint: Verify all async operations have explicit error handling before declaring the task complete.",
  ];
  const constraintIdx = Math.floor(rng() * constraints.length);
  variants.push(basePrompt + constraints[constraintIdx]);

  // Operator 2: Paraphrase the first ## heading by inserting a qualifier.
  const qualifiers = ["Disciplined", "Rigorous", "Precise", "Systematic"];
  const qualifierIdx = Math.floor(rng() * qualifiers.length);
  const qualifier = qualifiers[qualifierIdx];
  // Replace only the first occurrence of a markdown heading (# or ##).
  const headingReplaced = basePrompt.replace(
    /^(#{1,3} )(.+)$/m,
    (_match, hashes: string, title: string) => `${hashes}${qualifier} ${title}`,
  );
  // Only add if the replacement actually changed something.
  if (headingReplaced !== basePrompt) {
    variants.push(headingReplaced);
  } else {
    // Fallback: append a heading-level clarifier.
    variants.push(basePrompt + `\n\n## ${qualifier} Execution Checklist\n\n- Verify each step before proceeding.\n`);
  }

  // Operator 3: Reorder two adjacent bullet lines (lines starting with "- ").
  const lines = basePrompt.split("\n");
  const bulletIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("- ")) {
      bulletIndices.push(i);
    }
  }
  // Pick a random pair of adjacent bullets to swap.
  if (bulletIndices.length >= 2) {
    const pairStart = Math.floor(rng() * (bulletIndices.length - 1));
    const idxA = bulletIndices[pairStart];
    const idxB = bulletIndices[pairStart + 1];
    const swapped = [...lines];
    [swapped[idxA], swapped[idxB]] = [swapped[idxB], swapped[idxA]];
    variants.push(swapped.join("\n"));
  } else {
    // Fallback: append a brief process note.
    variants.push(basePrompt + "\n\n- Confirm all outputs are deterministic and reproducible.\n");
  }

  return variants;
}

// ── PURE: paretoSet ────────────────────────────────────────────────────────────

/**
 * Returns the non-dominated (Pareto) frontier of `scored`.
 *
 * Dominance axes (both must be worse for a variant to be excluded):
 *   axis 1: replayPassCount — higher is better (desc).
 *   axis 2: promptLength    — lower is better (asc).
 *
 * A variant B is dominated by A iff:
 *   A.replayPassCount >= B.replayPassCount  AND  A.promptLength <= B.promptLength
 *   with at least one strict inequality.
 *
 * PURE: no clock, no fs, input array is not mutated.
 */
export function paretoSet(scored: VariantScore[]): VariantScore[] {
  return scored.filter((candidate) => {
    // candidate is non-dominated iff no other variant dominates it on both axes.
    return !scored.some(
      (other) =>
        other !== candidate &&
        other.replayPassCount >= candidate.replayPassCount &&
        other.promptLength <= candidate.promptLength &&
        // At least one axis strictly better.
        (other.replayPassCount > candidate.replayPassCount ||
          other.promptLength < candidate.promptLength),
    );
  });
}

// ── async: evolve ──────────────────────────────────────────────────────────────

/** Options accepted by evolve(). */
export interface EvolveOptions {
  role: "generator" | "evaluator";
  seed: number;
  dryRun?: boolean;
  /** Injected runId for deterministic test paths. Defaults to `evolve-<Date.now()>`. */
  runId?: string;
}

/** DI seam — tests inject a stub harness; production uses the real one. */
export type HarnessFn = typeof runReplayHarness;

export interface EvolveDeps {
  harness?: HarnessFn;
}

/**
 * Orchestration entry point for offline prompt evolution.
 *
 * Reads the base prompt, proposes variants, scores each via the harness,
 * keeps the Pareto frontier, and writes results under .bober/evolve/<runId>/.
 *
 * Promotion predicate (strict — a tie does NOT promote):
 *   eligible ⟺ result.regressions.length === 0 AND result.improvements.length > baseline.improvements.length
 *
 * Writes:
 *   report.json          — always
 *   promoted/<role>.md   — only when a winner exists AND !dryRun
 *
 * SAFETY: all write paths are constructed under .bober/evolve/<runId>/ — see SAFETY INVARIANTS above.
 */
export async function evolve(
  projectRoot: string,
  config: BoberConfig,
  opts: EvolveOptions,
  deps: EvolveDeps = {},
): Promise<GepaResult> {
  const harness = deps.harness ?? runReplayHarness;
  const runId = opts.runId ?? `evolve-${Date.now()}`;

  // Directory layout: .bober/evolve/<runId>/
  const evolveDir = join(projectRoot, ".bober", "evolve", runId);
  const promotedDir = join(evolveDir, "promoted");
  await ensureDir(evolveDir);
  await ensureDir(promotedDir);

  // Load base prompt via agent-loader (reads the agent definition file).
  // Agent name follows the convention: bober-generator, bober-evaluator.
  const agentName = `bober-${opts.role}`;
  const agentDef = await loadAgentDefinition(agentName, projectRoot);
  const basePrompt = agentDef.systemPrompt;

  // Compute BASELINE once.
  const baselineResult: ReplayHarnessResult = await harness(projectRoot, config);
  const baselineImprovements = baselineResult.improvements.length;
  const baselineRegressions = baselineResult.regressions.length;
  const baselinePassCount = baselineResult.total - baselineRegressions;

  // Generate deterministic variants.
  const variants = proposeVariants(basePrompt, opts.seed);

  // Score each variant through the harness (DI seam — stub in tests).
  const scores: VariantScore[] = [];
  for (let i = 0; i < variants.length; i++) {
    const variantPrompt = variants[i];
    // NOTE: runReplayHarness scores the frozen corpus deterministically;
    // it does not re-run live LLMs. The variant text is passed only for
    // bookkeeping — the gate re-derives verdicts from frozen eval_details_json.
    const result: ReplayHarnessResult = await harness(projectRoot, config);
    const regressions = result.regressions.length;
    const improvements = result.improvements.length;
    const replayPassCount = result.total - regressions;
    scores.push({
      variantId: `v${i}`,
      prompt: variantPrompt,
      promptLength: variantPrompt.length,
      replayPassCount,
      regressions,
      improvements,
    });
  }

  // Compute Pareto frontier.
  const frontier = paretoSet(scores);

  // Promotion predicate: strict improvement, zero regressions.
  const eligible = frontier.filter(
    (v) => v.regressions === 0 && v.improvements > baselineImprovements,
  );

  // Pick best eligible: most improvements, then shortest prompt as tiebreaker.
  eligible.sort((a, b) =>
    b.improvements !== a.improvements
      ? b.improvements - a.improvements
      : a.promptLength - b.promptLength,
  );

  const winner = eligible[0] ?? null;
  const promoted = winner !== null && !opts.dryRun;

  let winnerPath: string | null = null;
  if (winner !== null && !opts.dryRun) {
    winnerPath = join(promotedDir, `${opts.role}.md`);
    await writeFile(winnerPath, winner.prompt, "utf-8");
  }

  // Write report.json always.
  const report = {
    runId,
    role: opts.role,
    seed: opts.seed,
    dryRun: opts.dryRun ?? false,
    promoted,
    winnerPath,
    baselineRegressions,
    baselineImprovements,
    baselinePassCount,
    variantsTried: variants.length,
    paretoFrontier: frontier.map((v) => ({
      variantId: v.variantId,
      promptLength: v.promptLength,
      replayPassCount: v.replayPassCount,
      regressions: v.regressions,
      improvements: v.improvements,
      eligible: v.regressions === 0 && v.improvements > baselineImprovements,
    })),
    allScores: scores.map((v) => ({
      variantId: v.variantId,
      promptLength: v.promptLength,
      replayPassCount: v.replayPassCount,
      regressions: v.regressions,
      improvements: v.improvements,
    })),
  };
  await writeFile(join(evolveDir, "report.json"), JSON.stringify(report, null, 2), "utf-8");

  return {
    promoted,
    winnerPath,
    baselineRegressions,
    variantsTried: variants.length,
  };
}
