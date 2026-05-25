/**
 * Incident state machine + phase routing (Sprint 24).
 *
 * Wraps Sprint 19 setIncidentStatus with a GUARDED transition table:
 * invalid transitions reject with a typed error before any disk write.
 *
 * The state machine is deterministic: given (currentPhase, agentOutput),
 * the next phase is fully determined. No human-in-loop required for
 * happy-path autopilot (subject to Tier 2 risky-action gates that fire
 * inside executeAction). This is the integration capstone — no new
 * primitives, only orchestration.
 *
 * Re-open path (resolved → investigating) is the ONLY transition that
 * requires an explicit `reason` arg. Every other transition is implicit
 * from the agent's output.
 *
 * Phase transition diagram:
 *
 *                    ┌──────────────────────────────────────────────────────┐
 *                    │                                                       │
 *                    ▼                                                       │
 *             ┌───────────────┐                                              │
 *             │ investigating │                                              │
 *             └───────┬───────┘                                              │
 *                     │                                                      │
 *        diagnoser produces                                                  │
 *        nextActions with                                                    │
 *        ≥1 risky                                                            │
 *                     │                                                      │
 *                     ▼                                                      │
 *             ┌───────────────┐                                              │
 *             │  remediating  │                                              │
 *             └───────┬───────┘                                              │
 *                     │                                                      │
 *        all proposed actions executed                                       │
 *        + postcondition passed                                               │
 *                     │                                                      │
 *                     ▼                                                      │
 *             ┌───────────────┐ ──── verifyResolution fails ─────────────────┤
 *             │   monitoring  │                                              │
 *             └───────┬───────┘                                              │
 *                     │                                                      │
 *        verifyResolution.verified=true                                      │
 *        for criteria.windowMinutes                                          │
 *                     │                                                      │
 *                     ▼                                                      │
 *             ┌───────────────┐ ──── user re-opens (reason REQUIRED) ────────┘
 *             │    resolved   │
 *             └───────────────┘   (auto-postmortem triggered by setIncidentStatus)
 *
 * At any phase: user issues `bober incident abort <id> --reason <text> [--confirm-rollback]`
 *               ──────────────────────────────────────► aborted (terminal)
 *
 * Sprint 24 — src/incident/orchestrator.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  appendTimeline,
  setIncidentStatus,
  type SetStatusOpts,
} from "./timeline.js";
import {
  IncidentMetadataSchema,
  STATUS_TRANSITIONS,
  type IncidentId,
  type IncidentMetadata,
  type IncidentPhase,
} from "./types.js";
import {
  planRollback,
  executeRollback,
  presentPlan,
  type ExecuteRollbackOpts,
  type RollbackResult,
} from "./rollback.js";
import {
  verifyResolution,
  type ResolutionCriteria,
  type VerifyResolutionDeps,
} from "./resolution-verify.js";
import type { RiskyActionConfig } from "../orchestrator/deploy/resolve.js";

// ── Public types ──────────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  constructor(
    public from: IncidentPhase,
    public to: IncidentPhase,
    public reasonRequired = false,
  ) {
    const msg = reasonRequired
      ? `Invalid transition ${from} → ${to}: this transition requires an explicit 'reason' (re-open path).`
      : `Invalid transition ${from} → ${to}. Allowed from '${from}': [${STATUS_TRANSITIONS[from].join(", ")}]`;
    super(msg);
    this.name = "InvalidTransitionError";
  }
}

export interface TransitionOpts {
  reason?: string;
  setStatus?: SetStatusOpts; // forwarded to setIncidentStatus when relevant
}

export interface DiagnosisNextAction {
  blastRadius: "safe" | "risky";
  action?: string;
  requiresApproval?: boolean;
}

export interface DiagnosisResult {
  nextActions: DiagnosisNextAction[];
  summary?: string;
}

export interface ApplyDiagnosisOpts {
  /** Override clock for tests. */
  now?: () => Date;
}

export interface ApplyDeploymentDeployedEntry {
  status: "executed" | "failed";
}

export interface ApplyDeploymentResult {
  executed: ApplyDeploymentDeployedEntry[];
}

export interface ApplyDeploymentOpts {
  /** Forwarded to verifyResolution when monitoring transition is attempted. */
  verifyDeps?: Omit<VerifyResolutionDeps, "projectRoot">;
  resolutionCriteria?: ResolutionCriteria;
  /** Skip verifyResolution call (test seam). */
  skipVerification?: boolean;
  now?: () => Date;
}

export interface AbortOpts {
  reason: string; // REQUIRED — abort without a reason is forbidden
  confirmRollback?: boolean; // if true, plans+executes rollback for executed-not-rolled-back changes
  config?: RiskyActionConfig;
  rollbackOpts?: ExecuteRollbackOpts;
  now?: () => Date;
}

