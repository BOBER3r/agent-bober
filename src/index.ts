// ── Config ─────────────────────────────────────────────────────────

export {
  type BoberConfig,
  type ProjectMode,
  type Stack,
  type ModelChoice,
  type EvalStrategy,
  type EvalStrategyType,
  StackSchema,
  ProjectModeSchema,
  createDefaultConfig,
} from "./config/schema.js";

export { loadConfig, configExists } from "./config/loader.js";

export { getDefaults, getPresetNames } from "./config/defaults.js";

// ── Contracts ──────────────────────────────────────────────────────

export {
  type SprintContract,
  type SuccessCriterion,
  type ContractStatus,
  createContract,
  updateContractStatus,
} from "./contracts/sprint-contract.js";

export {
  type PlanSpec,
  type FeatureSpec,
  createSpec,
} from "./contracts/spec.js";

export {
  type EvalResult,
  type EvalDetail,
  type SprintEvaluation as ContractSprintEvaluation,
  aggregateResults,
  formatFeedback,
} from "./contracts/eval-result.js";

// ── Orchestrator ───────────────────────────────────────────────────

export {
  type ContextHandoff,
  type Decision,
  type ProjectContext,
  createHandoff,
  serializeHandoff,
  summarizeOlderSprints,
} from "./orchestrator/context-handoff.js";

export { runPlanner } from "./orchestrator/planner-agent.js";

export {
  runGenerator,
  type GeneratorResult,
} from "./orchestrator/generator-agent.js";

export { runEvaluatorAgent } from "./orchestrator/evaluator-agent.js";

export {
  runPipeline,
  type PipelineResult,
} from "./orchestrator/pipeline.js";

// ── Evaluators ─────────────────────────────────────────────────────

export {
  EvaluatorRegistry,
  createDefaultRegistry,
  runEvaluation,
  type EvaluationRunResult,
} from "./evaluators/registry.js";

export type {
  EvaluatorPlugin,
  EvaluatorFactory,
  EvalContext,
} from "./evaluators/plugin-interface.js";

// ── State ──────────────────────────────────────────────────────────

export {
  ensureBoberDir,
  saveContract,
  loadContract,
  listContracts,
  updateContract,
  saveSpec,
  loadSpec,
  loadLatestSpec,
  listSpecs,
  appendHistory,
  loadHistory,
} from "./state/index.js";

// ── Utils ──────────────────────────────────────────────────────────

export { logger, Logger } from "./utils/logger.js";
export { findProjectRoot } from "./utils/fs.js";
