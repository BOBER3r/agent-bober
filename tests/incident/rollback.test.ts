/**
 * Tests for src/incident/rollback.ts (Sprint 21).
 *
 * Covers:
 *   - planRollback: reverse order, status filtering, no-inverse warning, --since.
 *   - executeRollback: happy-path gate counts, halt-on-failure, rollback-execution.jsonl.
 *   - presentPlan: rendered string structure.
 *   - dry-run: zero side effects from planRollback + presentPlan.
 *
 * Pattern mirrors tests/incident/timeline.test.ts and tests/orchestrator/deployer.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIncident, appendChange } from "../../src/incident/timeline.js";
import {
  planRollback,
  executeRollback,
  presentPlan,
} from "../../src/incident/rollback.js";
import type { RollbackStep, RollbackPlan, RollbackExecutionEntry } from "../../src/incident/rollback.js";
import type { ChangeEntry } from "../../src/incident/types.js";
import type { ExecutorSeam } from "../../src/orchestrator/deploy/types.js";

// ── Temp directory fixture ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-rollback-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

/** Write a raw JSON line directly to changelog.jsonl (bypasses zod schema). */
async function writeRawChangelogLine(
  projectRoot: string,
  incidentId: string,
  record: unknown,
): Promise<void> {
  const filePath = join(projectRoot, ".bober", "incidents", incidentId, "changelog.jsonl");
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

function makeChange(
  overrides: Partial<ChangeEntry> & { id: string; executedAt: string },
): ChangeEntry {
  return {
    type: "risky-action",
    description: `Change for ${overrides.id}`,
    inverse: {
      description: `Undo ${overrides.id}`,
      command: `undo-cmd-${overrides.id}`,
    },
    status: "executed",
    ...overrides,
  };
}

/** Make a simple 3-step RollbackPlan (without filesystem). */
function make3StepPlan(incidentId: string): RollbackPlan {
  const steps: RollbackStep[] = [
    {
      originalChangeId: "c3",
      originalDescription: "Change for c3",
      inverseDescription: "Undo c3",
      inverseCommand: "undo-cmd-c3",
      originalExecutedAt: "2026-05-25T03:00:00.000Z",
    },
    {
      originalChangeId: "c2",
      originalDescription: "Change for c2",
      inverseDescription: "Undo c2",
      inverseCommand: "undo-cmd-c2",
      originalExecutedAt: "2026-05-25T02:00:00.000Z",
    },
    {
      originalChangeId: "c1",
      originalDescription: "Change for c1",
      inverseDescription: "Undo c1",
      inverseCommand: "undo-cmd-c1",
      originalExecutedAt: "2026-05-25T01:00:00.000Z",
    },
  ];
  return {
    incidentId,
    totalChanges: 3,
    rollbackableChanges: 3,
    unrollbackableChanges: 0,
    steps,
    warnings: [],
  };
}

// ── planRollback ───────────────────────────────────────────────────────────────

describe("planRollback — reverse execution order", () => {
  it("3 executed entries → 3-step plan in reverse order (newest first)", async () => {
    const incidentId = await createIncident("reverse order test", tmpDir);

    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c3", executedAt: "2026-05-25T03:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId);

    expect(plan.steps.map((s) => s.originalChangeId)).toEqual(["c3", "c2", "c1"]);
    expect(plan.rollbackableChanges).toBe(3);
    expect(plan.totalChanges).toBe(3);
    expect(plan.warnings).toHaveLength(0);
  });

  it("single executed entry → 1-step plan", async () => {
    const incidentId = await createIncident("single change test", tmpDir);
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.originalChangeId).toBe("c1");
  });

  it("empty changelog → 0-step plan", async () => {
    const incidentId = await createIncident("empty changelog test", tmpDir);
    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps).toHaveLength(0);
    expect(plan.rollbackableChanges).toBe(0);
    expect(plan.totalChanges).toBe(0);
  });
});

