// ── steer-cleanup.test.ts ─────────────────────────────────────────────
//
// Unit tests for cleanupTerminalRun (sc-6-4).
// Scenarios: completed run, aborted run, idempotent/no-markers case.
// Uses real temp dirs — NO fs mocks, NO network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTerminalRun } from "./steer-cleanup.js";
import { savePending, pendingExists } from "../state/approval-state.js";
import type { PendingMarker } from "../state/approval-state.js";
import { appendGuidance } from "../state/guidance.js";
import { setPaused, isPaused } from "../state/pause.js";
import { writeRunState, readRunState } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-cleanup-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeMarker(
  o?: Partial<{
    checkpointId: string;
    runId: string;
    prompt: string;
    requestedAt: string;
  }>,
): PendingMarker {
  const now = new Date().toISOString();
  return {
    checkpointId: "post-plan",
    artifact: { type: "research-doc" },
    prompt: "Approve this action",
    requestedAt: now,
    timeoutAt: now,
    ...o,
  };
}

async function seedRun(
  root: string,
  runId: string,
  status: RunState["status"],
): Promise<void> {
  const state: RunState = {
    runId,
    task: `Task for ${runId}`,
    status,
    startedAt: new Date().toISOString(),
    progress: { completed: 0, total: 1 },
    projectRoot: root,
    pendingCheckpointId: "post-plan",
    pendingPrompt: "Please approve",
    pendingSince: new Date().toISOString(),
    pausedAt: new Date().toISOString(),
  };
  await writeRunState(root, state);
}

// ── sc-6-4: completed run cleans up all artifacts ─────────────────────

describe("sc-6-4: cleanupTerminalRun — completed status", () => {
  it("deletes pending marker correlated to runId, clears guidance + paused, clears RunState fields", async () => {
    const runId = "run-completed-test";
    const checkpointId = "post-plan";

    // 1. Write a pending marker with runId correlation
    const marker = makeMarker({ checkpointId, runId });
    await savePending(tmpDir, marker);
    expect(await pendingExists(tmpDir, checkpointId)).toBe(true);

    // 2. Write guidance.jsonl
    await appendGuidance(tmpDir, runId, "prefer Zod");

    // 3. Write paused.json
    await setPaused(tmpDir, runId);
    expect(await isPaused(tmpDir, runId)).toBe(true);

    // 4. Seed a completed RunState with pending/paused fields
    await seedRun(tmpDir, runId, "completed");

    // Act
    await cleanupTerminalRun(tmpDir, runId);

    // Assert: pending marker gone
    expect(await pendingExists(tmpDir, checkpointId)).toBe(false);

    // Assert: paused.json gone
    expect(await isPaused(tmpDir, runId)).toBe(false);

    // Assert: guidance.jsonl gone
    const guidancePath = join(tmpDir, ".bober", "runs", runId, "guidance.jsonl");
    let guidanceExists = false;
    try {
      await access(guidancePath, constants.R_OK);
      guidanceExists = true;
    } catch {
      // expected — file should not exist
    }
    expect(guidanceExists).toBe(false);

    // Assert: RunState pending/paused fields cleared, status preserved as completed
    const state = await readRunState(tmpDir, runId);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("completed"); // terminal status preserved
    expect(state?.pendingCheckpointId).toBeUndefined();
    expect(state?.pendingPrompt).toBeUndefined();
    expect(state?.pendingSince).toBeUndefined();
    expect(state?.pausedAt).toBeUndefined();
  });
});

// ── sc-6-4: aborted run also cleans up ────────────────────────────────

