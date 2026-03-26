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

export const ModelChoiceSchema = z.enum([
  "sonnet",
  "opus",
  "haiku",
  "inherit",
]);
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

export const GeneratorModelSchema = z.enum(["sonnet", "opus", "haiku"]);
export type GeneratorModel = z.infer<typeof GeneratorModelSchema>;

export const SprintSizeSchema = z.enum(["small", "medium", "large"]);
export type SprintSize = z.infer<typeof SprintSizeSchema>;

export const ContextResetSchema = z.enum([
  "always",
  "on-threshold",
  "never",
]);
export type ContextReset = z.infer<typeof ContextResetSchema>;

export const EvalStrategyTypeSchema = z.enum([
  "typecheck",
  "lint",
  "unit-test",
  "playwright",
  "api-check",
  "build",
  "custom",
]);
export type EvalStrategyType = z.infer<typeof EvalStrategyTypeSchema>;

// ── Eval Strategy ───────────────────────────────────────────────────

export const EvalStrategySchema = z.object({
  type: EvalStrategyTypeSchema,
  plugin: z.string().optional(),
  required: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
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
});
export type PlannerSection = z.infer<typeof PlannerSectionSchema>;

export const GeneratorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  maxTurnsPerSprint: z.number().int().min(1).default(50),
  autoCommit: z.boolean().default(true),
  branchPattern: z.string().default("bober/{feature-name}"),
});
export type GeneratorSection = z.infer<typeof GeneratorSectionSchema>;

export const EvaluatorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  strategies: z.array(EvalStrategySchema),
  maxIterations: z.number().int().min(1).default(3),
  plugins: z.array(z.string()).optional(),
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
