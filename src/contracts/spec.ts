import { z } from "zod";

// ── Constants ───────────────────────────────────────────────────────

/**
 * Threshold at which a spec must be marked needs-clarification rather than
 * proceeding to sprint decomposition. Mirrors the planner agent's autonomous
 * mode rule. Scores are 0..10 inclusive.
 */
export const AMBIGUITY_BLOCK_THRESHOLD = 7;

// ── Enums ───────────────────────────────────────────────────────────

export const PrioritySchema = z.enum([
  "must-have",
  "should-have",
  "nice-to-have",
]);
export type Priority = z.infer<typeof PrioritySchema>;

export const EstimatedComplexitySchema = z.enum(["low", "medium", "high"]);
export type EstimatedComplexity = z.infer<typeof EstimatedComplexitySchema>;

/**
 * Lifecycle of a plan spec.
 *
 * - `draft` — planner just emitted, no sprints run yet
 * - `needs-clarification` — planner refused to fully decompose: ambiguityScore
 *    >= 7 OR open questions remain. The pipeline will not run sprints from
 *    this spec until status flips to `ready`.
 * - `ready` — clarifications resolved (or never needed), pipeline may proceed
 * - `in-progress` — at least one sprint has started
 * - `completed` — all sprints finished
 * - `abandoned` — planner or user explicitly dropped this spec
 */
export const PlanSpecStatusSchema = z.enum([
  "draft",
  "needs-clarification",
  "ready",
  "in-progress",
  "completed",
  "abandoned",
]);
export type PlanSpecStatus = z.infer<typeof PlanSpecStatusSchema>;

export const PlanSpecModeSchema = z.enum(["greenfield", "brownfield"]);
export type PlanSpecMode = z.infer<typeof PlanSpecModeSchema>;

/**
 * Categories the planner uses to group clarifying questions. Matches the
 * categories listed in `.claude/agents/bober-planner.md` Phase 2.
 */
export const ClarificationCategorySchema = z.enum([
  "scope",
  "user-personas",
  "data-model",
  "tech-constraints",
  "design-ux",
  "integrations",
  "non-functional",
  "error-handling",
  "integration-risk",
  "pattern-conflict",
  "regression-risk",
  "other",
]);
export type ClarificationCategory = z.infer<typeof ClarificationCategorySchema>;

// ── Sub-types ───────────────────────────────────────────────────────

export const ClarificationOptionSchema = z.object({
  /** Short label shown to the user (e.g. "A", "B", "Custom") */
  label: z.string().min(1),
  /** What this option means in plain English */
  description: z.string().min(1),
});
export type ClarificationOption = z.infer<typeof ClarificationOptionSchema>;

export const ClarificationQuestionSchema = z.object({
  questionId: z.string().min(1),
  category: ClarificationCategorySchema,
  /** The question itself — should end with a "?" */
  question: z.string().min(5),
  /** Optional multiple-choice options, including an "Other" escape hatch */
  options: z.array(ClarificationOptionSchema).optional(),
  /** Planner's recommended answer based on codebase evidence */
  recommendation: z.string().optional(),
  /**
   * How much this question contributes to the overall ambiguityScore.
   * Useful for the user to know which questions matter most to resolve.
   */
  ambiguityWeight: z.number().int().min(0).max(10).optional(),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;

export const ResolvedClarificationSchema = z.object({
  questionId: z.string().min(1),
  /** The user-supplied answer (free-form, may reference an option label) */
  answer: z.string().min(1),
  /** ISO 8601 timestamp when the answer was recorded */
  resolvedAt: z.string().datetime({ offset: true }),
  /** Who answered: "user" (interactive) or "planner" (autonomous self-answer) */
  resolvedBy: z.enum(["user", "planner"]).default("user"),
});
export type ResolvedClarification = z.infer<typeof ResolvedClarificationSchema>;

// ── Feature Spec ────────────────────────────────────────────────────

export const FeatureSpecSchema = z.object({
  featureId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: PrioritySchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string()).default([]),
  estimatedComplexity: EstimatedComplexitySchema.optional(),
  /** Legacy field kept for backward compat — prefer estimatedComplexity */
  estimatedSprints: z.number().int().min(1).optional(),
});
export type FeatureSpec = z.infer<typeof FeatureSpecSchema>;

// ── Plan Spec ───────────────────────────────────────────────────────

export const PlanSpecSchema = z.object({
  // Identity
  specId: z.string().min(1),
  version: z.number().int().min(1).default(1),
  title: z.string().min(1),
  description: z.string().min(1),

  // Lifecycle
  status: PlanSpecStatusSchema,
  mode: PlanSpecModeSchema,

  // Features — what the user is asking for
  features: z.array(FeatureSpecSchema),

  // Planning context — how the planner reasoned about the request
  assumptions: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),

  // Clarification gate — NEW
  /**
   * Self-rated ambiguity 0..10. >= AMBIGUITY_BLOCK_THRESHOLD must result in
   * status === "needs-clarification" with at least one open question.
   */
  ambiguityScore: z.number().int().min(0).max(10).optional(),
  /** Open questions awaiting user answer. Empty when status is ready/completed. */
  clarificationQuestions: z.array(ClarificationQuestionSchema).default([]),
  /** Question/answer history, both autonomous self-answers and user inputs */
  resolvedClarifications: z.array(ResolvedClarificationSchema).default([]),

  // Tech context (loose — schemas vary by project type)
  techStack: z.array(z.string()).default([]),
  techNotes: z.record(z.string(), z.unknown()).optional(),
  nonFunctionalRequirements: z.array(z.unknown()).default([]),
  constraints: z.array(z.string()).default([]),

  // Optional inline sprint definitions (some planner emits include these)
  sprints: z.array(z.unknown()).optional(),

  // Arbitrary metadata
  metadata: z.record(z.string(), z.unknown()).optional(),

  // Timestamps
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
});
export type PlanSpec = z.infer<typeof PlanSpecSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

