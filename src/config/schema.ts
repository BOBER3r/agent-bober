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
});
export type EvaluatorSection = z.infer<typeof EvaluatorSectionSchema>;

export const SprintSectionSchema = z.object({
  maxSprints: z.number().int().min(1).default(10),
  requireContracts: z.boolean().default(true),
  sprintSize: SprintSizeSchema.default("medium"),
});
export type SprintSection = z.infer<typeof SprintSectionSchema>;

export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  requireApproval: z.boolean().default(false),
  contextReset: ContextResetSchema.default("always"),
  researchPhase: z.boolean().default(true),
  architectPhase: z.boolean().default(false),
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

// ── Full Config ─────────────────────────────────────────────────────

export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  planner: PlannerSectionSchema,
  generator: GeneratorSectionSchema,
  evaluator: EvaluatorSectionSchema,
  sprint: SprintSectionSchema,
  pipeline: PipelineSectionSchema,
  commands: CommandsSectionSchema,
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
    },
    sprint: {
      maxSprints: 10,
      requireContracts: true,
      sprintSize: "medium",
    },
    pipeline: {
      maxIterations: 20,
      requireApproval: false,
      contextReset: "always",
      researchPhase: true,
      architectPhase: false,
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
