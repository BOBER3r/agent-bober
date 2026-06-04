import { z } from "zod";

// ── Enums & Primitives ──────────────────────────────────────────────

export const ProjectModeSchema = z.enum(["greenfield", "brownfield"]);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

export const StackSchema = z.object({
  frontend: z.string().optional(),
  backend: z.string().optional(),
  blockchain: z.string().optional(),
  testing: z.string().optional(),
  database: z.string().optional(),
  language: z.string().optional(),
  other: z.array(z.string()).optional(),
});
export type Stack = z.infer<typeof StackSchema>;

export const ModelChoiceSchema = z.string().min(1);
export type ModelChoice = string;

export const GeneratorModelSchema = z.string().min(1);
export type GeneratorModel = string;

export const SprintSizeSchema = z.enum(["small", "medium", "large"]);
export type SprintSize = z.infer<typeof SprintSizeSchema>;

export const ContextResetSchema = z.enum([
  "always",
  "on-threshold",
  "never",
]);
export type ContextReset = z.infer<typeof ContextResetSchema>;

/**
 * Well-known built-in evaluator strategy types.
 * The type field also accepts ANY string — unknown types are resolved
 * by looking for a matching registered plugin or the `command` field.
 */
export const BUILTIN_STRATEGY_TYPES = [
  "typecheck",
  "lint",
  "unit-test",
  "playwright",
  "api-check",
  "build",
  "custom",
] as const;
export type BuiltinStrategyType = (typeof BUILTIN_STRATEGY_TYPES)[number];

export const EvalStrategyTypeSchema = z.string().min(1);
export type EvalStrategyType = string;

// ── Eval Strategy ───────────────────────────────────────────────────

export const EvalStrategySchema = z.object({
  /** Strategy type — built-in name OR any custom name (e.g. "k6", "anchor-verify", "slither"). */
  type: EvalStrategyTypeSchema,
  /** Path to a custom plugin module (for type "custom" or any non-built-in type). */
  plugin: z.string().optional(),
  /** Shell command to run directly — shorthand alternative to writing a plugin file. */
  command: z.string().optional(),
  /** Whether this strategy must pass for the sprint to pass. */
  required: z.boolean(),
  /** Arbitrary config passed to the evaluator plugin. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Human-readable label (defaults to type if not set). */
  label: z.string().optional(),
});
export type EvalStrategy = z.infer<typeof EvalStrategySchema>;

// ── Section Schemas ─────────────────────────────────────────────────

export const ProjectSectionSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  mode: ProjectModeSchema,
  preset: z.string().optional(),
  stack: StackSchema.optional(),
  description: z.string().optional(),
});
export type ProjectSection = z.infer<typeof ProjectSectionSchema>;

export const PlannerSectionSchema = z.object({
  maxClarifications: z.number().int().min(0).default(5),
  model: ModelChoiceSchema.default("opus"),
  contextFiles: z.array(z.string()).optional(),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type PlannerSection = z.infer<typeof PlannerSectionSchema>;

export const GeneratorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  maxTurnsPerSprint: z.number().int().min(1).default(50),
  autoCommit: z.boolean().default(true),
  branchPattern: z.string().default("bober/{feature-name}"),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type GeneratorSection = z.infer<typeof GeneratorSectionSchema>;

export const EvaluatorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  strategies: z.array(EvalStrategySchema),
  maxIterations: z.number().int().min(1).default(3),
  plugins: z.array(z.string()).optional(),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  panel: z.object({
    enabled: z.boolean().default(false),
    lenses: z.array(z.string()).default([]),
    maxConcurrent: z.number().int().min(1).default(4),
  }).default({ enabled: false, lenses: [], maxConcurrent: 4 }),
});
export type EvaluatorSection = z.infer<typeof EvaluatorSectionSchema>;

export const SprintSectionSchema = z.object({
  maxSprints: z.number().int().min(1).default(10),
  requireContracts: z.boolean().default(true),
  sprintSize: SprintSizeSchema.default("medium"),
});
export type SprintSection = z.infer<typeof SprintSectionSchema>;

