import { z } from "zod";

// ── Constants ───────────────────────────────────────────────────────

/**
 * Minimum length for a success criterion description.
 * Short descriptions are usually vague ("works correctly", "looks good").
 * Opus 4.7 takes prompts literally — vague criteria produce vague verification.
 */
export const MIN_CRITERION_DESCRIPTION_LENGTH = 25;

/**
 * Minimum length for definitionOfDone.
 * Single-sentence summaries leak too much intent that the model has to guess.
 */
export const MIN_DEFINITION_OF_DONE_LENGTH = 20;

/**
 * Phrases that almost always indicate a vague criterion.
 * Match is case-insensitive and substring-based.
 */
export const BANNED_VAGUE_PHRASES = [
  "works correctly",
  "works as expected",
  "looks good",
  "looks nice",
  "is reasonable",
  "behaves properly",
  "behaves correctly",
  "is correct",
  "appears correct",
  "as needed",
  "if appropriate",
] as const;

// ── Enums ───────────────────────────────────────────────────────────

export const ContractStatusSchema = z.enum([
  "proposed",
  "negotiating",
  "agreed",
  "in-progress",
  "evaluating",
  "passed",
  "failed",
  "needs-rework",
  "completed",
]);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

/**
 * Strict enum of verification methods the evaluator can actually execute.
 * Free-form strings here cause the evaluator to silently skip checks.
 */
export const VerificationMethodSchema = z.enum([
  "manual",
  "typecheck",
  "lint",
  "unit-test",
  "playwright",
  "api-check",
  "build",
  "agent-evaluation",
]);
export type VerificationMethod = z.infer<typeof VerificationMethodSchema>;

export const EstimatedDurationSchema = z.enum(["small", "medium", "large"]);
export type EstimatedDuration = z.infer<typeof EstimatedDurationSchema>;

// ── Sub-types ───────────────────────────────────────────────────────

