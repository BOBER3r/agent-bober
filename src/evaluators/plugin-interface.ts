import type { EvalResult, EvalDetail } from "../contracts/eval-result.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { BoberConfig, EvalStrategy } from "../config/schema.js";

// Re-export for convenience — consumers of the plugin interface need these.
export type { EvalResult, EvalDetail, SprintContract, BoberConfig, EvalStrategy };

// ── Plugin Interface ───────────────────────────────────────────────

/**
 * Context provided to every evaluator plugin when it runs.
 */
export interface EvalContext {
  /** Absolute path to the project being evaluated. */
  projectRoot: string;
  /** The resolved bober configuration. */
  config: BoberConfig;
  /** The sprint contract that defines expected outcomes. */
  contract: SprintContract;
  /** Paths of files changed during the sprint (relative to projectRoot). */
  changedFiles: string[];
  /** The evaluation strategy entry that triggered this evaluator. */
  strategy: EvalStrategy;
}

/**
 * The interface every evaluator plugin must implement.
 *
 * Built-in evaluators (typecheck, lint, etc.) and custom plugins both
 * conform to this shape.
 */
export interface EvaluatorPlugin {
  /** Human-readable name of the evaluator, e.g. "TypeScript Check". */
  readonly name: string;
  /** Short description of what this evaluator validates. */
  readonly description: string;

  /**
   * Determine whether this evaluator can run in the given project.
   * Return false if a required tool or config is missing so the
   * registry can skip it gracefully.
   */
  canRun(projectRoot: string, config: BoberConfig): Promise<boolean>;

  /**
   * Execute the evaluation and return structured results.
   * Must handle errors internally and never throw — return a
   * failed EvalResult instead.
   */
  evaluate(context: EvalContext): Promise<EvalResult>;
}

/**
 * Factory function signature for creating evaluator plugin instances.
 * Custom plugins export a default factory so the loader can instantiate
 * them with optional per-strategy configuration.
 */
export type EvaluatorFactory = (config?: Record<string, unknown>) => EvaluatorPlugin;