describe("planRollback — effective status filtering", () => {
  it("excludes entries with effective-status 'rolled-back'", async () => {
    const incidentId = await createIncident("rolled-back filter test", tmpDir);

    // c1: executed then rolled-back → should be excluded.
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, {
      id: "c1",
      type: "rollback",
      executedAt: "2026-05-25T02:00:00.000Z",
      description: "Rolled back: Change for c1",
      inverse: { description: "Re-apply: Change for c1" },
      status: "rolled-back",
    });

    // c2: just executed → should be included.
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T03:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps.map((s) => s.originalChangeId)).toEqual(["c2"]);
    expect(plan.rollbackableChanges).toBe(1);
  });

  it("excludes entries with effective-status 'rolled-back-failed'", async () => {
    const incidentId = await createIncident("rolled-back-failed filter test", tmpDir);

    // c1: executed, then rollback attempted and failed → should be excluded from plan.
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, {
      id: "c1",
      type: "rollback-failed",
      executedAt: "2026-05-25T02:00:00.000Z",
      description: "Rollback FAILED for: Change for c1",
      inverse: { description: "Re-apply: Change for c1" },
      status: "rolled-back-failed",
    });

    // c2: just executed → should be included.
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T03:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps.map((s) => s.originalChangeId)).toEqual(["c2"]);
  });

  it("excludes entries with effective-status 'failed'", async () => {
    const incidentId = await createIncident("failed status filter test", tmpDir);

    // c1: attempted but failed (Sprint 20 executor returned non-zero).
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z", status: "failed" }));

    // c2: executed successfully.
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps.map((s) => s.originalChangeId)).toEqual(["c2"]);
  });

  it("pending+executed two-line sequence → effective-status 'executed' → included", async () => {
    const incidentId = await createIncident("pending-then-executed test", tmpDir);

    // Sprint 20 writes pending then executed (two lines, same id).
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z", status: "pending" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:01.000Z", status: "executed" }));

    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.originalChangeId).toBe("c1");
  });
});

describe("planRollback — no-inverse entries", () => {
  it("no-inverse entry is excluded from steps and surfaced in warnings", async () => {
    const incidentId = await createIncident("no-inverse test", tmpDir);

    // Write a raw line bypassing the schema — missing inverse.description.
    await writeRawChangelogLine(tmpDir, incidentId, {
      id: "c-bad",
      type: "risky-action",
      executedAt: "2026-05-25T01:00:00.000Z",
      description: "An action with no inverse",
      inverse: { description: "" },  // empty description
      status: "executed",
    });

    // A valid change alongside it.
    await appendChange(tmpDir, incidentId, makeChange({ id: "c-good", executedAt: "2026-05-25T02:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId);

    // Only the good change is in steps.
    expect(plan.steps.map((s) => s.originalChangeId)).toEqual(["c-good"]);
    expect(plan.unrollbackableChanges).toBe(1);
    // Warning must mention the id and the issue.
    expect(plan.warnings.some((w) => w.includes("c-bad") && w.includes("no recorded inverse"))).toBe(true);
  });

  it("entry with completely missing inverse object is excluded with warning", async () => {
    const incidentId = await createIncident("missing-inverse-object test", tmpDir);

    // Write a raw line with no inverse field at all.
    await writeRawChangelogLine(tmpDir, incidentId, {
      id: "c-no-inv",
      type: "risky-action",
      executedAt: "2026-05-25T01:00:00.000Z",
      description: "Action with no inverse object",
      status: "executed",
    });

    const plan = await planRollback(tmpDir, incidentId);

    expect(plan.steps).toHaveLength(0);
    expect(plan.unrollbackableChanges).toBe(1);
    expect(plan.warnings.some((w) => w.includes("c-no-inv"))).toBe(true);
  });
});

describe("planRollback — --since filter", () => {
  it("--since c2 includes only changes executed after c2", async () => {
    const incidentId = await createIncident("since-filter test", tmpDir);

    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c3", executedAt: "2026-05-25T03:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c4", executedAt: "2026-05-25T04:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId, { since: "c2" });

    // Only c3 and c4 (executed AFTER c2's time) are included.
    expect(plan.steps.map((s) => s.originalChangeId)).toEqual(["c4", "c3"]);
    expect(plan.rollbackableChanges).toBe(2);
    // Warning mentions the filter.
    expect(plan.warnings.some((w) => w.includes("--since filter applied"))).toBe(true);
  });

  it("--since non-existent changeId throws a clear error", async () => {
    const incidentId = await createIncident("since-unknown-id test", tmpDir);
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));

    await expect(
      planRollback(tmpDir, incidentId, { since: "does-not-exist" }),
    ).rejects.toThrow(/--since changeId "does-not-exist" not found in changelog/);
  });

  it("--since the last changeId → empty steps (nothing executed after it)", async () => {
    const incidentId = await createIncident("since-last-id test", tmpDir);

    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId, { since: "c2" });
    expect(plan.steps).toHaveLength(0);
  });
});

// ── presentPlan ────────────────────────────────────────────────────────────────

