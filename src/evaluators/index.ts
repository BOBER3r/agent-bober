// ── Plugin Interface ───────────────────────────────────────────────
export type {
  EvaluatorPlugin,
  EvaluatorFactory,
  EvalContext,
} from "./plugin-interface.js";

// ── Registry & Runner ─────────────────────────────────────────────
export {
  EvaluatorRegistry,
  createDefaultRegistry,
  runEvaluation,
  type EvaluationRunResult,
} from "./registry.js";

// ── Plugin Loader ─────────────────────────────────────────────────
export { loadPlugin, loadPlugins } from "./plugin-loader.js";

// ── Built-in Evaluators ───────────────────────────────────────────
export {
  TypeScriptCheckEvaluator,
  createTypescriptCheckEvaluator,
} from "./builtin/typescript-check.js";

export { LintEvaluator, createLintEvaluator } from "./builtin/lint.js";

export {
  UnitTestEvaluator,
  createUnitTestEvaluator,
} from "./builtin/unit-test.js";

export {
  PlaywrightEvaluator,
  createPlaywrightEvaluator,
} from "./builtin/playwright.js";

export {
  ApiCheckEvaluator,
  createApiCheckEvaluator,
} from "./builtin/api-check.js";

export {
  BuildCheckEvaluator,
  createBuildCheckEvaluator,
} from "./builtin/build-check.js";

export {
  CommandRunnerEvaluator,
  createCommandRunnerEvaluator,
} from "./builtin/command-runner.js";
