/**
 * Unit tests for bober_get_project_state tool.
 *
 * Verifies composite counts for the cockpit sidebar.
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { registerGetProjectStateTool } from "./get-project-state.js";
import { getTool } from "./registry.js";
import { savePending, type PendingMarker } from "../../state/approval-state.js";
import { writeRunState } from "../../state/run-state.js";
import type { RunState } from "../run-manager.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-get-project-state-test-"));
  registerGetProjectStateTool();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

async function createConfig(projectPath: string, mode?: string): Promise<void> {
  await writeFile(
    join(projectPath, "bober.config.json"),
    JSON.stringify({ project: { name: "test-project", ...(mode ? { mode } : {}) } }),
    "utf-8",
  );
}

function makePending(overrides?: Partial<PendingMarker>): PendingMarker {
  return {
    checkpointId: "pending-cp",
    artifact: { type: "research-doc" },
    prompt: "Review this",
    requestedAt: new Date().toISOString(),
    timeoutAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunState(projectPath: string, overrides?: Partial<RunState>): RunState {
  return {
    runId: "test-run",
    task: "build",
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { completed: 0, total: 0 },
    projectRoot: projectPath,
    ...overrides,
  };
}

function makeSpecJson(specId: string): object {
  const now = "2026-05-25T10:00:00.000Z";
  return {
    specId,
    version: 1,
    title: `Spec ${specId}`,
    description: "A test spec",
    status: "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-1",
        title: "Feature 1",
        description: "Feature one",
        priority: "must-have",
        acceptanceCriteria: ["It works"],
        dependencies: [],
      },
    ],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: [],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_get_project_state", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_get_project_state")).toBeDefined();
  });

  it("returns soft-error JSON for relative projectPath", async () => {
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: "./relative" }));
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns configExists=false when no bober.config.json", async () => {
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.configExists).toBe(false);
  });

  it("returns configExists=true when bober.config.json exists", async () => {
    await createConfig(tmpDir);
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.configExists).toBe(true);
  });

  it("returns mode when set in config", async () => {
    await createConfig(tmpDir, "greenfield");
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.mode).toBe("greenfield");
  });

  it("omits mode when not set in config", async () => {
    await writeFile(
      join(tmpDir, "bober.config.json"),
      JSON.stringify({ project: { name: "no-mode" } }),
      "utf-8",
    );
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect("mode" in result).toBe(false);
  });

  it("returns activeRunCount=0 when no runs exist", async () => {
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.activeRunCount).toBe(0);
  });

  it("returns correct activeRunCount from .bober/runs/*/state.json", async () => {
    await writeRunState(tmpDir, makeRunState(tmpDir, { runId: "r1", status: "running" }));
    await writeRunState(tmpDir, makeRunState(tmpDir, { runId: "r2", status: "running" }));
    await writeRunState(tmpDir, makeRunState(tmpDir, { runId: "r3", status: "completed" }));

    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.activeRunCount).toBe(2);
  });

  it("returns lastRunAt as the most recent startedAt", async () => {
    await writeRunState(tmpDir, makeRunState(tmpDir, {
      runId: "r1", startedAt: "2026-05-25T08:00:00.000Z",
    }));
    await writeRunState(tmpDir, makeRunState(tmpDir, {
      runId: "r2", startedAt: "2026-05-25T10:00:00.000Z",
    }));

    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.lastRunAt).toBe("2026-05-25T10:00:00.000Z");
  });

  it("omits lastRunAt when no runs exist", async () => {
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect("lastRunAt" in result).toBe(false);
  });

  it("returns pendingApprovalCount=0 when no pending approvals", async () => {
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.pendingApprovalCount).toBe(0);
  });

  it("returns correct pendingApprovalCount", async () => {
    await savePending(tmpDir, makePending({ checkpointId: "pa-1" }));
    await savePending(tmpDir, makePending({ checkpointId: "pa-2" }));

    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.pendingApprovalCount).toBe(2);
  });

  it("returns specCount=0 when no specs exist", async () => {
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.specCount).toBe(0);
  });

  it("returns correct specCount", async () => {
    const specsDir = join(tmpDir, ".bober", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "s1.json"), JSON.stringify(makeSpecJson("s1")), "utf-8");
    await writeFile(join(specsDir, "s2.json"), JSON.stringify(makeSpecJson("s2")), "utf-8");

    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.specCount).toBe(2);
  });

  it("returns openIncidentCount=0 when no incidents directory exists", async () => {
    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result.openIncidentCount).toBe(0);
  });

  it("cross-tool smoke: 2 specs, 1 active run, 0 incidents, 1 pending approval", async () => {
    // Set up config
    await createConfig(tmpDir, "brownfield");

    // 2 specs
    const specsDir = join(tmpDir, ".bober", "specs");
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, "spec1.json"), JSON.stringify(makeSpecJson("spec1")), "utf-8");
    await writeFile(join(specsDir, "spec2.json"), JSON.stringify(makeSpecJson("spec2")), "utf-8");

    // 1 active run (+ 1 completed that doesn't count)
    await writeRunState(tmpDir, makeRunState(tmpDir, { runId: "active-run", status: "running" }));
    await writeRunState(tmpDir, makeRunState(tmpDir, { runId: "done-run", status: "completed" }));

    // 1 pending approval
    await savePending(tmpDir, makePending({ checkpointId: "the-approval" }));

    const tool = getTool("bober_get_project_state")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));

    expect(result.configExists).toBe(true);
    expect(result.activeRunCount).toBe(1);
    expect(result.openIncidentCount).toBe(0);
    expect(result.pendingApprovalCount).toBe(1);
    expect(result.specCount).toBe(2);
    expect(result.mode).toBe("brownfield");
  });
});