describe("presentPlan — rendered string", () => {
  it("renders incident id, counts, and steps", async () => {
    const incidentId = await createIncident("present plan test", tmpDir);
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId);
    const text = presentPlan(plan);

    expect(text).toContain(`Rollback plan for incident ${incidentId}`);
    expect(text).toContain("Total changes: 2");
    expect(text).toContain("Rollbackable: 2");
    expect(text).toContain("Unrollbackable: 0");
    expect(text).toContain("Proposed steps (in reverse execution order):");
    expect(text).toContain('Undo "Change for c2"');
    expect(text).toContain("Undo c2");
  });

  it("renders warnings section when unrollbackable changes exist", async () => {
    const incidentId = await createIncident("present-warnings test", tmpDir);

    await writeRawChangelogLine(tmpDir, incidentId, {
      id: "c-bad",
      type: "risky-action",
      executedAt: "2026-05-25T01:00:00.000Z",
      description: "Bad action",
      inverse: { description: "" },
      status: "executed",
    });

    const plan = await planRollback(tmpDir, incidentId);
    const text = presentPlan(plan);

    expect(text).toContain("Warnings:");
    expect(text).toContain("c-bad");
    expect(text).toContain("(no rollbackable steps)");
  });

  it("renders '(no rollbackable steps)' when plan is empty", () => {
    const plan: RollbackPlan = {
      incidentId: "inc-test",
      totalChanges: 0,
      rollbackableChanges: 0,
      unrollbackableChanges: 0,
      steps: [],
      warnings: [],
    };
    const text = presentPlan(plan);
    expect(text).toContain("(no rollbackable steps)");
  });
});

// ── dry-run: zero side effects ─────────────────────────────────────────────────

describe("dry-run — zero side effects", () => {
  it("planRollback + presentPlan produce no ChangeEntry writes to changelog.jsonl", async () => {
    const incidentId = await createIncident("dry-run test", tmpDir);
    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");

    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));

    const beforeLines = (await readJsonl<ChangeEntry>(changelogPath)).length;

    const plan = await planRollback(tmpDir, incidentId);
    const text = presentPlan(plan);

    // Both calls should produce no writes.
    const afterLines = (await readJsonl<ChangeEntry>(changelogPath)).length;
    expect(afterLines).toBe(beforeLines);
    expect(text).toContain("Rollback plan for incident");
  });

  it("planRollback does not write rollback-execution.jsonl", async () => {
    const incidentId = await createIncident("dry-run no-exec-log test", tmpDir);
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));

    await planRollback(tmpDir, incidentId);

    const execLogPath = join(tmpDir, ".bober", "incidents", incidentId, "rollback-execution.jsonl");
    const entries = await readJsonl<RollbackExecutionEntry>(execLogPath);
    expect(entries).toHaveLength(0);
  });
});

// ── executeRollback: happy path ────────────────────────────────────────────────

