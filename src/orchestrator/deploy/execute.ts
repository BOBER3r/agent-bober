/**
 * executeAction — main entrypoint for the deploy module (Sprint 20).
 *
 * Execution sequence:
 *   0. Validate action shape (inverse required) — throws BEFORE any I/O.
 *   1. Authoritative classification via classifyCommand() — overrides agent's self-declaration.
 *   2. Log proposed action to actions.jsonl for audit.
 *   3. If risky: gate via Tier 2 checkpoint (or auto-approve with warning if allowAutopilotRiskyActions).
 *   4. Write ChangeEntry with status='pending' BEFORE execution.
 *   5. Execute via injected seam.
 *   6. Write ChangeEntry with terminal status ('executed' | 'failed') AFTER execution.
 *
 * Critical invariants:
 * - ChangeEntry is ALWAYS written (even on crash) once execution starts.
 * - inverse.description is REQUIRED and validated up-front (Zod + explicit guard).
 * - The agent's self-declared classification is a HINT; classifyCommand() is authoritative.
 * - allowAutopilotRiskyActions=true skips interactive approval but NOT the audit trail.
 */

import { appendChange, appendTimeline, appendAction } from "../../incident/timeline.js";
import type { ChangeEntry } from "../../incident/types.js";
import { ProposedActionSchema, type ProposedAction, type ExecutorSeam } from "./types.js";
import { classifyCommand } from "./classify.js";
import { getRiskyActionMechanism, resolveRiskyActionMechanismName, type RiskyActionConfig } from "./resolve.js";
import { defaultExecutor } from "./executor.js";

// ── Dependency injection bag ───────────────────────────────────────────────────

export interface ExecuteActionDeps {
  /** Override for tests. Default = execa wrapper (defaultExecutor). */
  executor?: ExecutorSeam;
  /** Override for tests to capture stderr warnings. Default = process.stderr.write. */
  writeWarn?: (msg: string) => void;
  /** Override for tests — injectable clock. Default = () => new Date(). */
  now?: () => Date;
}

// ── Result type ────────────────────────────────────────────────────────────────

export interface ExecuteActionResult {
  status: "executed" | "failed" | "aborted";
  reason?: "checkpoint_rejected" | "precondition_failed" | "missing_inverse" | "postcondition_failed";
  durationMs: number;
  error?: string;
}

// ── executeAction ──────────────────────────────────────────────────────────────

/**
 * Execute a single proposed action under the deploy discipline.
 *
 * @param action      - The proposed action (agent's self-classified).
 * @param incidentId  - Incident ID for audit trail writes.
 * @param projectRoot - Root path for incident artifact writes.
 * @param config      - Pipeline config (controls allowAutopilotRiskyActions + mechanism resolution).
 * @param deps        - Optional injection overrides (executor, writeWarn, now).
 */