export interface AbortResult {
  rollback?: RollbackResult;
  abortReportPath: string; // .bober/incidents/<id>/abort-report.md
}

// ── readIncidentMetadata: a thin wrapper for the CLI status command ────────────

export async function readIncidentMetadata(
  projectRoot: string,
  incidentId: IncidentId,
): Promise<IncidentMetadata> {
  const metaPath = join(projectRoot, ".bober", "incidents", incidentId, "incident.json");
  const raw = await readFile(metaPath, "utf-8");
  return IncidentMetadataSchema.parse(JSON.parse(raw));
}

// ── transitionPhase: the guarded gate ─────────────────────────────────────────

export async function transitionPhase(
  projectRoot: string,
  incidentId: IncidentId,
  toPhase: IncidentPhase,
  opts: TransitionOpts = {},
): Promise<void> {
  // 1. Read current phase.
  const meta = await readIncidentMetadata(projectRoot, incidentId);
  const from = meta.status;

  // 2. Guard: allowed in the transition table.
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed.includes(toPhase)) {
    throw new InvalidTransitionError(from, toPhase, false);
  }

  // 3. Re-open path: resolved → investigating requires an explicit reason.
  const isReopen = from === "resolved" && toPhase === "investigating";
  if (isReopen && (!opts.reason || opts.reason.trim() === "")) {
    throw new InvalidTransitionError(from, toPhase, true);
  }

  // 4. Persist via the Sprint 19 atomic writer.
  await setIncidentStatus(projectRoot, incidentId, toPhase, undefined, opts.setStatus);

  // 5. Audit timeline event.
  await appendTimeline(projectRoot, incidentId, {
    timestamp: new Date().toISOString(),
    eventKind: "phase_transition",
    source: "system",
    summary: isReopen
      ? `Re-opened: ${from} → ${toPhase}. Reason: ${opts.reason}`
      : `Phase transition: ${from} → ${toPhase}`,
  });
}

// ── applyDiagnosisOutcome: routes to 'remediating' or stays at 'investigating' ─

/**
 * Inspect a diagnosis output and transition the incident phase accordingly.
 *
 * If any nextAction has blastRadius='risky' → transition to 'remediating'.
 * If nextActions is empty (diagnoser found no remediation needed) → leave at
 * 'investigating'; the operator should call transitionPhase or `bober incident end`.
 * If nextActions has entries but all are safe → leave at 'investigating' (no
 * state-mutating actions are needed; diagnose further or end the incident).
 *
 * Returns { newPhase } — the phase AFTER the call. Callers can use this to
 * branch their own logic.
 */
export async function applyDiagnosisOutcome(
  projectRoot: string,
  incidentId: IncidentId,
  diagnosis: DiagnosisResult,
  _opts: ApplyDiagnosisOpts = {},
): Promise<{ newPhase: IncidentPhase }> {
  const hasRiskyActions = diagnosis.nextActions.some((a) => a.blastRadius === "risky");

  if (hasRiskyActions) {
    // Transition to remediating — some next actions require the deploy gate.
    await transitionPhase(projectRoot, incidentId, "remediating", {});
    return { newPhase: "remediating" };
  }

  // No risky actions: stay at investigating. The orchestrator does not auto-resolve
  // here because "no risky actions" ≠ "incident is resolved" — the diagnoser may
  // have produced safe investigative actions, or no actions at all. Only the
  // operator (via `bober incident end`) can mark the incident resolved.
  const meta = await readIncidentMetadata(projectRoot, incidentId);
  return { newPhase: meta.status };
}

// ── applyDeploymentOutcome: routes to 'monitoring' then resolved ──────────────

/**
 * After deployment actions complete, transition the incident phase.
 *
 * If all actions executed successfully AND verifyResolution is available:
 *   - call verifyResolution
 *   - if verified=true → transition to 'monitoring'
 *   - Returns { newPhase: 'monitoring', verified: true }
 *
 * Transitioning from monitoring → resolved is the caller's responsibility
 * (the CLI / orchestration layer drives the second transition after the
 * criteria window elapses). This function ONLY moves to monitoring.
 *
 * If verifyDeps is not provided or skipVerification=true:
 *   - Transition to monitoring unconditionally (operator is asserting success).
 *
 * If any action failed:
 *   - Stay in remediating (return { newPhase: 'remediating', verified: false }).
 */
