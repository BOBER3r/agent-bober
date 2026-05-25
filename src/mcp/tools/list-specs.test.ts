/**
 * Unit tests for bober_list_specs tool.
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { registerListSpecsTool } from "./list-specs.js";
import { getTool } from "./registry.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;
let specsDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-list-specs-test-"));
  specsDir = join(tmpDir, ".bober", "specs");
  await mkdir(specsDir, { recursive: true });
  registerListSpecsTool();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeSpecJson(overrides?: {
  specId?: string;
  title?: string;
  status?: string;
  sprints?: unknown[];
  completedAt?: string;
}): object {
  const now = "2026-05-25T10:00:00.000Z";
  return {
    specId: overrides?.specId ?? "spec-001",
    version: 1,
    title: overrides?.title ?? "Test Spec",
    description: "A test spec description",
    status: overrides?.status ?? "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-1",
        title: "Feature 1",
        description: "Feature one description",
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
    ...(overrides?.sprints !== undefined ? { sprints: overrides.sprints } : {}),
    ...(overrides?.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_list_specs", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_list_specs")).toBeDefined();
  });

  it("returns soft-error JSON for relative projectPath", async () => {
    const tool = getTool("bober_list_specs")!;
    const result = JSON.parse(await tool.handler({ projectPath: "./relative" }));
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns [] when no specs exist", async () => {
    const tool = getTool("bober_list_specs")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result).toEqual([]);
  });

  it("returns cockpit-row shape for a single spec", async () => {
    const spec = makeSpecJson({ specId: "my-spec", title: "My Spec" });
    await writeFile(join(specsDir, "my-spec.json"), JSON.stringify(spec), "utf-8");

    const tool = getTool("bober_list_specs")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result).toHaveLength(1);
    expect(result[0].specId).toBe("my-spec");
    expect(result[0].title).toBe("My Spec");
    expect(result[0].status).toBe("in-progress");
    expect(typeof result[0].sprintCount).toBe("number");
  });

  it("returns sprintCount = 0 when spec has no sprints array", async () => {
    const spec = makeSpecJson({ specId: "no-sprints" });
    await writeFile(join(specsDir, "no-sprints.json"), JSON.stringify(spec), "utf-8");

    const tool = getTool("bober_list_specs")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result[0].sprintCount).toBe(0);
  });

  it("returns correct sprintCount when spec has sprints array", async () => {
    const spec = makeSpecJson({
      specId: "with-sprints",
      sprints: [{ id: "s-1" }, { id: "s-2" }, { id: "s-3" }],
    });
    await writeFile(join(specsDir, "with-sprints.json"), JSON.stringify(spec), "utf-8");

    const tool = getTool("bober_list_specs")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result[0].sprintCount).toBe(3);
  });

  it("includes completedAt when present", async () => {
    const completedAt = "2026-05-25T12:00:00.000Z";
    const spec = makeSpecJson({
      specId: "completed-spec",
      status: "completed",
      completedAt,
    });
    await writeFile(join(specsDir, "completed-spec.json"), JSON.stringify(spec), "utf-8");

    const tool = getTool("bober_list_specs")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result[0].completedAt).toBe(completedAt);
  });

  it("skips corrupted spec files silently", async () => {
    const spec = makeSpecJson({ specId: "valid-spec" });
    await writeFile(join(specsDir, "valid-spec.json"), JSON.stringify(spec), "utf-8");
    await writeFile(join(specsDir, "corrupt-spec.json"), "INVALID JSON {{{", "utf-8");

    const tool = getTool("bober_list_specs")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result).toHaveLength(1);
    expect(result[0].specId).toBe("valid-spec");
  });

  it("returns multiple specs", async () => {
    for (const id of ["spec-a", "spec-b", "spec-c"]) {
      const spec = makeSpecJson({ specId: id, title: `Spec ${id}` });
      await writeFile(join(specsDir, `${id}.json`), JSON.stringify(spec), "utf-8");
    }

    const tool = getTool("bober_list_specs")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result).toHaveLength(3);
  });
});
