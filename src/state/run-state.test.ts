/**
 * Unit tests for src/state/run-state.ts
 *
 * All disk operations use a mkdtemp fixture so tests are isolated and
 * do not pollute the repo or /tmp with .bober/runs/ debris.
 */

import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { writeRunState, readRunState, listRunStateFiles, readRunStatesFromDisk } from "./run-state.js";
import type { RunState } from "../mcp/run-manager.js";

// ── Fixture ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-run-state-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeState(overrides?: Partial<RunState>): RunState {
  return {
    runId: "test-run-123",
    task: "build something",
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { completed: 0, total: 0 },
    projectRoot: tmpDir,
    ...overrides,
  };
}

function stateFilePath(runId: string): string {
  return join(tmpDir, ".bober", "runs", runId, "state.json");
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("writeRunState", () => {
  it("creates .bober/runs/<runId>/state.json with exact JSON payload", async () => {
    const state = makeState();
    await writeRunState(tmpDir, state);

    const raw = await readFile(stateFilePath(state.runId), "utf-8");
    const parsed = JSON.parse(raw) as RunState;
    expect(parsed.runId).toBe(state.runId);
    expect(parsed.task).toBe(state.task);
    expect(parsed.status).toBe("running");
    expect(parsed.projectRoot).toBe(tmpDir);
  });

  it("is atomic — no .tmp files remain after a successful write", async () => {
    const state = makeState();
    await writeRunState(tmpDir, state);

    const runDir = join(tmpDir, ".bober", "runs", state.runId);
    const entries = await readFile(stateFilePath(state.runId), "utf-8").then(() =>
      import("node:fs/promises").then((m) => m.readdir(runDir)),
    );
    const tmpFiles = entries.filter((f: string) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("produces valid JSON when 100 concurrent writes race on the same runId", async () => {
    const state = makeState();
    // First write to create the directory
    await writeRunState(tmpDir, state);

    const promises = Array.from({ length: 100 }, (_, i) =>
      writeRunState(tmpDir, { ...state, progress: { completed: i, total: 100 } }),
    );
    await Promise.all(promises);

    const raw = await readFile(stateFilePath(state.runId), "utf-8");
    // Must not throw — no partial/corrupt JSON
    const parsed = JSON.parse(raw) as RunState;
    expect(parsed.runId).toBe(state.runId);
    expect(typeof parsed.progress.completed).toBe("number");
  });

  it("writes file with mode 0o600", async () => {
    const state = makeState();
    await writeRunState(tmpDir, state);

    const info = await stat(stateFilePath(state.runId));
    // On POSIX: extract the permission bits (low 9 bits)
    const mode = info.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("readRunState", () => {
  it("returns null for a non-existent runId without throwing", async () => {
    const result = await readRunState(tmpDir, "non-existent-run");
    expect(result).toBeNull();
  });

  it("returns null for a corrupt JSON file without throwing", async () => {
    const runId = "corrupt-run";
    const dir = join(tmpDir, ".bober", "runs", runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), "{ not valid json {{", "utf-8");

    const result = await readRunState(tmpDir, runId);
    expect(result).toBeNull();
  });

  it("returns the RunState for a valid state.json", async () => {
    const state = makeState({ runId: "valid-run" });
    await writeRunState(tmpDir, state);

    const result = await readRunState(tmpDir, state.runId);
    expect(result).not.toBeNull();
    expect(result!.runId).toBe(state.runId);
    expect(result!.status).toBe("running");
  });
});

describe("listRunStateFiles", () => {
  it("returns [] when the runs/ directory does not exist", async () => {
    const result = await listRunStateFiles(tmpDir);
    expect(result).toEqual([]);
  });

  it("skips malformed state.json files but returns valid ones", async () => {
    const goodState = makeState({ runId: "good-run" });
    await writeRunState(tmpDir, goodState);

    // Write a malformed entry
    const badDir = join(tmpDir, ".bober", "runs", "bad-run");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "state.json"), "THIS IS NOT JSON", "utf-8");

    const result = await listRunStateFiles(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe("good-run");
  });

  it("returns all valid entries when multiple runs exist", async () => {
    const states = [
      makeState({ runId: "run-a", task: "task A" }),
      makeState({ runId: "run-b", task: "task B" }),
      makeState({ runId: "run-c", task: "task C" }),
    ];
    for (const s of states) {
      await writeRunState(tmpDir, s);
    }

    const result = await listRunStateFiles(tmpDir);
    expect(result).toHaveLength(3);
    const ids = result.map((r) => r.runId).sort();
    expect(ids).toEqual(["run-a", "run-b", "run-c"]);
  });
});

describe("readRunStatesFromDisk", () => {
  it("returns [] when the runs/ directory does not exist", async () => {
    const result = await readRunStatesFromDisk(tmpDir);
    expect(result).toEqual([]);
  });

  it("returns the same results as listRunStateFiles", async () => {
    const states = [
      makeState({ runId: "disk-run-a", task: "task A" }),
      makeState({ runId: "disk-run-b", task: "task B" }),
    ];
    for (const s of states) {
      await writeRunState(tmpDir, s);
    }

    const fromDisk = await readRunStatesFromDisk(tmpDir);
    const fromList = await listRunStateFiles(tmpDir);
    expect(fromDisk).toHaveLength(fromList.length);
    const diskIds = fromDisk.map((r) => r.runId).sort();
    const listIds = fromList.map((r) => r.runId).sort();
    expect(diskIds).toEqual(listIds);
  });

  it("does not require RunManager to be loaded — reads arbitrary projectRoot", async () => {
    // Write to tmpDir directly (not the process cwd / default project root)
    const state = makeState({ runId: "arb-root-run", projectRoot: tmpDir });
    await writeRunState(tmpDir, state);

    const result = await readRunStatesFromDisk(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe("arb-root-run");
  });
});
