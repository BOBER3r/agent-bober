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
  type CriterionResult,
  type Regression,
  type GeneratorFeedbackItem,
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

export { resolveModel } from "./orchestrator/model-resolver.js";

export {
  loadAgentDefinition,
  clearAgentCache,
  type AgentDefinition,
} from "./orchestrator/agent-loader.js";

export {
  buildToolSet,
  type ToolSet,
  type AgentRole,
} from "./orchestrator/tools/index.js";

export {
  runAgenticLoop,
  type AgenticLoopParams,
  type AgenticLoopResult,
} from "./orchestrator/agentic-loop.js";

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

// ── Providers ──────────────────────────────────────────────────────

export type {
  JsonSchemaProperty,
  JsonSchemaObject,
  ToolDef,
  ToolCall,
  ToolResult,
  TextMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  ChatParams,
  ChatResponse,
  StopReason,
  LLMClient,
} from "./providers/types.js";

export { AnthropicAdapter } from "./providers/anthropic.js";
export { OpenAIAdapter } from "./providers/openai.js";
export { GoogleAdapter } from "./providers/google.js";
export { OpenAICompatAdapter } from "./providers/openai-compat.js";

export { createClient, validateApiKey, type ProviderName } from "./providers/factory.js";

// ── Utils ──────────────────────────────────────────────────────────

export { logger, Logger } from "./utils/logger.js";
export { findProjectRoot } from "./utils/fs.js";

// ── MCP Server ──────────────────────────────────────────────────────

export { createBoberMCPServer } from "./mcp/index.js";
export { RunManager } from "./mcp/run-manager.js";

// ── Discovery ────────────────────────────────────────────────────────

export { scanProject } from "./discovery/scanner.js";
export { synthesizePrinciples } from "./discovery/synthesizer.js";
export { generateEvalConfig } from "./discovery/config-generator.js";
export type { DiscoveryReport } from "./discovery/types.js";