export async function applyDeploymentOutcome(
  projectRoot: string,
  incidentId: IncidentId,
  deployResult: ApplyDeploymentResult,
  opts: ApplyDeploymentOpts = {},
): Promise<{ newPhase: IncidentPhase; verified?: boolean }> {
  const allExecuted = deployResult.executed.every((e) => e.status === "executed");

  if (!allExecuted) {
    // Some actions failed — stay in remediating.
    const meta = await readIncidentMetadata(projectRoot, incidentId);
    return { newPhase: meta.status, verified: false };
  }

  // All actions succeeded. Attempt verification if criteria are provided.
  if (opts.resolutionCriteria && opts.verifyDeps && !opts.skipVerification) {
    const verifyResult = await verifyResolution(incidentId, opts.resolutionCriteria, {
      ...opts.verifyDeps,
      projectRoot,
    });

    if (verifyResult.verified) {
      // Move to monitoring — criteria passed.
      await transitionPhase(projectRoot, incidentId, "monitoring", {});
      return { newPhase: "monitoring", verified: true };
    } else {
      // Verification failed — stay in remediating.
      const meta = await readIncidentMetadata(projectRoot, incidentId);
      return { newPhase: meta.status, verified: false };
    }
  }

  // No verification configured or skipped — move to monitoring optimistically.
  await transitionPhase(projectRoot, incidentId, "monitoring", {});
  return { newPhase: "monitoring" };
}

// ── abort: terminal escape hatch (s24-c7) ─────────────────────────────────────

/**
 * Abort an incident at any phase.
 *
 * Writes .bober/incidents/<id>/aborted.txt with reason.
 * Writes .bober/incidents/<id>/abort-report.md with reason + rollback plan.
 * Transitions the incident to status='aborted' (terminal).
 *
 * IF confirmRollback=true: plans + executes rollback for executed-not-rolled-back
 *   changes (each step goes through the deploy gate individually).
 * IF confirmRollback=false (default): does NOT execute any rollbacks.
 *
 * Silent rollback on abort is a footgun — confirmRollback=true is the explicit
 * opt-in. Without it, the operator is on the hook for manual cleanup.
 *
 * @throws Error if the incident is already aborted (abort is terminal).
 */
export async function abort(
  projectRoot: string,
  incidentId: IncidentId,
  opts: AbortOpts,
): Promise<AbortResult> {
  const now = opts.now ?? (() => new Date());
  const reason = opts.reason;

  // Read current state.
  const meta = await readIncidentMetadata(projectRoot, incidentId);
  if (meta.status === "aborted") {
    throw new Error(
      `Incident ${incidentId} is already aborted. abort is a terminal state — no further transitions are possible.`,
    );
  }

  const incidentDir = join(projectRoot, ".bober", "incidents", incidentId);
  await mkdir(incidentDir, { recursive: true });

  // Write aborted.txt marker.
  const abortedTxtPath = join(incidentDir, "aborted.txt");
  await writeFile(
    abortedTxtPath,
    `Incident ${incidentId} aborted at ${now().toISOString()}\nReason: ${reason}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );

  // Emit timeline event.
  await appendTimeline(projectRoot, incidentId, {
    timestamp: now().toISOString(),
    eventKind: "incident_aborted",
    source: "human",
    summary: `Incident aborted. Reason: ${reason}`,
  });

  // Optionally run rollback.
  let rollbackResult: RollbackResult | undefined;
  let planText = "(no rollback requested)";

  if (opts.confirmRollback) {
    const plan = await planRollback(projectRoot, incidentId);
    planText = presentPlan(plan);
    if (plan.steps.length > 0) {
      rollbackResult = await executeRollback(projectRoot, incidentId, plan, {
        config: opts.config,
        ...(opts.rollbackOpts ?? {}),
        now,
      });
    } else {
      rollbackResult = {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        remaining: [],
        escalated: false,
      };
    }
  }

  // Write abort-report.md.
  const abortReportPath = join(incidentDir, "abort-report.md");
  const rollbackSection = rollbackResult
    ? `## Rollback\n\n${planText}\n\nResult: ${rollbackResult.succeeded}/${rollbackResult.attempted} steps succeeded.${rollbackResult.escalated ? " ESCALATED — manual recovery required." : ""}\n`
    : `## Rollback\n\nNot executed (--confirm-rollback was not provided). Manual cleanup may be required.\n\n${planText}\n`;

  const report = `# Abort Report: ${incidentId}

## Incident Details

- **Incident ID:** ${incidentId}
- **Symptom:** ${meta.symptom}
- **Phase at abort:** ${meta.status}
- **Aborted at:** ${now().toISOString()}
- **Reason:** ${reason}

${rollbackSection}
---

*This is a brief abort report, not a full postmortem. For a complete root cause analysis, re-open the incident or run \`bober postmortem generate ${incidentId}\`.*
`;

  await writeFile(abortReportPath, report, { encoding: "utf-8", mode: 0o600 });

  // Transition to aborted (terminal). aborted does not require verifyResult/overrideToken.
  // setIncidentStatus does NOT gate on 'aborted' — only 'resolved' is gated.
  await setIncidentStatus(projectRoot, incidentId, "aborted");

  return {
    rollback: rollbackResult,
    abortReportPath,
  };
}
