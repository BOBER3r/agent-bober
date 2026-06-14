import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RosterReader } from "./roster-reader.js";
import type { RunState } from "../mcp/run-manager.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-roster-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeRunState(runId: string, status: RunState["status"]): RunState {
  return {
    runId,
    task: `Task for ${runId}`,
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    progress: {
      currentSprint: 0,
      totalSprints: 1,
      completedSprints: 0,
      failedSprints: 0,
      duration: 0,
    },
    projectRoot: tmpDir,
  };
}

describe("RosterReader", () => {
  it("returns empty array when no runs directory exists (sc-1-6)", async () => {
    const reader = new RosterReader(tmpDir);
    const states = await reader.read();
    expect(states).toEqual([]);
  });

  it("reads a running state without mutating it (sc-1-6)", async () => {
    const runId = "test-run-abc";
    const runDir = join(tmpDir, ".bober", "runs", runId);
    await mkdir(runDir, { recursive: true });

    const stateOnDisk = makeRunState(runId, "running");
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify(stateOnDisk, null, 2),
      "utf-8",
    );

    const reader = new RosterReader(tmpDir);
    const states = await reader.read();

    expect(states).toHaveLength(1);
    expect(states[0]?.status).toBe("running");
    expect(states[0]?.runId).toBe(runId);

    // Verify disk state is still "running" — RosterReader must NOT reconcile
    const { readFile } = await import("node:fs/promises");
    const onDisk = JSON.parse(
      await readFile(join(runDir, "state.json"), "utf-8"),
    ) as RunState;
    expect(onDisk.status).toBe("running");
  });

  it("summarize produces a readable string", async () => {
    const reader = new RosterReader(tmpDir);
    const states: RunState[] = [
      makeRunState("run-1", "running"),
      makeRunState("run-2", "completed"),
    ];

    const summary = reader.summarize(states);
    expect(summary).toContain("run-1");
    expect(summary).toContain("RUNNING");
    expect(summary).toContain("run-2");
    expect(summary).toContain("COMPLETED");
  });

  it("summarize returns 'No runs found.' for empty array", async () => {
    const reader = new RosterReader(tmpDir);
    const summary = reader.summarize([]);
    expect(summary).toBe("No runs found.");
  });
});
