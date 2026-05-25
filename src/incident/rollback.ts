/**
 * Rollback awareness helpers (Sprint 21).
 *
 * Reads changelog.jsonl for an incident, identifies ChangeEntries that are
 * effective-status 'executed' (not yet rolled back), and provides:
 *
 *   planRollback  — returns a RollbackPlan with steps in reverse execution order.
 *   executeRollback — runs each step via the Sprint 20 risky-action gate (per-step).
 *   presentPlan   — renders the plan to a human-readable string for CLI output.
 *
 * Escalation design note (Sprint 21):
 *   True checkpoint-based escalation is deferred to Sprint 24 (full /bober-incident
 *   flow). Escalation here consists of:
 *     1. A 'rollback_halted' timeline event with remaining step ids.
 *     2. A stderr warning via writeWarn.
 *     3. result.escalated=true + result.remaining=[...] returned to the caller.
 *   Sprint 24 can wrap this return value in a real checkpoint if needed.
 *
 * JSONL semantics: changelog.jsonl is append-only; "latest line per id wins".
 * When a change is executed, Sprint 20 writes two lines (pending, executed).
 * After rollback, Sprint 21 appends a third line (rolled-back). Effective status
 * is determined by the LAST line in file-order with a given id.
 *
 * Reverse execution order: sort by the FIRST entry's executedAt (when the action
 * originally ran), then reverse. File order guarantees write monotonicity.
 *
 * Sprint 21 — src/incident/rollback.ts
 */