describe("sc-6-4: cleanupTerminalRun — aborted status", () => {
  it("cleanup is status-agnostic: aborted run gets same cleanup, status preserved as aborted", async () => {
    const runId = "run-aborted-test";
    const checkpointId = "post-sprint";

    // 1. Write a pending marker
    const marker = makeMarker({ checkpointId, runId });
    await savePending(tmpDir, marker);

    // 2. Write guidance
    await appendGuidance(tmpDir, runId, "some guidance");

    // 3. Write paused marker
    await setPaused(tmpDir, runId);

    // 4. Seed an aborted RunState with pending/paused fields
    await seedRun(tmpDir, runId, "aborted");

    // Act
    await cleanupTerminalRun(tmpDir, runId);

    // Assert: pending marker gone
    expect(await pendingExists(tmpDir, checkpointId)).toBe(false);

    // Assert: paused.json gone
    expect(await isPaused(tmpDir, runId)).toBe(false);

    // Assert: RunState status preserved as aborted (NOT forced to running)
    const state = await readRunState(tmpDir, runId);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("aborted");
    expect(state?.pendingCheckpointId).toBeUndefined();
    expect(state?.pausedAt).toBeUndefined();
  });
});

// ── sc-6-4: idempotent / no-markers case ─────────────────────────────

describe("sc-6-4: cleanupTerminalRun — idempotent when no markers exist", () => {
  it("does not throw when run has no pending marker, no guidance, no paused.json", async () => {
    const runId = "run-no-markers";

    // Only a minimal RunState — no pending/paused artifacts
    await writeRunState(tmpDir, {
      runId,
      task: "empty",
      status: "completed",
      startedAt: new Date().toISOString(),
      progress: { completed: 1, total: 1 },
      projectRoot: tmpDir,
    });

    // Should not throw
    await expect(cleanupTerminalRun(tmpDir, runId)).resolves.toBeUndefined();

    // RunState still intact with status preserved
    const state = await readRunState(tmpDir, runId);
    expect(state?.status).toBe("completed");
  });

  it("does not throw on a completely absent run (no state file at all)", async () => {
    await expect(cleanupTerminalRun(tmpDir, "run-ghost")).resolves.toBeUndefined();
  });
});

// ── sc-6-4: does NOT clean up markers belonging to a different runId ──

describe("sc-6-4: cleanupTerminalRun — does not affect other runs' markers", () => {
  it("leaves pending marker for a different runId untouched", async () => {
    const runIdA = "run-alpha";
    const runIdB = "run-beta";
    const checkpointId = "post-research";

    // Seed a pending marker for runIdB
    const marker = makeMarker({ checkpointId, runId: runIdB });
    await savePending(tmpDir, marker);

    // Seed runIdA as completed
    await writeRunState(tmpDir, {
      runId: runIdA,
      task: "alpha",
      status: "completed",
      startedAt: new Date().toISOString(),
      progress: { completed: 1, total: 1 },
      projectRoot: tmpDir,
    });

    // Cleanup runIdA — should NOT touch runIdB's marker
    await cleanupTerminalRun(tmpDir, runIdA);

    // runIdB's marker still present
    expect(await pendingExists(tmpDir, checkpointId)).toBe(true);
  });
});

// ── sc-6-4: unsafe runId is silently skipped (path-traversal guard) ───

describe("sc-6-4: cleanupTerminalRun — unsafe runId skipped silently", () => {
  it("returns without throwing for a path-traversal runId", async () => {
    await expect(cleanupTerminalRun(tmpDir, "../evil")).resolves.toBeUndefined();
    await expect(cleanupTerminalRun(tmpDir, "../../etc/passwd")).resolves.toBeUndefined();
    await expect(cleanupTerminalRun(tmpDir, "")).resolves.toBeUndefined();
  });
});

// ── sc-6-4: run dir may not exist yet (ENOENT from guidance/paused unlink) ─

describe("sc-6-4: cleanupTerminalRun — tolerates missing run directory (ENOENT)", () => {
  it("unlink of guidance.jsonl and paused.json does not throw when run dir missing", async () => {
    const runId = "run-no-dir";
    // Ensure .bober/runs/ exists but run dir itself does NOT
    await mkdir(join(tmpDir, ".bober", "runs"), { recursive: true });

    await expect(cleanupTerminalRun(tmpDir, runId)).resolves.toBeUndefined();
  });
});