export const SuccessCriterionSchema = z.object({
  criterionId: z.string().min(1),
  description: z.string().min(MIN_CRITERION_DESCRIPTION_LENGTH),
  verificationMethod: VerificationMethodSchema,
  required: z.boolean(),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

// ── Sprint Contract ─────────────────────────────────────────────────

export const SprintContractSchema = z.object({
  // Identity
  contractId: z.string().min(1),
  specId: z.string().min(1),
  sprintNumber: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  status: ContractStatusSchema,

  // Dependencies and feature linkage
  dependsOn: z.array(z.string()).default([]),
  features: z.array(z.string()).default([]),

  // Success criteria (must include at least one)
  successCriteria: z.array(SuccessCriterionSchema).min(1),

  // ── Precision fields (added to combat Opus 4.7 literal-following) ──
  /** Things the generator MUST NOT do, even if tempting. Forces explicit scope. */
  nonGoals: z.array(z.string().min(1)).min(1),
  /** Concrete signals that the sprint is finished. "Stop when X" beats "stop when done". */
  stopConditions: z.array(z.string().min(1)).min(1),
  /** Plain-English paragraph the generator can re-read mid-task to recenter. */
  definitionOfDone: z.string().min(MIN_DEFINITION_OF_DONE_LENGTH),
  /** Assumptions the planner made (often self-answered clarifications). */
  assumptions: z.array(z.string()).default([]),
  /** Items explicitly outside this sprint's scope (deferred or never). */
  outOfScope: z.array(z.string()).default([]),
  /**
   * Self-rated ambiguity, 0 (fully specified) to 10 (very ambiguous).
   * In autonomous mode the planner should refuse to emit contracts with
   * scores >= 7 and instead surface clarification questions.
   */
  ambiguityScore: z.number().int().min(0).max(10).optional(),

  // Implementation guidance
  generatorNotes: z.string().optional(),
  evaluatorNotes: z.string().optional(),
  estimatedFiles: z.array(z.string()).default([]),
  estimatedDuration: EstimatedDurationSchema.optional(),

  // Runtime / iteration state
  evaluatorFeedback: z.string().optional(),
  iterationHistory: z.array(z.unknown()).default([]),
  lastEvalId: z.string().nullable().optional(),
  evalResults: z.array(z.unknown()).optional(),

  // Timestamps
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
});
export type SprintContract = z.infer<typeof SprintContractSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

let contractCounter = 0;

/**
 * Create a new sprint contract in "proposed" status.
 *
 * Auto-generated contracts (e.g. one-feature-per-sprint pipelines) get
 * placeholder precision fields that explicitly signal they were not authored
 * by a planner agent. The generator preflight check should treat these as
 * incomplete and request clarification before implementing.
 */
export function createContract(
  title: string,
  description: string,
  criteria: Omit<SuccessCriterion, "required">[],
  options: {
    specId?: string;
    sprintNumber?: number;
    nonGoals?: string[];
    stopConditions?: string[];
    definitionOfDone?: string;
    features?: string[];
    estimatedFiles?: string[];
    estimatedDuration?: EstimatedDuration;
  } = {},
): SprintContract {
  contractCounter++;
  const contractId = `sprint-${Date.now()}-${contractCounter}`;
  const now = new Date().toISOString();

  return {
    contractId,
    specId: options.specId ?? "spec-unknown",
    sprintNumber: options.sprintNumber ?? 1,
    title,
    description,
    status: "proposed",
    dependsOn: [],
    features: options.features ?? [],
    successCriteria: criteria.map((c) => ({
      ...c,
      required: true,
    })),
    nonGoals: options.nonGoals ?? [
      "Auto-generated contract — planner did not specify non-goals",
    ],
    stopConditions: options.stopConditions ?? [
      "All required success criteria pass evaluation",
    ],
    definitionOfDone:
      options.definitionOfDone ??
      `Sprint is done when the success criteria for "${title}" all pass evaluation and no regressions are introduced.`,
    assumptions: [],
    outOfScope: [],
    estimatedFiles: options.estimatedFiles ?? [],
    estimatedDuration: options.estimatedDuration,
    iterationHistory: [],
    lastEvalId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Return a new contract with an updated status.
 * Automatically sets `startedAt` when moving to "in-progress"
 * and `completedAt` when moving to a terminal status.
 */
export function updateContractStatus(
  contract: SprintContract,
  status: ContractStatus,
): SprintContract {
  const now = new Date().toISOString();
  const updates: Partial<SprintContract> = { status, updatedAt: now };

  if (status === "in-progress" && !contract.startedAt) {
    updates.startedAt = now;
  }

  if (
    (status === "passed" ||
      status === "failed" ||
      status === "completed") &&
    !contract.completedAt
  ) {
    updates.completedAt = now;
  }

  return { ...contract, ...updates };
}

// ── Quality gate ────────────────────────────────────────────────────

export interface ContractPrecisionIssue {
  field: string;
  message: string;
}

/**
 * Check a contract for precision issues that the Zod schema can't express:
 * banned vague phrases, etc. Returns an empty array when the contract is clean.
 *
 * Schema-level constraints (min lengths, required fields) are enforced
 * separately by SprintContractSchema.parse().
 */
export function findPrecisionIssues(
  contract: SprintContract,
): ContractPrecisionIssue[] {
  const issues: ContractPrecisionIssue[] = [];

  function checkPhrases(text: string, field: string): void {
    const lower = text.toLowerCase();
    for (const phrase of BANNED_VAGUE_PHRASES) {
      if (lower.includes(phrase)) {
        issues.push({
          field,
          message: `contains vague phrase "${phrase}" — be specific about observable behavior`,
        });
      }
    }
  }

  checkPhrases(contract.description, "description");
  checkPhrases(contract.definitionOfDone, "definitionOfDone");

  for (const c of contract.successCriteria) {
    checkPhrases(c.description, `successCriteria[${c.criterionId}].description`);
  }

  for (let i = 0; i < contract.nonGoals.length; i++) {
    checkPhrases(contract.nonGoals[i], `nonGoals[${i}]`);
  }

  for (let i = 0; i < contract.stopConditions.length; i++) {
    checkPhrases(contract.stopConditions[i], `stopConditions[${i}]`);
  }

  return issues;
}

/**
 * Check whether a contract has the precision fields populated with substance,
 * not just placeholders from createContract(). Use this in the generator
 * preflight to refuse to start work on incomplete contracts.
 */
export function isContractPrecise(contract: SprintContract): boolean {
  if (
    contract.nonGoals.length === 1 &&
    contract.nonGoals[0].startsWith("Auto-generated contract")
  ) {
    return false;
  }
  if (findPrecisionIssues(contract).length > 0) {
    return false;
  }
  if (contract.ambiguityScore !== undefined && contract.ambiguityScore >= 7) {
    return false;
  }
  return true;
}