let specCounter = 0;

export interface CreateSpecOptions {
  mode?: PlanSpecMode;
  status?: PlanSpecStatus;
  ambiguityScore?: number;
  clarificationQuestions?: ClarificationQuestion[];
  assumptions?: string[];
  outOfScope?: string[];
  techStack?: string[];
}

/**
 * Create a new plan specification with sensible defaults.
 */
export function createSpec(
  title: string,
  description: string,
  features: Omit<FeatureSpec, "featureId">[],
  options: CreateSpecOptions = {},
): PlanSpec {
  specCounter++;
  const now = new Date().toISOString();
  const specId = `spec-${Date.now()}-${specCounter}`;

  // If clarification questions were supplied, force status to needs-clarification
  // (catches caller bugs where status and questions disagree).
  const hasOpenQuestions =
    (options.clarificationQuestions?.length ?? 0) > 0;
  const status =
    options.status ??
    (hasOpenQuestions ||
    (options.ambiguityScore !== undefined &&
      options.ambiguityScore >= AMBIGUITY_BLOCK_THRESHOLD)
      ? "needs-clarification"
      : "draft");

  return {
    specId,
    version: 1,
    title,
    description,
    status,
    mode: options.mode ?? "greenfield",
    features: features.map((f, idx) => ({
      ...f,
      featureId: `feat-${idx + 1}`,
    })),
    assumptions: options.assumptions ?? [],
    outOfScope: options.outOfScope ?? [],
    ambiguityScore: options.ambiguityScore,
    clarificationQuestions: options.clarificationQuestions ?? [],
    resolvedClarifications: [],
    techStack: options.techStack ?? [],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Return true when the spec has unresolved clarification questions.
 *
 * NOTE: This checks question state only, NOT spec.status — `status` is
 * downstream of this. If you want "is the pipeline blocked?", check
 * `spec.status === "needs-clarification" || hasOpenClarifications(spec)`
 * instead, or use `isPipelineReady(spec)`.
 */
export function hasOpenClarifications(spec: PlanSpec): boolean {
  const resolvedIds = new Set(
    spec.resolvedClarifications.map((r) => r.questionId),
  );
  return spec.clarificationQuestions.some(
    (q) => !resolvedIds.has(q.questionId),
  );
}

/**
 * Return true when the pipeline is allowed to run sprints from this spec.
 * Combines the explicit status check with the question-resolution check.
 */
export function isPipelineReady(spec: PlanSpec): boolean {
  if (spec.status === "needs-clarification") return false;
  if (spec.status === "abandoned") return false;
  if (hasOpenClarifications(spec)) return false;
  return true;
}

/**
 * Return the questions that haven't been answered yet.
 */
export function getOpenClarifications(
  spec: PlanSpec,
): ClarificationQuestion[] {
  const resolvedIds = new Set(
    spec.resolvedClarifications.map((r) => r.questionId),
  );
  return spec.clarificationQuestions.filter(
    (q) => !resolvedIds.has(q.questionId),
  );
}

/**
 * Record an answer to a clarification question. Returns a new spec — does
 * not mutate. If this answer was the last open question, the spec status
 * flips from `needs-clarification` to `ready`.
 *
 * Throws if the questionId doesn't exist on the spec.
 */
export function resolveClarification(
  spec: PlanSpec,
  questionId: string,
  answer: string,
  resolvedBy: ResolvedClarification["resolvedBy"] = "user",
): PlanSpec {
  const question = spec.clarificationQuestions.find(
    (q) => q.questionId === questionId,
  );
  if (!question) {
    throw new Error(
      `Question "${questionId}" not found on spec "${spec.specId}". ` +
        `Available: ${spec.clarificationQuestions.map((q) => q.questionId).join(", ") || "(none)"}`,
    );
  }

  // Strip any previous answer to the same question — last write wins
  const previousAnswers = spec.resolvedClarifications.filter(
    (r) => r.questionId !== questionId,
  );

  const resolved: ResolvedClarification = {
    questionId,
    answer,
    resolvedAt: new Date().toISOString(),
    resolvedBy,
  };

  const updated: PlanSpec = {
    ...spec,
    resolvedClarifications: [...previousAnswers, resolved],
    updatedAt: new Date().toISOString(),
  };

  // If all questions are now answered, advance status
  if (
    updated.status === "needs-clarification" &&
    !hasOpenClarifications(updated)
  ) {
    updated.status = "ready";
  }

  return updated;
}
