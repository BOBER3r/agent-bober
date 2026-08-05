import type { BoberConfig } from "../../config/schema.js";
import type { PipelineResult } from "../pipeline.js";

// ── Engine names ───────────────────────────────────────────────────

/**
 * The single source of truth for every well-known orchestration engine name.
 *
 * Both Zod enums that used to repeat these literals — `pipeline.engine`
 * (config/schema.ts) and `teams[].pipelineShape` (config/schema.ts) — are
 * constructed by spreading this tuple, so adding a sixth engine is a one-place
 * edit instead of a four-place lockstep edit.
 *
 * `"pge"` is RESERVED: it parses as a valid config value today, but no
 * `PgeEngine` implementation exists, so `resolveEngineName` downgrades it to
 * `"ts"` with a single logged line (selector.ts). The implementation lands in a
 * later sprint; reserving the name now keeps the enum stable.
 *
 * This module deliberately has ZERO runtime imports (both imports above are
 * type-only and therefore erased). `config/schema.ts` imports the tuple as a
 * runtime value, so keeping this module inert is what makes that import free of
 * a module cycle and free of any executor in the graph.
 */
export const PIPELINE_ENGINE_NAMES = [
  "ts",
  "skill",
  "workflow",
  "medical-sop",
  "pge",
] as const;

/** Well-known orchestration engine names, derived from {@link PIPELINE_ENGINE_NAMES}. */
export type PipelineEngineName = (typeof PIPELINE_ENGINE_NAMES)[number];

// ── Types ──────────────────────────────────────────────────────────

/**
 * Named options bag accepted by every engine's `run()`.
 *
 * Before this existed the interface declared only `{ runId?: string }` while
 * real callers passed `{ runId, teamId }` (pipeline.ts) and `{ runId, now }`
 * (medical/engine.ts) — the extra fields survived only through structural
 * widening that the interface never declared, so nothing checked them.
 */
export interface RunOptions {
  /** Stable identifier for the whole run; self-generated when omitted. */
  runId?: string;
  /** Selects the active team (its `pipelineShape` picks the engine). */
  teamId?: string;
  /** Injected ISO-8601 clock. Engines that accept it must not read the wall clock. */
  now?: string;
  /** Cooperative cancellation for long-running engines. */
  signal?: AbortSignal;
  /** Resume a previously checkpointed run instead of starting a fresh one. */
  resume?: boolean;
}

/** Interface every pipeline engine implementation must satisfy. */
export interface PipelineEngine {
  readonly name: PipelineEngineName;
  run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
    opts?: RunOptions,
  ): Promise<PipelineResult>;
}