export const CuratorSectionSchema = z.object({
  model: ModelChoiceSchema.default("opus"),
  maxTurns: z.number().int().min(1).default(25),
  enabled: z.boolean().default(true),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type CuratorSection = z.infer<typeof CuratorSectionSchema>;

export const CodeReviewSectionSchema = z.object({
  timeoutMs: z.number().int().positive().default(300_000),
  enabled: z.boolean().default(true),
  model: ModelChoiceSchema.default("sonnet"),
  maxTurns: z.number().int().min(1).default(15),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type CodeReviewSection = z.infer<typeof CodeReviewSectionSchema>;

/** Well-known checkpoint mechanism names. */
export const CheckpointMechanismSchema = z.enum(["noop", "cli", "disk", "pr"]);
export type CheckpointMechanismName = z.infer<typeof CheckpointMechanismSchema>;

export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  /** Maximum times the router re-invokes a responsible agent after rejection. Default 3, min 1, max 10. */
  maxCheckpointIterations: z.number().int().min(1).max(10).default(3),
  requireApproval: z.boolean().default(false),
  contextReset: ContextResetSchema.default("always"),
  researchPhase: z.boolean().default(true),
  architectPhase: z.boolean().default(false),
  /** Pipeline execution mode. 'autopilot' auto-approves all checkpoints; 'careful' defaults to disk mechanism. Default: 'autopilot'. */
  mode: z.enum(["autopilot", "careful"]).default("autopilot"),
  /** Global default checkpoint mechanism name. When unset, resolved at runtime from pipeline.mode. Optional — leave unset to use mode-based default. */
  checkpointMechanism: CheckpointMechanismSchema.optional(),
  /** Per-checkpoint mechanism overrides. Keys are checkpoint IDs (e.g., 'post-research'); values are mechanism names. Default: {}. */
  checkpointOverrides: z.record(z.string(), CheckpointMechanismSchema).default({}),
  /** How long (ms) the disk and CLI mechanisms wait for approval before timing out. Default: 86400000 (24 hours). */
  approvalTimeoutMs: z.number().int().min(1000).default(86_400_000),
  /** How often (ms) the PR mechanism polls for PR merge/close events. Default: 30000 (30 seconds). */
  prPollMs: z.number().int().min(10_000).default(30_000),
  /** Sprint 20: escape hatch for fully-automated environments (CI, batch jobs)
   *  where no human is available. When false (default), risky actions trigger
   *  a non-noop mechanism floor (default 'disk') even in mode='autopilot' +
   *  checkpointMechanism='noop'. When true, risky actions are auto-approved
   *  with a STERN warning logged and the ChangeEntry STILL recorded with the
   *  required inverse. This is "skip the interactive approval" — NOT "skip
   *  the audit trail." Documented as a footgun in skills/bober.deploy/SKILL.md. */
  allowAutopilotRiskyActions: z.boolean().default(false),
  /** Sprint 3 (cockpit-integration): per-subscription bounded queue for the
   *  event-stream notification fan-out. Default 1000. When the queue overflows,
   *  the oldest events are dropped and a single `bober/events.dropped`
   *  notification with `{ subscriptionId, dropped: N }` is emitted per
   *  overflow window. */
  eventQueueBound: z.number().int().min(1).default(1000),
  /** Sprint 4 (cockpit-integration): root directory (relative to projectRoot) under
   *  which git worktrees are created. Default '.bober/worktrees'. The full worktree
   *  path is <projectRoot>/<worktreeRoot>/<runId>. */
  worktreeRoot: z.string().default(".bober/worktrees"),
  /** Sprint 4 (cockpit-integration): when true (default), the worktree is removed
   *  via `git worktree remove` after a successful pipeline run. On failure the
   *  worktree is ALWAYS retained for debugging regardless of this flag. */
  cleanupWorktreeOnSuccess: z.boolean().default(true),
  /** Orchestration engine. 'ts' runs the built-in TypeScript pipeline (default). 'skill' and 'workflow' select alternative engines (sprint 6+). Default: 'ts'. */
  engine: z.enum(["ts", "skill", "workflow"]).default("ts"),
});
export type PipelineSection = z.infer<typeof PipelineSectionSchema>;

export const CommandsSectionSchema = z.object({
  install: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  lint: z.string().optional(),
  dev: z.string().optional(),
  typecheck: z.string().optional(),
});
export type CommandsSection = z.infer<typeof CommandsSectionSchema>;

// ── Graph Section (tokensave integration) ───────────────────────────

export const GraphLanguageTierSchema = z.enum(["core", "extended", "all"]);
export type GraphLanguageTier = z.infer<typeof GraphLanguageTierSchema>;

/**
 * Per-role token budgets for pre-flight graph context injection (ADR-9).
 * Budgets are enforced on the FORMATTED markdown output (not raw graph results).
 * Token counting uses Math.ceil(text.length / 4) as a conservative estimate.
 */
export const GraphPreflightBudgetsSchema = z.object({
  architect: z.number().int().positive().default(4000),
  curator: z.number().int().positive().default(2000),
  generator: z.number().int().positive().default(1000),
  evaluator: z.number().int().positive().default(1500),
  /** camelCase alias for the 'researcher-phase2' role. */
  researcherPhase2: z.number().int().positive().default(3000),
});
export type GraphPreflightBudgets = z.infer<typeof GraphPreflightBudgetsSchema>;

export const GraphSectionSchema = z.object({
  enabled: z.boolean().default(false),
  tokensavePath: z.string().optional(),
  autoSync: z.boolean().default(true),
  languageTier: GraphLanguageTierSchema.default("core"),
  manifestPath: z.string().default(".bober/graph/manifest.json"),
  syncTimeoutMs: z.number().int().positive().default(2000),
  queryTimeoutMs: z.number().int().positive().default(5000),
  debounceMs: z.number().int().nonnegative().default(750),
  hookQueueMax: z.number().int().positive().default(50),
  maxEngineRssMb: z.number().int().positive().default(512),
  /** When true (default) and graph.enabled=true, graph_* tools are
   *  exposed on the external MCP server (Cursor/Windsurf). When false,
   *  graph tools remain available to the internal orchestrator only. */
  exposeOnExternalMcp: z.boolean().default(true),
  /** Per-role token budgets for pre-flight graph context injection (ADR-9). */
  preflightBudgets: GraphPreflightBudgetsSchema.default({
    architect: 4000,
    curator: 2000,
    generator: 1000,
    evaluator: 1500,
    researcherPhase2: 3000,
  }),
});
export type GraphSection = z.infer<typeof GraphSectionSchema>;

// ── Observability Section (Sprint 16 — MCP plugin slots) ────────────

/** Categories of observability data a provider can serve. */
export const ObservabilityProviderKindSchema = z.enum([
  "logs",
  "metrics",
  "traces",
  "errors",
  "custom",
]);
export type ObservabilityProviderKind = z.infer<typeof ObservabilityProviderKindSchema>;

/**
 * One declared external MCP server providing observability tools.
 * At diagnoser spawn time the orchestrator spawns mcpCommand with
 * mcpArgs and mcpEnv, lists its tools, and merges them into the
 * diagnoser's tool set under the prefix `obs__<name>__<tool>`.
 */
export const ObservabilityProviderSchema = z.object({
  /** Unique name used in the obs__<name>__<tool> namespace prefix. */
  name: z.string().min(1).regex(/^[a-z0-9_]+$/i, "name must be alphanumeric/underscore"),
  kind: ObservabilityProviderKindSchema,
  /** Executable to spawn (e.g., "node", "/usr/local/bin/mcp-grafana"). */
  mcpCommand: z.string().min(1),
  mcpArgs: z.array(z.string()).optional(),
  /** Env vars passed to the child — may contain SECRETS (treat as opaque). */
  mcpEnv: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
});
export type ObservabilityProvider = z.infer<typeof ObservabilityProviderSchema>;

export const ObservabilitySectionSchema = z.object({
  providers: z.array(ObservabilityProviderSchema).default([]),
});
export type ObservabilitySection = z.infer<typeof ObservabilitySectionSchema>;

// ── Incident Section (Sprint 23 — postmortem automation) ─────────────

export const IncidentSectionSchema = z.object({
  /** When true (default), an incident transition to status='resolved' triggers
   *  asynchronous postmortem generation. The status transition itself returns
   *  immediately — postmortem synthesis runs fire-and-forget and updates
   *  incident.json.postmortemPath when complete. Set false to disable auto-gen
   *  (e.g., for CI environments or read-only audits). Sprint 23. */
  autoPostmortem: z.boolean().default(true),
});
export type IncidentSection = z.infer<typeof IncidentSectionSchema>;

// ── Telemetry Section (Sprint 28 — opt-in local-only event log) ──────

export const TelemetrySectionSchema = z.object({
  /** When true, the orchestrator appends JSONL events to .bober/telemetry/<date>.jsonl
   *  for tracking checkpoint approval rates, incident resolution times, agent retry
   *  counts. Default false (no events written). No network egress under any condition
   *  — see ESLint no-restricted-imports rule in eslint.config.js for src/telemetry/. */
  enabled: z.boolean().default(false),
});
export type TelemetrySection = z.infer<typeof TelemetrySectionSchema>;

// ── Full Config ─────────────────────────────────────────────────────

export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  planner: PlannerSectionSchema,
  curator: CuratorSectionSchema.optional(),
  generator: GeneratorSectionSchema,
  evaluator: EvaluatorSectionSchema,
  sprint: SprintSectionSchema,
  pipeline: PipelineSectionSchema,
  commands: CommandsSectionSchema,
  graph: GraphSectionSchema.optional(),
  codeReview: CodeReviewSectionSchema.optional(),
  // ── Sprint 16: observability MCP plugin slots ──
  observability: ObservabilitySectionSchema.optional(),
  // ── Sprint 23: incident postmortem automation ──
  incident: IncidentSectionSchema.optional(),
  // ── Sprint 28: opt-in local-only telemetry ──
  telemetry: TelemetrySectionSchema.optional(),
});
export type BoberConfig = z.infer<typeof BoberConfigSchema>;

