import type { EvalResult } from "../contracts/eval-result.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { BoberConfig, EvalStrategy } from "../config/schema.js";
import type { EvaluatorPlugin, EvalContext } from "./plugin-interface.js";

import { createTypescriptCheckEvaluator } from "./builtin/typescript-check.js";
import { createLintEvaluator } from "./builtin/lint.js";
import { createUnitTestEvaluator } from "./builtin/unit-test.js";
import { createPlaywrightEvaluator } from "./builtin/playwright.js";
import { createApiCheckEvaluator } from "./builtin/api-check.js";
import { createBuildCheckEvaluator } from "./builtin/build-check.js";
import { createCommandRunnerEvaluator } from "./builtin/command-runner.js";
import { loadPlugins } from "./plugin-loader.js";

// ── Sprint Evaluation Aggregate ────────────────────────────────────

/**
 * The aggregate result of running all configured evaluators for a sprint.
 */
export interface EvaluationRunResult {
  /** Whether all *required* evaluators passed. */
  passed: boolean;
  /** Aggregate score (average of all evaluator scores). */
  score: number;
  /** Individual results from each evaluator. */
  results: EvalResult[];
  /** Human-readable summary. */
  summary: string;
  /** Timestamp when the evaluation completed. */
  timestamp: string;
}

// ── Registry ───────────────────────────────────────────────────────

/**
 * Maps strategy type names to evaluator plugin instances.
 *
 * Built-in evaluators are registered by default. Custom plugins loaded
 * via the plugin-loader are added on top.
 */
export class EvaluatorRegistry {
  private readonly plugins = new Map<string, EvaluatorPlugin>();

  /**
   * Register an evaluator plugin under a given name.
   * Overwrites any previously registered plugin with the same name.
   */
  register(name: string, plugin: EvaluatorPlugin): void {
    this.plugins.set(name, plugin);
  }

  /**
   * Get a plugin by its registered name.
   */
  get(name: string): EvaluatorPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Check whether a plugin is registered under the given name.
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Return a read-only view of all registered plugins.
   */
  all(): ReadonlyMap<string, EvaluatorPlugin> {
    return this.plugins;
  }

  /**
   * Get the appropriate plugin for a given strategy.
   *
   * Resolution order:
   * 1. If strategy has a `plugin` field → look up by plugin name
   * 2. If strategy type matches a registered plugin → use it
   * 3. If strategy has a `command` field → create an on-the-fly command runner
   * 4. Otherwise → undefined (strategy will be skipped)
   */
  getForStrategy(strategy: EvalStrategy): EvaluatorPlugin | undefined {
    // Explicit plugin reference (e.g. type:"custom" + plugin:"./my-eval.ts")
    if (strategy.plugin && this.plugins.has(strategy.plugin)) {
      return this.plugins.get(strategy.plugin);
    }

    // Built-in or previously registered plugin
    if (this.plugins.has(strategy.type)) {
      return this.plugins.get(strategy.type);
    }

    // Inline command shorthand (e.g. type:"k6", command:"k6 run load.js")
    if (strategy.command) {
      const label = strategy.label ?? strategy.type;
      const timeout = (strategy.config?.["timeout"] as number | undefined) ?? 120_000;
      return createCommandRunnerEvaluator(label, strategy.command, timeout);
    }

    return undefined;
  }

  /**
   * List the names of all registered plugins that can run in the
   * given project context.
   */
  async listAvailable(projectRoot: string, config: BoberConfig): Promise<string[]> {
    const available: string[] = [];

    for (const [name, plugin] of this.plugins) {
      try {
        const canRun = await plugin.canRun(projectRoot, config);
        if (canRun) {
          available.push(name);
        }
      } catch {
        // If canRun throws, skip this plugin.
      }
    }

    return available;
  }

  /**
   * Return all registered plugin names.
   */
  listAll(): string[] {
    return [...this.plugins.keys()];
  }
}

// ── Default Registry Factory ───────────────────────────────────────

/**
 * Create a registry pre-populated with all built-in evaluators.
 * Optionally loads custom plugins from the config.
 */
