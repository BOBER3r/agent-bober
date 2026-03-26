import { z } from "zod";

// ── Enums ───────────────────────────────────────────────────────────

export const PrioritySchema = z.enum(["must", "should", "could"]);
export type Priority = z.infer<typeof PrioritySchema>;

// ── Feature Spec ────────────────────────────────────────────────────

export const FeatureSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: PrioritySchema,
  estimatedSprints: z.number().int().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
});
export type FeatureSpec = z.infer<typeof FeatureSpecSchema>;

// ── Plan Spec ───────────────────────────────────────────────────────

export const PlanSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  projectType: z.string().min(1),
  techStack: z.array(z.string()),
  features: z.array(FeatureSpecSchema),
  nonFunctional: z.array(z.string()),
  constraints: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PlanSpec = z.infer<typeof PlanSpecSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

let specCounter = 0;

/**
 * Create a new plan specification with sensible defaults.
 */
export function createSpec(
  title: string,
  description: string,
  features: Omit<FeatureSpec, "id">[],
): PlanSpec {
  specCounter++;
  const now = new Date().toISOString();
  const id = `spec-${Date.now()}-${specCounter}`;

  return {
    id,
    title,
    description,
    projectType: "generic",
    techStack: [],
    features: features.map((f, idx) => ({
      ...f,
      id: `feature-${idx + 1}`,
    })),
    nonFunctional: [],
    constraints: [],
    createdAt: now,
    updatedAt: now,
  };
}
