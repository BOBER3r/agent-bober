/**
 * Unit tests for bober_list_projects tool.
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { registerListProjectsTool } from "./list-projects.js";
import { getTool } from "./registry.js";
import { writeRunState } from "../../state/run-state.js";
import type { RunState } from "../run-manager.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-list-projects-test-"));
  registerListProjectsTool();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

async function createProject(
  root: string,
  name: string,
  config?: { project?: { name?: string; mode?: string } },
): Promise<string> {
  const projectPath = join(root, name);
  await mkdir(projectPath, { recursive: true });
  await writeFile(
    join(projectPath, "bober.config.json"),
    JSON.stringify(config ?? { project: { name, mode: "brownfield" } }),
    "utf-8",
  );
  return projectPath;
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

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_list_projects", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_list_projects")).toBeDefined();
  });

  it("returns soft-error JSON for empty searchRoots", async () => {
    const tool = getTool("bober_list_projects")!;
    const result = JSON.parse(await tool.handler({ searchRoots: [] }));
    expect(result.error).toBeDefined();
  });

  it("returns [] when no projects found under the search root", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "bober-empty-root-"));
    try {
      const tool = getTool("bober_list_projects")!;
      const result = JSON.parse(await tool.handler({ searchRoots: [emptyRoot] }));
      expect(result).toEqual([]);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("returns projects that have bober.config.json", async () => {
    await createProject(tmpRoot, "my-project");
    // Also create a dir without config — should be skipped
    await mkdir(join(tmpRoot, "no-config-dir"), { recursive: true });

    const tool = getTool("bober_list_projects")!;
    const result = JSON.parse(await tool.handler({ searchRoots: [tmpRoot] }));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-project");
  });

  it("returns projectPath, name, mode, hasActiveRuns for each project", async () => {
    const projectPath = await createProject(tmpRoot, "my-bober-proj", {
      project: { name: "My Bober Project", mode: "greenfield" },
    });

    const tool = getTool("bober_list_projects")!;
    const result = JSON.parse(await tool.handler({ searchRoots: [tmpRoot] }));
    expect(result).toHaveLength(1);
    expect(result[0].projectPath).toBe(projectPath);
    expect(result[0].name).toBe("My Bober Project");
    expect(result[0].mode).toBe("greenfield");
    expect(result[0].hasActiveRuns).toBe(false);
  });

  it("uses basename as name fallback when project.name is missing in config", async () => {
    const projectPath = join(tmpRoot, "fallback-project");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "bober.config.json"),
      JSON.stringify({ pipeline: { maxIterations: 10 } }),
      "utf-8",
    );

    const tool = getTool("bober_list_projects")!;
    const result = JSON.parse(await tool.handler({ searchRoots: [tmpRoot] }));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("fallback-project");
  });

  it("reports hasActiveRuns=true when a running state exists", async () => {
    const projectPath = await createProject(tmpRoot, "active-project");
    const state = makeRunState(projectPath, { status: "running" });
    await writeRunState(projectPath, state);

    const tool = getTool("bober_list_projects")!;
    const result = JSON.parse(await tool.handler({ searchRoots: [tmpRoot] }));
    expect(result).toHaveLength(1);
    expect(result[0].hasActiveRuns).toBe(true);
  });

  it("reports hasActiveRuns=false when only completed/failed runs exist", async () => {
    const projectPath = await createProject(tmpRoot, "inactive-project");
    const state = makeRunState(projectPath, { status: "completed" });
    await writeRunState(projectPath, state);

    const tool = getTool("bober_list_projects")!;
    const result = JSON.parse(await tool.handler({ searchRoots: [tmpRoot] }));
    expect(result).toHaveLength(1);
    expect(result[0].hasActiveRuns).toBe(false);
  });

  it("returns lastRunAt when runs exist", async () => {
    const projectPath = await createProject(tmpRoot, "run-project");
    const startedAt = "2026-05-25T10:00:00.000Z";
    const state = makeRunState(projectPath, { startedAt });
    await writeRunState(projectPath, state);

    const tool = getTool("bober_list_projects")!;
    const result = JSON.parse(await tool.handler({ searchRoots: [tmpRoot] }));
    expect(result).toHaveLength(1);
    expect(result[0].lastRunAt).toBe(startedAt);
  });

  it("soft-skips an unreadable searchRoot with stderr warning (does not throw)", async () => {
    // Use a path that doesn't exist
    const nonExistentRoot = join(tmpRoot, "does-not-exist");

    // Also create a real project under a valid root
    await createProject(tmpRoot, "real-project");

    const tool = getTool("bober_list_projects")!;
    // Should not throw — just skip the bad root
    const result = JSON.parse(
      await tool.handler({ searchRoots: [nonExistentRoot, tmpRoot] }),
    );
    // The real project from tmpRoot should still be returned
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("real-project");
  });

  it("searches multiple searchRoots and aggregates results", async () => {
    const root1 = await mkdtemp(join(tmpdir(), "bober-root1-"));
    const root2 = await mkdtemp(join(tmpdir(), "bober-root2-"));
    try {
      await createProject(root1, "proj-a");
      await createProject(root2, "proj-b");

      const tool = getTool("bober_list_projects")!;
      const result = JSON.parse(await tool.handler({ searchRoots: [root1, root2] }));
      expect(result).toHaveLength(2);
      const names = result.map((r: { name: string }) => r.name).sort();
      expect(names).toEqual(["proj-a", "proj-b"]);
    } finally {
      await rm(root1, { recursive: true, force: true });
      await rm(root2, { recursive: true, force: true });
    }
  });

  it("does not search deeper than one level under each root", async () => {
    // Create a nested project (2 levels deep) — should NOT be found
    const deepPath = join(tmpRoot, "level1", "level2");
    await mkdir(deepPath, { recursive: true });
    await writeFile(
      join(deepPath, "bober.config.json"),
      JSON.stringify({ project: { name: "deep-project" } }),
      "utf-8",
    );

    // Create a 1-level project — should be found
    await createProject(tmpRoot, "shallow-project");

    const tool = getTool("bober_list_projects")!;
    const result = JSON.parse(await tool.handler({ searchRoots: [tmpRoot] }));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("shallow-project");
  });
});