describe("executeRollback — happy path (3-step)", () => {
  it("3-step plan → 3 executor calls + 3 'rolled-back' ChangeEntries appended", async () => {
    const incidentId = await createIncident("3-step rollback test", tmpDir);

    // Seed changelog via appendChange (creates pending+executed lines via executeAction pattern).
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c3", executedAt: "2026-05-25T03:00:00.000Z" }));

    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");

    let executorCalls = 0;
    const executor: ExecutorSeam = {
      async run() {
        executorCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const warnings: string[] = [];
    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps).toHaveLength(3);

    const result = await executeRollback(tmpDir, incidentId, plan, {
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      executor,
      writeWarn: (m) => warnings.push(m),
    });

    // All 3 steps attempted via executor.
    expect(executorCalls).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.remaining).toHaveLength(0);
    expect(result.escalated).toBe(false);

    // 3 'auto-approved risky action' warnings from allowAutopilotRiskyActions path.
    expect(
      warnings.filter((w) => w.includes("auto-approved risky action")).length,
    ).toBe(3);

    // 3 'rolled-back' ChangeEntries appended to changelog.
    const changelogLines = await readJsonl<ChangeEntry>(changelogPath);
    expect(changelogLines.filter((e) => e.status === "rolled-back").length).toBe(3);
    // Each rolled-back entry uses the ORIGINAL changeId.
    expect(changelogLines.find((e) => e.id === "c1" && e.status === "rolled-back")).toBeTruthy();
    expect(changelogLines.find((e) => e.id === "c2" && e.status === "rolled-back")).toBeTruthy();
    expect(changelogLines.find((e) => e.id === "c3" && e.status === "rolled-back")).toBeTruthy();
  });

  it("rollback-execution.jsonl has correct shape for each step", async () => {
    const incidentId = await createIncident("exec-log shape test", tmpDir);

    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));

    const executor: ExecutorSeam = {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const plan = await planRollback(tmpDir, incidentId);
    await executeRollback(tmpDir, incidentId, plan, {
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      executor,
    });

    const execLogPath = join(tmpDir, ".bober", "incidents", incidentId, "rollback-execution.jsonl");
    const entries = await readJsonl<RollbackExecutionEntry>(execLogPath);

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(typeof entry.timestamp).toBe("string");
      expect(typeof entry.originalChangeId).toBe("string");
      expect(typeof entry.inverseDescription).toBe("string");
      expect(entry.status).toBe("rolled-back");
      expect(typeof entry.durationMs).toBe("number");
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── executeRollback: halt on failure ──────────────────────────────────────────

describe("executeRollback — halt on failure (s21-c5)", () => {
  it("5-step plan, step 3 fails → callCount=3, remaining=[step4,step5], escalated=true", async () => {
    const incidentId = await createIncident("halt-on-failure test", tmpDir);

    // Append 5 changes in order.
    for (let i = 1; i <= 5; i++) {
      await appendChange(
        tmpDir,
        incidentId,
        makeChange({ id: `step-${i}`, executedAt: `2026-05-25T0${i}:00:00.000Z` }),
      );
    }

    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");

    let callCount = 0;
    const executor: ExecutorSeam = {
      async run() {
        callCount += 1;
        if (callCount === 3) return { exitCode: 1, stdout: "", stderr: "simulated failure at step 3" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const warnings: string[] = [];
    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps).toHaveLength(5);
    // Plan should be in reverse order: step-5 first.
    expect(plan.steps[0]!.originalChangeId).toBe("step-5");

    const result = await executeRollback(tmpDir, incidentId, plan, {
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      executor,
      writeWarn: (m) => warnings.push(m),
    });

    // Executor was called exactly 3 times (steps 4 and 5 were never attempted).
    expect(callCount).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.remaining).toHaveLength(2);
    expect(result.escalated).toBe(true);
    expect(result.succeeded).toBe(2);
    expect(result.attempted).toBe(3);

    // The remaining steps are the 4th and 5th in plan order (step-2 and step-1 in original order).
    expect(result.remaining[0]!.originalChangeId).toBe(plan.steps[3]!.originalChangeId);
    expect(result.remaining[1]!.originalChangeId).toBe(plan.steps[4]!.originalChangeId);

    // Effective statuses in changelog:
    // plan.steps[0] (step-5): rolled-back (first success)
    // plan.steps[1] (step-4): rolled-back (second success)
    // plan.steps[2] (step-3): rolled-back-failed (third — the failure)
    // plan.steps[3] and [4]: still 'executed' (never attempted)
    const changelogLines = await readJsonl<ChangeEntry>(changelogPath);

    function effectiveStatus(id: string): string | undefined {
      const all = changelogLines.filter((e) => e.id === id);
      return all.length > 0 ? all[all.length - 1]!.status : undefined;
    }

    const failedStep = plan.steps[2]!.originalChangeId;
    const remaining0 = plan.steps[3]!.originalChangeId;
    const remaining1 = plan.steps[4]!.originalChangeId;

    expect(effectiveStatus(failedStep)).toBe("rolled-back-failed");
    expect(effectiveStatus(remaining0)).toBe("executed");
    expect(effectiveStatus(remaining1)).toBe("executed");

    // HALT warning emitted to stderr.
    expect(warnings.some((w) => w.includes("HALTED"))).toBe(true);
  });

  it("step 1 fails immediately → callCount=1, remaining has 4 steps", async () => {
    const incidentId = await createIncident("immediate-fail test", tmpDir);

    for (let i = 1; i <= 5; i++) {
      await appendChange(
        tmpDir,
        incidentId,
        makeChange({ id: `act-${i}`, executedAt: `2026-05-25T0${i}:00:00.000Z` }),
      );
    }

    let callCount = 0;
    const executor: ExecutorSeam = {
      async run() {
        callCount += 1;
        return { exitCode: 1, stdout: "", stderr: "always fails" };
      },
    };

    const plan = await planRollback(tmpDir, incidentId);
    const result = await executeRollback(tmpDir, incidentId, plan, {
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      executor,
    });

    expect(callCount).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.remaining).toHaveLength(4);
    expect(result.escalated).toBe(true);
  });

  it("rollback-execution.jsonl has 'rolled-back-failed' entry on failure", async () => {
    const incidentId = await createIncident("exec-log-fail test", tmpDir);

    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00.000Z" }));

    const executor: ExecutorSeam = {
      async run(_cmd) {
        return { exitCode: 1, stdout: "", stderr: "rollback executor error" };
      },
    };

    const plan = await planRollback(tmpDir, incidentId);
    // step order: c2 first (most recent), then c1.
    const result = await executeRollback(tmpDir, incidentId, plan, {
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      executor,
    });

    expect(result.failed).toBe(1);

    const execLogPath = join(tmpDir, ".bober", "incidents", incidentId, "rollback-execution.jsonl");
    const entries = await readJsonl<RollbackExecutionEntry>(execLogPath);

    // First step (c2) failed — should be in execution log.
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const failedEntry = entries.find((e) => e.status === "rolled-back-failed");
    expect(failedEntry).toBeTruthy();
    expect(typeof failedEntry?.errorMessage).toBe("string");
  });
});

// ── per-step gating: gate count equals step count ─────────────────────────────

describe("executeRollback — per-step gating (s21-c2)", () => {
  it("N steps → N executor calls (gate invoked per step, not plan-level)", async () => {
    const incidentId = await createIncident("per-step gate test", tmpDir);

    for (let i = 1; i <= 4; i++) {
      await appendChange(
        tmpDir,
        incidentId,
        makeChange({ id: `gate-${i}`, executedAt: `2026-05-25T0${i}:00:00.000Z` }),
      );
    }

    let executorCalls = 0;
    const executor: ExecutorSeam = {
      async run() {
        executorCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps).toHaveLength(4);

    await executeRollback(tmpDir, incidentId, plan, {
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      executor,
    });

    // Exactly 4 executor calls — 1 per step, NOT 1 for the whole plan.
    expect(executorCalls).toBe(4);
  });

  it("each step writes its own ChangeEntry pair (pending + executed/failed) via executeAction", async () => {
    const incidentId = await createIncident("per-step change-entry test", tmpDir);

    await appendChange(tmpDir, incidentId, makeChange({ id: "x1", executedAt: "2026-05-25T01:00:00.000Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "x2", executedAt: "2026-05-25T02:00:00.000Z" }));

    const executor: ExecutorSeam = {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");
    const beforeLines = (await readJsonl<ChangeEntry>(changelogPath)).length;

    const plan = await planRollback(tmpDir, incidentId);
    await executeRollback(tmpDir, incidentId, plan, {
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      executor,
    });

    // Each of the 2 steps: executeAction writes pending+executed (2 lines) for rollback-<id>,
    // then executeRollback appends rolled-back for the original id (1 line).
    // Total new lines per step: 3.
    const afterLines = (await readJsonl<ChangeEntry>(changelogPath)).length;
    expect(afterLines).toBe(beforeLines + 2 * 3);
  });
});

// ── planRollback: completeness checks ─────────────────────────────────────────

describe("planRollback — plan completeness", () => {
  it("preserves inverseCommand when present", async () => {
    const incidentId = await createIncident("inverse-command test", tmpDir);

    await appendChange(tmpDir, incidentId, {
      id: "c1",
      type: "k8s_scale",
      executedAt: "2026-05-25T01:00:00.000Z",
      description: "scale to 6",
      inverse: { description: "scale back to 3", command: "kubectl scale --replicas=3" },
      status: "executed",
    });

    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps[0]!.inverseCommand).toBe("kubectl scale --replicas=3");
  });

  it("inverseCommand is absent when inverse has no command", async () => {
    const incidentId = await createIncident("no-inverse-command test", tmpDir);

    await appendChange(tmpDir, incidentId, {
      id: "c1",
      type: "flag_toggle",
      executedAt: "2026-05-25T01:00:00.000Z",
      description: "Enable feature flag",
      inverse: { description: "Disable feature flag" },  // no command
      status: "executed",
    });

    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps[0]!.inverseCommand).toBeUndefined();
  });

  it("uses original description and inverse description from first entry", async () => {
    const incidentId = await createIncident("description-source test", tmpDir);

    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00.000Z" }));

    const plan = await planRollback(tmpDir, incidentId);
    const step = plan.steps[0]!;
    expect(step.originalDescription).toBe("Change for c1");
    expect(step.inverseDescription).toBe("Undo c1");
    expect(step.originalExecutedAt).toBe("2026-05-25T01:00:00.000Z");
  });
});