/**
 * Partial schema used for config files that rely on defaults.
 * Allows every field to be optional except `project` which is always required.
 */
export const PartialBoberConfigSchema = BoberConfigSchema.deepPartial().extend({
  project: z.object({
    name: z.string().min(1, "Project name is required").optional(),
    mode: ProjectModeSchema,
    preset: z.string().optional(),
    stack: StackSchema.optional(),
    description: z.string().optional(),
  }),
});
export type PartialBoberConfig = z.infer<typeof PartialBoberConfigSchema>;

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a full default config for a given project mode and optional preset.
 * Callers can override any section by passing a partial config.
 */
export function createDefaultConfig(
  projectName: string,
  mode: ProjectMode,
  preset?: string,
  overrides: Partial<Omit<BoberConfig, "project">> = {},
): BoberConfig {
  const base: BoberConfig = {
    project: {
      name: projectName,
      mode,
      preset,
    },
    planner: {
      maxClarifications: 5,
      model: "opus",
    },
    curator: {
      model: "opus",
      maxTurns: 25,
      enabled: true,
    },
    generator: {
      model: "sonnet",
      maxTurnsPerSprint: 50,
      autoCommit: true,
      branchPattern: "bober/{feature-name}",
    },
    evaluator: {
      model: "sonnet",
      strategies: defaultStrategiesForMode(mode, preset),
      maxIterations: 3,
      panel: { enabled: false, lenses: [], maxConcurrent: 4 },
    },
    sprint: {
      maxSprints: 10,
      requireContracts: true,
      sprintSize: "medium",
    },
    pipeline: {
      maxIterations: 20,
      maxCheckpointIterations: 3,
      requireApproval: false,
      contextReset: "always",
      researchPhase: true,
      architectPhase: false,
      mode: "autopilot",
      checkpointOverrides: {},
      approvalTimeoutMs: 86_400_000,
      prPollMs: 30_000,
      allowAutopilotRiskyActions: false,
      eventQueueBound: 1000,
      worktreeRoot: ".bober/worktrees",
      cleanupWorktreeOnSuccess: true,
      engine: "ts",
    },
    commands: {},
  };

  return {
    ...base,
    ...overrides,
    project: base.project,
  };
}

function defaultStrategiesForMode(mode: ProjectMode, _preset?: string): EvalStrategy[] {
  if (mode === "brownfield") {
    return [
      { type: "typecheck", required: true },
      { type: "lint", required: true },
      { type: "unit-test", required: true },
    ];
  }
  // greenfield
  return [
    { type: "build", required: true },
    { type: "lint", required: false },
  ];
}