export async function createDefaultRegistry(
  config?: BoberConfig,
): Promise<EvaluatorRegistry> {
  const registry = new EvaluatorRegistry();

  // Register all built-in evaluators.
  registry.register("typecheck", createTypescriptCheckEvaluator());
  registry.register("lint", createLintEvaluator());
  registry.register("unit-test", createUnitTestEvaluator());
  registry.register("playwright", createPlaywrightEvaluator());
  registry.register("api-check", createApiCheckEvaluator());
  registry.register("build", createBuildCheckEvaluator());

  // Load custom plugins if configured.
  if (config?.evaluator.plugins && config.evaluator.plugins.length > 0) {
    const customPlugins = await loadPlugins(config.evaluator.plugins);
    for (const plugin of customPlugins) {
      registry.register(plugin.name, plugin);
    }
  }

  return registry;
}

// ── Evaluation Runner ──────────────────────────────────────────────

/**
 * Run all configured evaluation strategies and produce an aggregate result.
 *
 * Strategies are run sequentially to avoid resource contention (e.g. multiple
 * build processes or test runners at once). Each strategy that doesn't have
 * a matching plugin, or whose plugin can't run, is skipped with a warning.
 */
export async function runEvaluation(
  registry: EvaluatorRegistry,
  projectRoot: string,
  config: BoberConfig,
  contract: SprintContract,
  changedFiles: string[],
): Promise<EvaluationRunResult> {
  const results: EvalResult[] = [];
  const strategies = config.evaluator.strategies;

  for (const strategy of strategies) {
    const plugin = registry.getForStrategy(strategy);

    if (!plugin) {
      console.warn(
        `[bober] No evaluator registered for strategy "${strategy.type}"${strategy.plugin ? ` (plugin: ${strategy.plugin})` : ""}. Skipping.`,
      );
      results.push({
        evaluator: strategy.type,
        passed: !strategy.required,
        score: strategy.required ? 0 : undefined,
        details: [
          {
            criterion: "Plugin availability",
            passed: false,
            message: `No evaluator plugin found for strategy "${strategy.type}".`,
            severity: strategy.required ? "error" : "warning",
          },
        ],
        summary: `Evaluator for "${strategy.type}" not found.`,
        feedback: strategy.required
          ? `Required evaluator "${strategy.type}" is not available. Install the plugin or remove it from the config.`
          : `Optional evaluator "${strategy.type}" is not available. Skipped.`,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    // Check if the plugin can run in this project.
    let canRun = false;
    try {
      canRun = await plugin.canRun(projectRoot, config);
    } catch (err) {
      console.warn(
        `[bober] Error checking if "${plugin.name}" can run: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!canRun) {
      results.push({
        evaluator: plugin.name,
        passed: !strategy.required,
        score: strategy.required ? 0 : undefined,
        details: [
          {
            criterion: "Plugin prerequisites",
            passed: false,
            message: `"${plugin.name}" cannot run in this project (missing prerequisites).`,
            severity: strategy.required ? "error" : "info",
          },
        ],
        summary: `"${plugin.name}" skipped (prerequisites not met).`,
        feedback: strategy.required
          ? `Required evaluator "${plugin.name}" cannot run. Check that the necessary tools and config files are present.`
          : `Optional evaluator "${plugin.name}" skipped.`,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    // Run the evaluator.
    const context: EvalContext = {
      projectRoot,
      config,
      contract,
      changedFiles,
      strategy,
    };

    try {
      const result = await plugin.evaluate(context);
      results.push(result);
    } catch (err) {
      // Evaluators should never throw, but guard against it anyway.
      results.push({
        evaluator: plugin.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: "Evaluator execution",
            passed: false,
            message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            severity: "error",
          },
        ],
        summary: `"${plugin.name}" threw an unexpected error.`,
        feedback: `The evaluator "${plugin.name}" crashed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Compute aggregate.
  const requiredStrategies = strategies.filter((s) => s.required);
  const requiredResults = results.filter((_r, i) => strategies[i]?.required === true);

  const allRequiredPassed = requiredResults.every((r) => r.passed);

  const scoredResults = results.filter((r) => r.score !== undefined);
  const avgScore =
    scoredResults.length > 0
      ? Math.round(
          scoredResults.reduce((sum, r) => sum + (r.score ?? 0), 0) /
            scoredResults.length,
        )
      : 0;

  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;

  const summaryParts = [
    `Evaluation complete: ${passedCount}/${totalCount} evaluators passed`,
    `(${requiredResults.filter((r) => r.passed).length}/${requiredStrategies.length} required)`,
    `Score: ${avgScore}/100`,
  ];

  return {
    passed: allRequiredPassed,
    score: avgScore,
    results,
    summary: summaryParts.join(". "),
    timestamp: new Date().toISOString(),
  };
}