import { open, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { appendChange, appendTimeline } from "./timeline.js";
import type { ChangeEntry } from "./types.js";
import { executeAction } from "../orchestrator/deploy/execute.js";
import type { ProposedAction, ExecutorSeam } from "../orchestrator/deploy/types.js";
import type { RiskyActionConfig } from "../orchestrator/deploy/resolve.js";
import type { IncidentId } from "./types.js";

// ── Public interfaces ──────────────────────────────────────────────────────────

export interface RollbackStep {
  originalChangeId: string;
  originalDescription: string;
  inverseDescription: string;
  inverseCommand?: string;
  /** ISO-8601 from the original ChangeEntry's first (pending/executed) record. */
  originalExecutedAt: string;
}

export interface RollbackPlan {
  incidentId: string;
  totalChanges: number;
  rollbackableChanges: number;
  /** Count of changes excluded because no inverse is available. */
  unrollbackableChanges: number;
  steps: RollbackStep[];
  warnings: string[];
}

export interface PlanRollbackOpts {
  /** Include only changes executed AFTER this changeId (strict-after semantics). */
  since?: string;
}

export interface ExecuteRollbackOpts {
  /** Pipeline config — forwarded to executeAction for gate resolution. */
  config?: RiskyActionConfig;
  /** Injected executor (for tests). Default = real execa-based executor. */
  executor?: ExecutorSeam;
  /** Stderr writer override (for capturing warnings in tests). Default = process.stderr.write. */
  writeWarn?: (msg: string) => void;
  /** Injectable clock (for tests). Default = () => new Date(). */
  now?: () => Date;
}

export interface RollbackExecutionEntry {
  /** ISO-8601 timestamp of when the rollback step was attempted. */
  timestamp: string;
  originalChangeId: string;
  inverseDescription: string;
  status: "rolled-back" | "rolled-back-failed";
  durationMs: number;
  errorMessage?: string;
}

export interface RollbackResult {
  attempted: number;
  succeeded: number;
  /** 0 or 1 — the sequence halts on the first failure. */
  failed: number;
  /** Non-empty when failed === 1; contains steps that were not attempted. */
  remaining: RollbackStep[];
  /** true when the rollback halted due to a failure — caller should escalate. */
  escalated: boolean;
}

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * Append a single newline-terminated JSON line to filePath.
 * Creates the directory if absent. Guarantees mode 0600.
 * Mirrors appendOneLine from timeline.ts — inlined to avoid touching Sprint 19 code.
 */
async function appendOneLine(filePath: string, record: unknown): Promise<void> {
  const dir = join(filePath, "..");
  await mkdir(dir, { recursive: true });

  const line = JSON.stringify(record) + "\n";

  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(filePath, flags, 0o600);
  try {
    await fh.chmod(0o600);
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

/**
 * Read all ChangeEntry lines from changelog.jsonl.
 * Returns all raw lines (not grouped) in file order.
 * Returns [] if the file does not exist.
 */
async function readChangelog(
  projectRoot: string,
  incidentId: IncidentId,
): Promise<ChangeEntry[]> {
  const changelogPath = join(
    projectRoot,
    ".bober",
    "incidents",
    incidentId,
    "changelog.jsonl",
  );
  try {
    const raw = await readFile(changelogPath, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChangeEntry);
  } catch {
    return [];
  }
}

/**
 * Append a RollbackExecutionEntry to rollback-execution.jsonl.
 * The file is created lazily on first write (Sprint 19 createIncident does NOT
 * pre-create it — only 5 jsonl files are initialized).
 */
async function appendRollbackExecution(
  projectRoot: string,
  incidentId: IncidentId,
  entry: RollbackExecutionEntry,
): Promise<void> {
  const filePath = join(
    projectRoot,
    ".bober",
    "incidents",
    incidentId,
    "rollback-execution.jsonl",
  );
  await appendOneLine(filePath, entry);
}

// ── planRollback ───────────────────────────────────────────────────────────────

/**
 * Build a RollbackPlan from a changelog.
 *
 * Effective-status semantics (latest-line-wins):
 *   For each unique `id`, group all entries; the LAST entry in file order
 *   determines the effective status. Only `executed` entries are rollbackable.
 *
 * Reverse execution order:
 *   Steps are sorted ascending by the FIRST entry's executedAt (the original
 *   execution time), then reversed. This means the most recent action is
 *   rolled back first.
 *
 * --since semantics (changeId-based, strict-after):
 *   Only changes whose FIRST entry's executedAt is strictly greater than the
 *   --since changeId's first entry's executedAt are included.
 *
 * @param projectRoot  Absolute path to the project root.
 * @param incidentId   Incident to plan a rollback for.
 * @param opts         Optional PlanRollbackOpts.
 * @throws Error if opts.since references a non-existent changeId.
 */
export async function planRollback(
  projectRoot: string,
  incidentId: IncidentId,
  opts: PlanRollbackOpts = {},
): Promise<RollbackPlan> {
  const entries = await readChangelog(projectRoot, incidentId);
  const warnings: string[] = [];

  // Group by id; track first entry (for original time + inverse) and last entry (for effective status).
  const byId = new Map<string, { first: ChangeEntry; last: ChangeEntry }>();
  for (const e of entries) {
    const existing = byId.get(e.id);
    if (existing) {
      existing.last = e;
    } else {
      byId.set(e.id, { first: e, last: e });
    }
  }

  let unrollbackable = 0;
  const candidates: Array<{ first: ChangeEntry; last: ChangeEntry }> = [];

  for (const group of byId.values()) {
    // Defensive: missing or empty inverse.description → warn and skip.
    // Sprint 19 schema requires inverse, but we handle malformed/legacy data.
    if (
      !group.first.inverse?.description ||
      group.first.inverse.description.trim() === ""
    ) {
      unrollbackable += 1;
      warnings.push(
        `Change "${group.first.description}" (${group.first.id}) has no recorded inverse; skipped.`,
      );
      continue;
    }

    // Effective status filter: only 'executed' entries are rollbackable.
    // 'rolled-back', 'rolled-back-failed', 'pending', 'failed' are excluded.
    if (group.last.status === "executed") {
      candidates.push(group);
    }
  }

  // --since filter (changeId-based, strict-after semantics).
  let filtered = candidates;
  if (opts.since !== undefined) {
    const pivot = byId.get(opts.since);
    if (!pivot) {
      throw new Error(`--since changeId "${opts.since}" not found in changelog`);
    }
    const pivotTime = pivot.first.executedAt;
    filtered = candidates.filter((c) => c.first.executedAt > pivotTime);
    warnings.push(
      `--since filter applied: showing ${filtered.length} of ${candidates.length} rollbackable changes.`,
    );
  }

  // Sort ascending by original executedAt, then reverse to get newest-first.
  filtered.sort((a, b) => (a.first.executedAt < b.first.executedAt ? -1 : 1));
  filtered.reverse();

  const steps: RollbackStep[] = filtered.map(({ first }) => ({
    originalChangeId: first.id,
    originalDescription: first.description,
    inverseDescription: first.inverse.description,
    ...(first.inverse.command !== undefined ? { inverseCommand: first.inverse.command } : {}),
    originalExecutedAt: first.executedAt,
  }));

  return {
    incidentId,
    totalChanges: byId.size,
    rollbackableChanges: steps.length,
    unrollbackableChanges: unrollbackable,
    steps,
    warnings,
  };
}

// ── presentPlan ────────────────────────────────────────────────────────────────

/**
 * Render a RollbackPlan to a human-readable string for CLI output.
 *
 * Always includes:
 * - Header with incident ID
 * - Change counts (total, rollbackable, unrollbackable)
 * - Numbered steps in reverse execution order
 * - Warnings section (if any)
 */
export function presentPlan(plan: RollbackPlan): string {
  const lines: string[] = [];
  lines.push(`Rollback plan for incident ${plan.incidentId}:`);
  lines.push("");
  lines.push(`Total changes: ${plan.totalChanges}`);
  lines.push(`Rollbackable: ${plan.rollbackableChanges}`);
  lines.push(
    `Unrollbackable: ${plan.unrollbackableChanges}${plan.unrollbackableChanges > 0 ? " (see warnings)" : ""}`,
  );
  lines.push("");

  if (plan.steps.length === 0) {
    lines.push("(no rollbackable steps)");
  } else {
    lines.push("Proposed steps (in reverse execution order):");
    plan.steps.forEach((s, idx) => {
      lines.push(`  ${idx + 1}. Undo "${s.originalDescription}"`);
      lines.push(`     → ${s.inverseDescription}`);
      if (s.inverseCommand) lines.push(`     $ ${s.inverseCommand}`);
    });
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ── executeRollback ────────────────────────────────────────────────────────────

/**
 * Execute a RollbackPlan step by step.
 *
 * Each step is a risky action that MUST pass through the Sprint 20 gate
 * individually. This means N rollback steps → N gate invocations.
 *
 * On success of each step:
 *   - Appends a ChangeEntry with id=originalChangeId, status='rolled-back'.
 *   - Appends a RollbackExecutionEntry with status='rolled-back'.
 *
 * On failure of any step:
 *   - Appends a ChangeEntry with id=originalChangeId, status='rolled-back-failed'.
 *   - Appends a RollbackExecutionEntry with status='rolled-back-failed'.
 *   - Halts the sequence (remaining steps are NOT attempted).
 *   - Emits a 'rollback_halted' timeline event.
 *   - Returns result.escalated=true with result.remaining=[unrolled steps].
 *
 * @param projectRoot  Absolute path to the project root.
 * @param incidentId   Incident to execute the rollback for.
 * @param plan         The plan produced by planRollback.
 * @param opts         Optional injections (config, executor, writeWarn, now).
 */
export async function executeRollback(
  projectRoot: string,
  incidentId: IncidentId,
  plan: RollbackPlan,
  opts: ExecuteRollbackOpts = {},
): Promise<RollbackResult> {
  const now = opts.now ?? (() => new Date());
  const writeWarn = opts.writeWarn ?? ((m: string) => process.stderr.write(m));

  await appendTimeline(projectRoot, incidentId, {
    timestamp: now().toISOString(),
    eventKind: "rollback_started",
    source: "deployer",
    summary: `Rollback started: ${plan.steps.length} step(s) planned`,
  });

  let succeeded = 0;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;

    // Construct the ProposedAction for this rollback step.
    // The rollback step is always classified as risky — undoing a change is itself
    // a destructive operation that requires the same gate discipline.
    const proposed: ProposedAction = {
      id: `rollback-${step.originalChangeId}`,
      description: step.inverseDescription,
      classification: "risky",
      reasoning: `Rolling back change ${step.originalChangeId}: ${step.originalDescription}`,
      ...(step.inverseCommand !== undefined ? { command: step.inverseCommand } : {}),
      inverse: {
        // The inverse-of-inverse is to re-apply the original change.
        // We don't have the original command stored in ChangeEntry — see briefing §9.
        description: `Re-apply original change: ${step.originalDescription}`,
      },
    };

    const stepStart = Date.now();
    const result = await executeAction(
      proposed,
      incidentId,
      projectRoot,
      opts.config,
      { executor: opts.executor, writeWarn, now },
    );
    const durationMs = Date.now() - stepStart;

    if (result.status === "executed") {
      // Mark the ORIGINAL ChangeEntry as rolled-back (use original id).
      await appendChange(projectRoot, incidentId, {
        id: step.originalChangeId,
        type: "rollback",
        executedAt: now().toISOString(),
        description: `Rolled back: ${step.originalDescription}`,
        inverse: { description: `Re-apply: ${step.originalDescription}` },
        status: "rolled-back",
      });
      await appendRollbackExecution(projectRoot, incidentId, {
        timestamp: now().toISOString(),
        originalChangeId: step.originalChangeId,
        inverseDescription: step.inverseDescription,
        status: "rolled-back",
        durationMs,
      });
      succeeded += 1;
    } else {
      // Failure (or aborted). Halt the sequence.
      const errMsg =
        result.error ??
        `rollback step aborted: ${result.reason ?? "unknown"}`;

      await appendChange(projectRoot, incidentId, {
        id: step.originalChangeId,
        type: "rollback-failed",
        executedAt: now().toISOString(),
        description: `Rollback FAILED for: ${step.originalDescription}`,
        inverse: { description: `Re-apply: ${step.originalDescription}` },
        status: "rolled-back-failed",
      });
      await appendRollbackExecution(projectRoot, incidentId, {
        timestamp: now().toISOString(),
        originalChangeId: step.originalChangeId,
        inverseDescription: step.inverseDescription,
        status: "rolled-back-failed",
        durationMs,
        errorMessage: errMsg,
      });

      const remaining = plan.steps.slice(i + 1);

      await appendTimeline(projectRoot, incidentId, {
        timestamp: now().toISOString(),
        eventKind: "rollback_halted",
        source: "deployer",
        summary:
          `Rollback HALTED at step ${i + 1}/${plan.steps.length}: ${errMsg}. ` +
          `Remaining: ${remaining.map((s) => s.originalChangeId).join(", ")}`,
      });

      writeWarn(
        `[bober rollback] HALTED — step ${i + 1} (${step.originalChangeId}) failed: ${errMsg}. ` +
          `${remaining.length} step(s) NOT rolled back: ${remaining.map((s) => s.originalChangeId).join(", ")}\n`,
      );

      return {
        attempted: i + 1,
        succeeded,
        failed: 1,
        remaining,
        escalated: true,
      };
    }
  }

  await appendTimeline(projectRoot, incidentId, {
    timestamp: now().toISOString(),
    eventKind: "rollback_completed",
    source: "deployer",
    summary: `Rollback completed: ${succeeded}/${plan.steps.length} step(s) succeeded`,
  });

  return {
    attempted: plan.steps.length,
    succeeded,
    failed: 0,
    remaining: [],
    escalated: false,
  };
}