export async function executeAction(
  action: ProposedAction,
  incidentId: string,
  projectRoot: string,
  config: RiskyActionConfig | undefined,
  deps: ExecuteActionDeps = {},
): Promise<ExecuteActionResult> {
  const executor = deps.executor ?? defaultExecutor;
  const writeWarn = deps.writeWarn ?? ((m: string) => process.stderr.write(m));
  const now = deps.now ?? (() => new Date());

  // ── Step 0: validate action shape BEFORE any I/O. ───────────────────────────
  // Explicit guard first — throws a clear, test-matchable error for the most
  // critical invariant (inverse required). Then Zod validates the rest.
  const rawAction = action as Partial<ProposedAction>;
  if (
    !rawAction.inverse?.description ||
    rawAction.inverse.description.trim() === ""
  ) {
    throw new Error(
      `executeAction: action.inverse is required and must be non-empty (action id: ${rawAction.id ?? "unknown"})`,
    );
  }
  // Full schema validation (validates all remaining fields).
  ProposedActionSchema.parse(action);

  // ── Step 1: authoritative classification (overrides agent's self-declared). ──
  // If the command content is risky, the action IS risky regardless of `action.classification`.
  const commandClassification = action.command ? classifyCommand(action.command) : action.classification;
  const isRisky = commandClassification === "risky" || action.classification === "risky";

  // ── Step 2: log proposed action (always, for audit trail). ─────────────────
  await appendAction(projectRoot, incidentId, {
    timestamp: now().toISOString(),
    action: action.description,
    blastRadius: isRisky ? "risky" : "safe",
    requiresApproval: isRisky,
    rationale: action.reasoning,
  });

  // ── Step 3: if risky, gate via Tier 2 checkpoint. ──────────────────────────
  if (isRisky) {
    const allow = config?.pipeline?.allowAutopilotRiskyActions === true;
    const mechanismName = resolveRiskyActionMechanismName(config, true, action.id);

    if (allow) {
      // Auto-approve with STERN warning to stderr. Audit trail STILL written below.
      writeWarn(
        `[bober deploy] WARN allowAutopilotRiskyActions=true — auto-approved risky action ${action.id}: ` +
          `${action.description}. Inverse recorded: "${action.inverse.description}". ` +
          `Mechanism would have been: ${mechanismName}.\n`,
      );
    } else {
      const mech = getRiskyActionMechanism(config, true, action.id);
      const outcome = await mech.request(`risky-action-${action.id}` as never, {
        kind: "risky-action",
        actionId: action.id,
        description: action.description,
        classification: "risky" as const,
        classificationReasoning: action.reasoning,
        command: action.command,
        inverse: action.inverse,
      });

      // Handle all three CheckpointOutcome variants.
      if ("approved" in outcome && outcome.approved === false) {
        await appendTimeline(projectRoot, incidentId, {
          timestamp: now().toISOString(),
          eventKind: "action_aborted",
          source: "deployer",
          summary: `Action ${action.id} rejected at checkpoint: ${(outcome as { approved: false; feedback: string }).feedback}`,
        });
        return { status: "aborted", reason: "checkpoint_rejected", durationMs: 0 };
      }
      if ("edit" in outcome) {
        // The operator modified the command via checkpoint edit. Log the modification.
        // Re-classification of the modified command is deferred to Sprint 24 (full /bober-incident flow).
        // For now, treat as approved and proceed with the original action.
        writeWarn(
          `[bober deploy] INFO checkpoint edit received for action ${action.id}. ` +
            `Edit delta recorded; proceeding with original command.\n`,
        );
      }
      // If neither rejected nor edited, fall through — approved=true.
    }
  }

  // ── Step 4: write ChangeEntry with status='pending' BEFORE execution. ───────
  const startedAt = now().toISOString();
  const pendingEntry: ChangeEntry = {
    id: action.id,
    type: isRisky ? "risky-action" : "safe-action",
    executedAt: startedAt,
    description: action.description,
    inverse: action.inverse,
    status: "pending",
  };
  await appendChange(projectRoot, incidentId, pendingEntry);

  // ── Step 5: execute via injected seam. ──────────────────────────────────────
  const startTime = Date.now();
  let exitCode = 0;
  let stderr = "";
  let crashed = false;

  try {
    if (action.command) {
      const r = await executor.run(action.command);
      exitCode = r.exitCode;
      stderr = r.stderr;
    }
  } catch (err: unknown) {
    crashed = true;
    stderr = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startTime;

  // ── Step 6: write ChangeEntry with terminal status AFTER execution. ──────────
  // Written even if the executor crashed — the audit trail is preserved.
  const finalStatus: ChangeEntry["status"] = crashed || exitCode !== 0 ? "failed" : "executed";
  const finalEntry: ChangeEntry = {
    id: action.id,
    type: isRisky ? "risky-action" : "safe-action",
    executedAt: now().toISOString(),
    description: action.description,
    inverse: action.inverse,
    status: finalStatus,
  };
  await appendChange(projectRoot, incidentId, finalEntry);

  if (finalStatus === "failed") {
    return { status: "failed", durationMs, error: stderr };
  }
  return { status: "executed", durationMs };
}
