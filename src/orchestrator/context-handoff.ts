import { z } from "zod";
import { PlanSpecSchema, type PlanSpec } from "../contracts/spec.js";
import {
  SprintContractSchema,
  type SprintContract,
} from "../contracts/sprint-contract.js";

// ── Enums ───────────────────────────────────────────────────────────

export const AgentRoleSchema = z.enum([
  "planner",
  "generator",
  "evaluator",
  "human",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

// ── Decision ────────────────────────────────────────────────────────

export const DecisionSchema = z.object({
  timestamp: z.string().datetime(),
  description: z.string().min(1),
  rationale: z.string().min(1),
  madeBy: AgentRoleSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

// ── Project Context ─────────────────────────────────────────────────

export const ProjectContextSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  techStack: z.array(z.string()),
  entryPoints: z.array(z.string()),
  currentBranch: z.string(),
});
export type ProjectContext = z.infer<typeof ProjectContextSchema>;

// ── Context Handoff ─────────────────────────────────────────────────

export const ContextHandoffSchema = z.object({
  timestamp: z.string().datetime(),
  from: AgentRoleSchema,
  to: AgentRoleSchema,
  projectContext: ProjectContextSchema,
  spec: PlanSpecSchema,
  currentContract: SprintContractSchema.optional(),
  sprintHistory: z.array(SprintContractSchema),
  instructions: z.string(),
  changedFiles: z.array(z.string()),
  decisions: z.array(DecisionSchema),
  issues: z.array(z.string()),
});
export type ContextHandoff = z.infer<typeof ContextHandoffSchema>;

// ── Summarized Sprint (for compaction) ──────────────────────────────

interface SprintSummary {
  id: string;
  feature: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
}

function summarizeSprint(contract: SprintContract): SprintSummary {
  return {
    id: contract.id,
    feature: contract.feature,
    status: contract.status,
    startedAt: contract.startedAt,
    completedAt: contract.completedAt,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Create a new context handoff document.
 */
export function createHandoff(params: {
  from: AgentRole;
  to: AgentRole;
  projectContext: ProjectContext;
  spec: PlanSpec;
  currentContract?: SprintContract;
  sprintHistory: SprintContract[];
  instructions: string;
  changedFiles?: string[];
  decisions?: Decision[];
  issues?: string[];
}): ContextHandoff {
  return {
    timestamp: new Date().toISOString(),
    from: params.from,
    to: params.to,
    projectContext: params.projectContext,
    spec: params.spec,
    currentContract: params.currentContract,
    sprintHistory: params.sprintHistory,
    instructions: params.instructions,
    changedFiles: params.changedFiles ?? [],
    decisions: params.decisions ?? [],
    issues: params.issues ?? [],
  };
}

/**
 * Serialize a handoff document to a JSON string.
 */
export function serializeHandoff(handoff: ContextHandoff): string {
  return JSON.stringify(handoff, null, 2);
}

/**
 * Deserialize and validate a JSON string into a ContextHandoff.
 * Throws on invalid input.
 */
export function deserializeHandoff(json: string): ContextHandoff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Failed to parse handoff JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const result = ContextHandoffSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid handoff document:\n${issues}`);
  }

  return result.data;
}

/**
 * Summarize older sprints in the handoff to keep document size manageable.
 *
 * Keeps the `keepRecent` most recent sprints in full detail,
 * and replaces older sprints with minimal summary contracts.
 *
 * Returns a new handoff with compacted sprint history.
 */
export function summarizeOlderSprints(
  handoff: ContextHandoff,
  keepRecent: number,
): ContextHandoff {
  const history = handoff.sprintHistory;

  if (history.length <= keepRecent) {
    return handoff;
  }

  const cutoff = history.length - keepRecent;
  const olderSprints = history.slice(0, cutoff);
  const recentSprints = history.slice(cutoff);

  // Build summary entries as minimal SprintContract objects
  const summarized: SprintContract[] = olderSprints.map((contract) => {
    const summary = summarizeSprint(contract);
    return {
      id: summary.id,
      feature: summary.feature,
      description: `[Summarized] ${contract.description}`,
      successCriteria: [],
      expectedChanges: [],
      dependsOn: [],
      status: contract.status,
      generatorNotes: undefined,
      evaluatorFeedback: undefined,
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
    };
  });

  return {
    ...handoff,
    sprintHistory: [...summarized, ...recentSprints],
  };
}
