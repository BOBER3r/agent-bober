/**
 * Unit tests for bober_rollback_start tool (Sprint 6).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerRollbackTool } from "./rollback.js";
import { getTool } from "./registry.js";
import { createIncident } from "../../incident/timeline.js";

let tmpDir: string;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = await mkdtemp(join(tmpdir(), "bober-rollback-tool-test-"));
  registerRollbackTool();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("bober_rollback_start", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_rollback_start")).toBeDefined();
  });

  it("returns correct structure with no changes (empty plan)", async () => {
    // Create an incident with no changelog entries
    const incidentId = await createIncident("zero changes incident", tmpDir);

    const tool = getTool("bober_rollback_start")!;
    const result = JSON.parse(
      await tool.handler({ incidentId, projectPath: tmpDir }),
    ) as {
      planned: { totalChanges: number; rollbackableChanges: number; steps: unknown[] };
      executed: { attempted: number; succeeded: number };
      escalated?: boolean;
      remaining?: unknown[];
    };

    expect(result).toMatchObject({
      planned: {
        totalChanges: 0,
        rollbackableChanges: 0,
        steps: [],
      },
      executed: {
        attempted: 0,
        succeeded: 0,
      },
    });
    // No escalation when empty
    expect(result.escalated).toBeUndefined();
  });

  it("returns soft error for empty incidentId", async () => {
    const tool = getTool("bober_rollback_start")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("incidentId is required");
  });

  it("returns soft error for relative projectPath", async () => {
    const tool = getTool("bober_rollback_start")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "any", projectPath: "./relative" }),
    ) as { error: string };
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns zero-step plan when incident has no changelog (graceful missing)", async () => {
    // planRollback gracefully handles missing changelog.jsonl (returns [])
    // So a non-existent incident returns an empty plan rather than an error.
    const tool = getTool("bober_rollback_start")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "inc-nonexistent", projectPath: tmpDir }),
    ) as {
      planned: { totalChanges: number; rollbackableChanges: number; steps: unknown[] };
      executed: { attempted: number; succeeded: number };
    };
    // No error — returns empty plan (graceful behavior from readChangelog)
    expect(result).toMatchObject({
      planned: { totalChanges: 0, rollbackableChanges: 0, steps: [] },
      executed: { attempted: 0, succeeded: 0 },
    });
  });
});
