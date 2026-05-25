/**
 * Type definitions for the deploy module (Sprint 20).
 *
 * ProposedAction — the action the deployer agent proposes for execution.
 * ExecutorSeam   — the injection seam that enables unit testing without real execa.
 * DeployResult   — the summary returned to the orchestrator after a deployer session.
 */

import { z } from "zod";

// ── ProposedAction ─────────────────────────────────────────────────────────────

export const ProposedActionSchema = z.object({
  /** Unique action id within this incident session. */
  id: z.string().min(1),
  /** Human-readable description of what the action does. */
  description: z.string().min(1),
  /**
   * Agent-declared blast-radius classification. This is a HINT — the executor
   * re-classifies by command content via classifyCommand(). If the executor's
   * classification is risky the action is treated as risky regardless of this field.
   */
  classification: z.enum(["safe", "risky"]),
  /** One-sentence justification explaining why the classification was chosen. */
  reasoning: z.string().min(1),
  /** Optional shell command to execute. If absent, execution is a no-op (metadata-only record). */
  command: z.string().optional(),
  /**
   * REQUIRED inverse declaration — how to undo this action.
   * Sprint 21 rollback awareness reads this field from every ChangeEntry; it must
   * be present BEFORE execution starts (not added retroactively).
   */
  inverse: z.object({
    description: z.string().min(1),
    command: z.string().optional(),
  }),
  /** Optional shell command to verify preconditions BEFORE execution. */
  preconditionCheck: z.string().optional(),
  /** Optional shell command to verify postconditions AFTER execution. */
  postconditionCheck: z.string().optional(),
});

export type ProposedAction = z.infer<typeof ProposedActionSchema>;

// ── ExecutorSeam ───────────────────────────────────────────────────────────────

/**
 * Injection seam for command execution.
 *
 * Tests pass a fake executor that captures calls without side effects.
 * Production code uses defaultExecutor (execa wrapper in executor.ts).
 *
 * Every Bash command the deployer runs MUST go through this seam —
 * classifyCommand() runs on the command string BEFORE the seam is called.
 */
export interface ExecutorSeam {
  run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

// ── DeployResult ───────────────────────────────────────────────────────────────

export interface DeployResult {
  incidentId: string;
  executed: Array<{
    actionId: string;
    status: "executed" | "failed";
    durationMs: number;
    error?: string;
  }>;
  aborted: Array<{
    actionId: string;
    reason: "checkpoint_rejected" | "precondition_failed" | "missing_inverse" | "postcondition_failed";
  }>;
}
