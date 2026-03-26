import { z } from "zod";

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
]);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

export const FileActionSchema = z.enum(["create", "modify", "delete"]);
export type FileAction = z.infer<typeof FileActionSchema>;

// ── Sub-types ───────────────────────────────────────────────────────

export const SuccessCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  verificationMethod: z.string().min(1),
  passed: z.boolean(),
  notes: z.string().optional(),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

export const FileChangeSchema = z.object({
  path: z.string().min(1),
  action: FileActionSchema,
  description: z.string().min(1),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

// ── Sprint Contract ─────────────────────────────────────────────────

export const SprintContractSchema = z.object({
  id: z.string().min(1),
  feature: z.string().min(1),
  description: z.string().min(1),
  successCriteria: z.array(SuccessCriterionSchema),
  expectedChanges: z.array(FileChangeSchema),
  dependsOn: z.array(z.string()),
  status: ContractStatusSchema,
  evalResults: z.array(z.unknown()).optional(),
  generatorNotes: z.string().optional(),
  evaluatorFeedback: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type SprintContract = z.infer<typeof SprintContractSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

let contractCounter = 0;

/**
 * Create a new sprint contract in "proposed" status.
 */
export function createContract(
  feature: string,
  description: string,
  criteria: Omit<SuccessCriterion, "passed">[],
): SprintContract {
  contractCounter++;
  const id = `sprint-${Date.now()}-${contractCounter}`;

  return {
    id,
    feature,
    description,
    successCriteria: criteria.map((c) => ({
      ...c,
      passed: false,
    })),
    expectedChanges: [],
    dependsOn: [],
    status: "proposed",
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
  const updates: Partial<SprintContract> = { status };

  if (status === "in-progress" && !contract.startedAt) {
    updates.startedAt = now;
  }

  if (
    (status === "passed" || status === "failed") &&
    !contract.completedAt
  ) {
    updates.completedAt = now;
  }

  return { ...contract, ...updates };
}
